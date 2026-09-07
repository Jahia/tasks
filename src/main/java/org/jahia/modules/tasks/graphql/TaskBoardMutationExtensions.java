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

import javax.jcr.RepositoryException;
import java.util.Arrays;
import java.util.Calendar;
import java.util.List;

/**
 * Root task-board mutations -- the state-transition actions behind the task board's
 * 3-dot menu (assign / unassign / suspend / resume / complete). Every mutation
 * re-checks RBAC server-side (the menu hiding an action client-side is a UX nicety,
 * not a guard) and writes through plain JCR property changes + a single save, which is
 * also what the legacy JSPs did: the Drools rules in
 * rules.drl ("A workflow task has been assigned" / "...completed") key off exactly
 * these property changes to propagate to the real underlying WorkflowService for
 * jnt:workflowTask nodes. A mutation must not bypass this path (e.g. by calling
 * WorkflowService directly), or that propagation is skipped and the task node and the
 * real workflow it represents fall out of sync.
 *
 * <p>That save runs with system privileges under the caller's identity - see
 * {@link #writeTask}. The RBAC gate in each mutation is the authorization; the elevation only
 * gets the write past JCR ACLs on a task node sitting in another user's space.
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

    // See definitions.cnd; written and cleared by stampClosedDate alone.
    private static final String PROPERTY_CLOSED_DATE = "closedDate";

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
        TaskAuthorizationService authorizationService = TaskAuthorizationService.get();
        if (!authorizationService.isOwnerOrCandidate(task, user)
                && !authorizationService.canReviewAllTasks(session.getNode("/"))) {
            throw new TaskGraphQLException("You are not eligible to be assigned this task");
        }

        // Deliberately stays "active" here rather than flipping to "started": the UI has three
        // distinct phases (Unassigned -> Assigned -> Active/In-Progress), and "started" is what
        // marks the third one. An assigned-but-not-yet-started task is still "active", just with
        // an owner now; updateTaskState(id, "started") (the client's own "Start" action) is what
        // actually advances it, mirroring how unassignTask reverts a task to owner-less "active"
        // rather than some other state.
        writeTask(user, id, t -> t.setProperty("assigneeUserKey", user.getUserKey()));
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
        if (!GqlTaskBoard.readPossibleOutcomes(task).contains(outcome)) {
            throw new TaskGraphQLException("\"" + outcome + "\" is not a valid outcome for this task");
        }

        // finalOutcome must be set before state flips to "finished" in the same save:
        // the Drools rule reads finalOutcome off this same node when it reacts to the
        // state change, so both writes need to land together in one save - which is why
        // they share a single writeTask call rather than taking one each.
        writeTask(user, id, t -> {
            t.setProperty("finalOutcome", outcome);
            t.setProperty(PROPERTY_STATE, STATE_FINISHED);
        });
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

    /**
     * Applies a property change to the task with system privileges, under the caller's identity.
     *
     * <p>A jnt:workflowTask node lives under the workflow initiator's own user space
     * (/users/&lt;initiator&gt;/workflowTasks/...), where an eligible group candidate or reviewer
     * holds no JCR write ACL at all -- the only write grant the rules add is "rw" for the assignee,
     * and that happens AFTER assignment. Without elevation every eligibility check in this class
     * can pass and the claim still dies on "assigneeUserKey: not allowed to add or modify item".
     * That is reachable from this board as soon as group candidates can see and claim their tasks.
     *
     * <p>The caller's identity is preserved so the Drools-to-WorkflowService propagation still
     * attributes engine calls to the actual caller. The explicit RBAC gates in each mutation are
     * therefore the real and only authorization boundary for these writes: call this only AFTER
     * one has passed. This method is the privileged write, not the authorization.
     */
    private static void writeTask(JahiaUser user, String taskId, TaskWrite write) throws RepositoryException {
        JCRTemplate.getInstance().doExecuteWithSystemSessionAsUser(user, Constants.EDIT_WORKSPACE, null,
                (JCRCallback<Void>) systemSession -> {
                    JCRNodeWrapper task = systemSession.getNodeByIdentifier(taskId);
                    write.apply(task);
                    stampClosedDate(task);
                    systemSession.save();
                    return null;
                });
    }

    /**
     * Keeps closedDate in step with state, for every write that goes through this class.
     *
     * <p>Here rather than in each mutation because "when was this closed" is a fact about the
     * state property, not about the particular button that moved it: completeTask, updateTaskState
     * and the unassign path can all leave a task finished or take it back out, and a rule spelled
     * out in three places is one edit away from holding in only two.
     *
     * <p>Re-closing a reopened task re-stamps it, since reopening cleared the old value: the date
     * always describes the closure the task is currently in, never an earlier one. The stamp is
     * only ever written when there is none, so a save that touches an already-closed task -- an
     * edited description, say -- does not silently move its closing date to today.
     */
    private static void stampClosedDate(JCRNodeWrapper task) throws RepositoryException {
        boolean closed = STATE_FINISHED.equals(task.getPropertyAsString(PROPERTY_STATE));
        if (closed && !task.hasProperty(PROPERTY_CLOSED_DATE)) {
            task.setProperty(PROPERTY_CLOSED_DATE, Calendar.getInstance());
        } else if (!closed && task.hasProperty(PROPERTY_CLOSED_DATE)) {
            task.getProperty(PROPERTY_CLOSED_DATE).remove();
        }
    }

    /**
     * Re-reads the task through the caller's own session after an elevated write, so the return
     * value reflects the new state - the user session's item cache still holds the pre-write
     * values - and is still subject to the caller's own read permissions.
     */
    private static GqlTaskBoard refreshed(JCRSessionWrapper session, String id) throws RepositoryException {
        session.refresh(false);
        return new GqlTaskBoard(session.getNodeByIdentifier(id));
    }

    /** One property change against a task node, run inside the elevated session. */
    @FunctionalInterface
    private interface TaskWrite {
        void apply(JCRNodeWrapper task) throws RepositoryException;
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
}
