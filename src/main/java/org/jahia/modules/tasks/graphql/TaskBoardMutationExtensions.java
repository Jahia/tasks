package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.services.content.JCRCallback;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.content.JCRTemplate;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.workflow.WorkflowService;
import org.jahia.services.workflow.WorkflowTask;
import org.jahia.utils.i18n.JahiaLocaleContextHolder;

import javax.jcr.RepositoryException;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Root task-board mutations -- the state-transition actions behind the task board's
 * 3-dot menu (assign / unassign / suspend / resume / complete). Every mutation
 * re-checks RBAC server-side (the menu hiding an action client-side is a UX nicety,
 * not a guard) and writes through plain JCR property changes + a single
 * {@code session.save()}, which is also what the legacy JSPs did: the Drools rules in
 * rules.drl ("A workflow task has been assigned" / "...completed") key off exactly
 * these property changes to propagate to the real underlying WorkflowService for
 * jnt:workflowTask nodes. A mutation must not bypass this path (e.g. by calling
 * WorkflowService directly), or that propagation is skipped and the task node and the
 * real workflow it represents fall out of sync.
 *
 * <p>The writes themselves run with system privileges under the caller's identity
 * ({@link #writeTask}): a jnt:workflowTask node lives under the workflow initiator's own
 * user space (/users/&lt;initiator&gt;/workflowTasks/...), where an eligible group
 * candidate or reviewer holds no JCR write ACL at all -- the only write grant the rules
 * add is "rw" for the assignee, AFTER assignment. Without elevation, every eligibility
 * check in this class can pass and the claim still dies on
 * "assigneeUserKey: not allowed to add or modify item" (observed live, 2026-08-16). The
 * explicit RBAC gates below are therefore the real and only authorization boundary for
 * these writes; the caller's identity is preserved so the Drools-to-WorkflowService
 * propagation still attributes engine calls to the actual caller.
 */
@GraphQLTypeExtension(DXGraphQLProvider.Mutation.class)
public final class TaskBoardMutationExtensions {

    private TaskBoardMutationExtensions() {
    }

    // Every state value jnt:task/jnt:workflowTask's own choicelist declares (plus "cancelled",
    // see ALLOWED_STATES below), each used at multiple sites in this class.
    private static final String PROPERTY_STATE = "state";
    private static final String STATE_ACTIVE = "active";
    private static final String STATE_STARTED = "started";
    private static final String STATE_SUSPENDED = "suspended";
    private static final String STATE_FINISHED = "finished";
    private static final String STATE_CANCELLED = "cancelled";

    @GraphQLField
    @GraphQLDescription("Assign an active, not-yet-assigned-to-you task to yourself")
    public static GqlTaskBoard assignTaskToMe(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);

        if (!STATE_ACTIVE.equals(task.getPropertyAsString(PROPERTY_STATE))) {
            throw new TaskGraphQLException("Only an active task can be assigned");
        }
        requireEligibleToClaim(task, user, session);

        // Deliberately stays "active" here rather than flipping to "started": the UI has three
        // distinct phases (Unassigned -> Assigned -> Active/In-Progress), and "started" is what
        // marks the third one. An assigned-but-not-yet-started task is still "active", just with
        // an owner now; updateTaskState(id, "started") (the client's own "Start" action) is what
        // actually advances it, mirroring how unassignTask reverts a task to owner-less "active"
        // rather than some other state.
        applyClaim(user, id);
        return refreshed(session, id);
    }

    @GraphQLField
    @GraphQLDescription("Unassign a task (\"Unassign / Refuse\"), returning it to the active, unassigned pool")
    public static GqlTaskBoard unassignTask(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        writeTask(user, id, t -> {
            t.setProperty("assigneeUserKey", "");
            t.setProperty(PROPERTY_STATE, STATE_ACTIVE);
        });
        return refreshed(session, id);
    }

    @GraphQLField
    @GraphQLDescription("Suspend a task you are actively working on")
    public static GqlTaskBoard suspendTask(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        if (!STATE_STARTED.equals(task.getPropertyAsString(PROPERTY_STATE))) {
            throw new TaskGraphQLException("Only a started task can be suspended");
        }
        writeTask(user, id, t -> t.setProperty(PROPERTY_STATE, STATE_SUSPENDED));
        return refreshed(session, id);
    }

    @GraphQLField
    @GraphQLDescription("Resume a suspended task")
    public static GqlTaskBoard resumeTask(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        if (!STATE_SUSPENDED.equals(task.getPropertyAsString(PROPERTY_STATE))) {
            throw new TaskGraphQLException("Only a suspended task can be resumed");
        }
        writeTask(user, id, t -> t.setProperty(PROPERTY_STATE, STATE_STARTED));
        return refreshed(session, id);
    }

    @GraphQLField
    @GraphQLDescription("Complete a task with one of its declared outcomes (e.g. \"Publish\" / \"Reject publication\" for a workflow task's declared possibleOutcomes)")
    public static GqlTaskBoard completeTask(
            @GraphQLName("id") @GraphQLNonNull String id,
            @GraphQLName("outcome") @GraphQLNonNull String outcome) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        if (!STATE_STARTED.equals(task.getPropertyAsString(PROPERTY_STATE))) {
            throw new TaskGraphQLException("Only a started task can be completed");
        }
        requireDeclaredOutcome(task, outcome);

        applyCompletion(user, id, outcome);
        return refreshed(session, id);
    }

    /**
     * The board's one-click review fast path (#67): claim + complete a publication-review task in a
     * single request, for a reviewer who would otherwise have to run assignTaskToMe -> updateTaskState
     * -- "started" -> completeTask as three sequential round trips (three clicks, three refetches) to
     * record one decision. ~90% of what this board is used for is exactly that decision.
     *
     * <p><b>Why a separate mutation rather than an opt-in argument on completeTask.</b> The two have
     * genuinely different contracts, and a flag would make all three of completeTask's guards
     * conditional on it: completeTask means "finish the started task I already hold" (state must be
     * {@code started}, RBAC is {@link TaskAuthorizationService#canActOnTask} -- assignee-or-reviewer),
     * while this means "take this task and decide it" (state {@code active} or {@code started}, RBAC is
     * the wider owner-or-candidate-or-reviewer that gates assignTaskToMe, plus a concurrency guard
     * completeTask has no need for). Both still write through the same private helpers below, so the
     * actual state transitions exist once.
     *
     * <p><b>No separate "start" step.</b> Deliberate, not an omission: nothing in the workflow engine
     * needs one. The Drools rules in rules.drl only propagate two property changes to the engine --
     * {@code assigneeUserKey} (-> WorkflowService#assignTask) and {@code state} becoming
     * {@code finished} (-> WorkflowService#completeTask); {@code started} fires no rule and is purely
     * the board's own three-phase bookkeeping. Core's own CompleteTaskCommand additionally calls
     * {@code taskService.start(...)} itself immediately before {@code taskService.complete(...)}, so
     * the engine-side start happens regardless of what this module writes.
     *
     * <p><b>Two saves, never one.</b> The claim and the completion must land in separate
     * {@code session.save()} calls. Both rules keying off one save would fire in an undefined order
     * within a single Drools activation cycle, and worse, JBPM6WorkflowProvider guards every provider
     * call with a thread-local re-entrancy flag ({@code loop}): the completion issued from inside the
     * assignment's own call stack would be silently skipped, completing the JCR node while leaving the
     * real workflow open.
     *
     * <p><b>Failure semantics: fail loudly, never silently claimed; no auto-revert.</b> Everything that
     * can be checked is checked before the first write, including the workflow's own per-outcome
     * permission (see {@link #requireOutcomePermission}) -- which is the failure that actually occurs in
     * practice, and which the engine would otherwise swallow. If the completion still fails after the
     * claim landed, the claim is deliberately NOT rolled back, because a rollback is the more dangerous
     * of the two options here: it would issue a further engine mutation ({@code assignTask(null)} ->
     * {@code taskService.release}) against a task whose engine-side state is by then unknown -- core's
     * CompleteTaskCommand writes {@code state=finished} back through its own system session, so a
     * completion can have succeeded in the engine even when the call this module made threw. Instead the
     * error message states explicitly that the task is now assigned to the caller, and the granular
     * ladder (Unassign / retry the decision) remains available on the board to resolve it. Retrying
     * reviewTask itself is safe: the claim below is skipped when the caller already holds the task, so a
     * retry is a pure completion.
     */
    @GraphQLField
    @GraphQLDescription("Claim and complete a workflow review task with one of its declared outcomes in a single "
            + "request -- the task board's one-click Publish/Reject fast path. Equivalent to assignTaskToMe + "
            + "completeTask, for an active or started task that is either unassigned or already yours.")
    public static GqlTaskBoard reviewTask(
            @GraphQLName("id") @GraphQLNonNull String id,
            @GraphQLName("outcome") @GraphQLNonNull String outcome) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);

        // Restricted to real workflow tasks: a plain jnt:task declares no outcomes and has no engine
        // behind it, so there is no review decision for this path to record (the board completes those
        // through updateTaskState instead).
        if (!task.isNodeType("jnt:workflowTask")) {
            throw new TaskGraphQLException("Only a workflow task can be reviewed in one step");
        }
        String state = task.getPropertyAsString(PROPERTY_STATE);
        if (!STATE_ACTIVE.equals(state) && !STATE_STARTED.equals(state)) {
            throw new TaskGraphQLException("Only an active or started task can be reviewed");
        }

        // Concurrency guard, checked before eligibility so a reviewer (who passes every other check on
        // every task) still cannot silently take a task out from under whoever already claimed it.
        // Someone else holding it is a conflict to report, not a claim to steal -- the granular
        // Unassign action exists for deliberately taking it back.
        TaskAuthorizationService authorizationService = TaskAuthorizationService.get();
        String assignee = task.getPropertyAsString("assigneeUserKey");
        boolean alreadyMine = authorizationService.isAssignee(task, user);
        if (assignee != null && !assignee.isEmpty() && !alreadyMine) {
            throw new TaskGraphQLException("This task is already claimed by another user (" + assignee
                    + ") -- it must be unassigned before you can review it");
        }

        requireEligibleToClaim(task, user, session);
        requireDeclaredOutcome(task, outcome);
        // Before the claim, not after: this is the check the engine would otherwise apply *inside* the
        // completion, after the task had already been claimed -- and apply silently (see the method's
        // own comment). Hoisting it here is what keeps a denied review from leaving a claim behind.
        requireOutcomePermission(task, outcome);

        if (!alreadyMine) {
            applyClaim(user, id);
        }
        applyCompletion(user, id, outcome);
        return refreshed(session, id);
    }

    // Not part of the enum choicelist in definitions.cnd (only active/started/finished/suspended
    // are), but the legacy task.jsp detail view has always let a plain jnt:task be moved to
    // "cancelled" directly (with no outcome) alongside the CND-declared states -- preserved here.
    private static final List<String> ALLOWED_STATES =
            Arrays.asList(STATE_ACTIVE, STATE_STARTED, STATE_SUSPENDED, STATE_FINISHED, STATE_CANCELLED);

    @GraphQLField
    @GraphQLDescription("Directly set a task's state (active, started, suspended, finished, cancelled) with no "
            + "outcome -- the simple suspend/cancel/resume/complete transitions the plain task detail view offers, "
            + "as opposed to completeTask's outcome-driven workflow completion")
    public static GqlTaskBoard updateTaskState(
            @GraphQLName("id") @GraphQLNonNull String id,
            @GraphQLName(PROPERTY_STATE) @GraphQLNonNull String state) throws RepositoryException {
        if (!ALLOWED_STATES.contains(state)) {
            throw new TaskGraphQLException("\"" + state + "\" is not a valid task state");
        }
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        writeTask(user, id, t -> t.setProperty(PROPERTY_STATE, state));
        return refreshed(session, id);
    }

    // jnt:task/jnt:workflowTask data is operational content that only ever lives in the
    // edit/default workspace, never published to live -- pinned explicitly so these mutations
    // work correctly regardless of which workspace the ambient rendering context happens to be
    // using (e.g. a "live" dashboard iframe), instead of silently operating against a session
    // where the target node doesn't exist.
    private static JCRSessionWrapper session() throws RepositoryException {
        return JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
    }

    private static JCRNodeWrapper loadTask(JCRSessionWrapper session, String id) throws RepositoryException {
        JCRNodeWrapper node = session.getNodeByIdentifier(id);
        if (!node.isNodeType("jnt:task")) {
            throw new TaskGraphQLException("Node " + id + " is not a task");
        }
        return node;
    }

    private static void requireCanAct(JCRNodeWrapper task, JahiaUser user, JCRSessionWrapper session) throws RepositoryException {
        if (!TaskAuthorizationService.get().canActOnTask(task, user, session.getNode("/"))) {
            throw new TaskGraphQLException("You are not allowed to act on this task");
        }
    }

    /**
     * The "may this user take this task" gate -- deliberately wider than {@link #requireCanAct}: it also
     * admits an eligible candidate who does not own the task yet, which is the whole point of claiming
     * one. Shared by assignTaskToMe and reviewTask so the two cannot drift into disagreeing about who
     * is allowed to pick a task up.
     */
    private static void requireEligibleToClaim(JCRNodeWrapper task, JahiaUser user, JCRSessionWrapper session)
            throws RepositoryException {
        TaskAuthorizationService authorizationService = TaskAuthorizationService.get();
        if (!authorizationService.isOwnerOrCandidate(task, user)
                && !authorizationService.canReviewAllTasks(session.getNode("/"))) {
            throw new TaskGraphQLException("You are not eligible to be assigned this task");
        }
    }

    private static void requireDeclaredOutcome(JCRNodeWrapper task, String outcome) {
        if (!GqlTaskBoard.readPossibleOutcomes(task).contains(outcome)) {
            throw new TaskGraphQLException("\"" + outcome + "\" is not a valid outcome for this task");
        }
    }

    /**
     * Claims the task for {@code user}. The write itself is one property + one save, but that save
     * is what fires the "A workflow task has been assigned" rule in rules.drl, which is what actually
     * claims the task in the workflow engine -- see this class's own javadoc.
     */
    private static void applyClaim(JahiaUser user, String taskId) throws RepositoryException {
        writeTask(user, taskId, t -> t.setProperty("assigneeUserKey", user.getUserKey()));
    }

    /**
     * Completes the task with {@code outcome}. finalOutcome must be set before state flips to
     * "finished" in the same save: the Drools rule reads finalOutcome off this same node when it reacts
     * to the state change, so both writes need to land together in one session.save().
     */
    private static void applyCompletion(JahiaUser user, String taskId, String outcome) throws RepositoryException {
        writeTask(user, taskId, t -> {
            t.setProperty("finalOutcome", outcome);
            t.setProperty(PROPERTY_STATE, STATE_FINISHED);
        });
    }

    @FunctionalInterface
    private interface TaskWrite {
        void apply(JCRNodeWrapper task) throws RepositoryException;
    }

    /**
     * Applies one task-node write in its own save, with system privileges under the caller's
     * identity -- see the class javadoc for why elevation is required (candidates and reviewers
     * hold no JCR write ACL on a task node in the initiator's user space) and why identity is
     * preserved (Drools-to-engine attribution). Only ever call this AFTER the mutation's RBAC
     * gate has passed; this method is the privileged write, not the authorization.
     */
    private static void writeTask(JahiaUser user, String taskId, TaskWrite write) throws RepositoryException {
        JCRTemplate.getInstance().doExecuteWithSystemSessionAsUser(user, Constants.EDIT_WORKSPACE, null,
                (JCRCallback<Void>) systemSession -> {
                    write.apply(systemSession.getNodeByIdentifier(taskId));
                    systemSession.save();
                    return null;
                });
    }

    /**
     * Re-reads the task through the caller's own session after an elevated write, so the mutation's
     * return value reflects the new state (the user session's item cache still holds the
     * pre-write values) and is still subject to the caller's own read permissions.
     */
    private static GqlTaskBoard refreshed(JCRSessionWrapper session, String id) throws RepositoryException {
        session.refresh(false);
        return new GqlTaskBoard(session.getNodeByIdentifier(id));
    }

    /**
     * Rejects the review up front when the workflow itself declares a JCR permission for this outcome
     * that the caller does not hold on the content under review.
     *
     * <p>This mirrors, ahead of time, a check core performs inside the completion: JBPM6's
     * CompleteTaskCommand looks the {@code <taskName>.<outcome>} key up in the workflow's registered
     * permissions map and, if the caller lacks that permission on the process's {@code nodeId}, logs an
     * error and <em>returns without completing anything</em>. Because this module completes by writing
     * {@code state=finished} to the JCR node and letting the Drools rule propagate that to the engine,
     * a denial there is invisible: the board's task node reads "finished" while the real workflow is
     * still open. Checking first turns that into an error the caller actually sees, and -- for
     * reviewTask specifically -- keeps a denied decision from leaving the task claimed.
     *
     * <p>The two inputs are read from exactly the sources core uses, so this is not an approximation of
     * core's check: {@link WorkflowTask#getOutcomesPermissions()} is the same registered map, already
     * stripped of its {@code <taskName>.} prefix by core's own BaseCommand, and the task node's
     * {@code targetNode} property is set (in JBPMTaskLifeCycleEventListener) from the very {@code nodeId}
     * process variable CompleteTaskCommand resolves the permission against.
     *
     * <p>Best-effort by design: anything that cannot be resolved (a process no longer live in the engine,
     * a workflow that declares no permission for this outcome, a target node that no longer exists)
     * leaves the decision to the engine rather than blocking a review this module merely failed to
     * verify.
     */
    private static void requireOutcomePermission(JCRNodeWrapper task, String outcome) {
        String permission;
        JCRNodeWrapper targetNode;
        try {
            if (!task.hasProperty("provider") || !task.hasProperty("taskId") || !task.hasProperty("targetNode")) {
                return;
            }
            WorkflowTask workflowTask = WorkflowService.getInstance().getWorkflowTask(
                    task.getPropertyAsString("taskId"),
                    task.getPropertyAsString("provider"),
                    JahiaLocaleContextHolder.getLocale());
            if (workflowTask == null) {
                return;
            }
            Map<String, String> outcomesPermissions = workflowTask.getOutcomesPermissions();
            permission = outcomesPermissions != null ? outcomesPermissions.get(outcome) : null;
            if (permission == null) {
                return;
            }
            targetNode = (JCRNodeWrapper) task.getProperty("targetNode").getNode();
        } catch (Exception e) {
            // Enrichment of an authorization decision the engine will make again anyway, not the
            // decision itself -- a lookup failure here must not fail an otherwise valid review.
            return;
        }

        if (!targetNode.hasPermission(permission)) {
            throw new TaskGraphQLException("You do not have the \"" + permission + "\" permission required to "
                    + "complete this task with the \"" + outcome + "\" outcome");
        }
    }
}
