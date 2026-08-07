package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUser;

import javax.jcr.RepositoryException;
import java.util.Arrays;
import java.util.List;

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
 */
@GraphQLTypeExtension(DXGraphQLProvider.Mutation.class)
public class TaskBoardMutationExtensions {

    @GraphQLField
    @GraphQLDescription("Assign an active, not-yet-assigned-to-you task to yourself")
    public static GqlTaskBoard assignTaskToMe(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);

        if (!"active".equals(task.getPropertyAsString("state"))) {
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
        task.setProperty("assigneeUserKey", user.getUserKey());
        session.save();
        return new GqlTaskBoard(task);
    }

    @GraphQLField
    @GraphQLDescription("Unassign a task (\"Unassign / Refuse\"), returning it to the active, unassigned pool")
    public static GqlTaskBoard unassignTask(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        task.setProperty("assigneeUserKey", "");
        task.setProperty("state", "active");
        session.save();
        return new GqlTaskBoard(task);
    }

    @GraphQLField
    @GraphQLDescription("Suspend a task you are actively working on")
    public static GqlTaskBoard suspendTask(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        if (!"started".equals(task.getPropertyAsString("state"))) {
            throw new TaskGraphQLException("Only a started task can be suspended");
        }
        task.setProperty("state", "suspended");
        session.save();
        return new GqlTaskBoard(task);
    }

    @GraphQLField
    @GraphQLDescription("Resume a suspended task")
    public static GqlTaskBoard resumeTask(
            @GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        if (!"suspended".equals(task.getPropertyAsString("state"))) {
            throw new TaskGraphQLException("Only a suspended task can be resumed");
        }
        task.setProperty("state", "started");
        session.save();
        return new GqlTaskBoard(task);
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

        if (!"started".equals(task.getPropertyAsString("state"))) {
            throw new TaskGraphQLException("Only a started task can be completed");
        }
        if (!GqlTaskBoard.readPossibleOutcomes(task).contains(outcome)) {
            throw new TaskGraphQLException("\"" + outcome + "\" is not a valid outcome for this task");
        }

        // finalOutcome must be set before state flips to "finished" in the same save:
        // the Drools rule reads finalOutcome off this same node when it reacts to the
        // state change, so both writes need to land together in one session.save().
        task.setProperty("finalOutcome", outcome);
        task.setProperty("state", "finished");
        session.save();
        return new GqlTaskBoard(task);
    }

    // Not part of the enum choicelist in definitions.cnd (only active/started/finished/suspended
    // are), but the legacy task.jsp detail view has always let a plain jnt:task be moved to
    // "cancelled" directly (with no outcome) alongside the CND-declared states -- preserved here.
    private static final List<String> ALLOWED_STATES = Arrays.asList("active", "started", "suspended", "finished", "cancelled");

    @GraphQLField
    @GraphQLDescription("Directly set a task's state (active, started, suspended, finished, cancelled) with no "
            + "outcome -- the simple suspend/cancel/resume/complete transitions the plain task detail view offers, "
            + "as opposed to completeTask's outcome-driven workflow completion")
    public static GqlTaskBoard updateTaskState(
            @GraphQLName("id") @GraphQLNonNull String id,
            @GraphQLName("state") @GraphQLNonNull String state) throws RepositoryException {
        if (!ALLOWED_STATES.contains(state)) {
            throw new TaskGraphQLException("\"" + state + "\" is not a valid task state");
        }
        JCRSessionWrapper session = session();
        JahiaUser user = TaskAuthorizationService.requireNonGuest(session);
        JCRNodeWrapper task = loadTask(session, id);
        requireCanAct(task, user, session);

        task.setProperty("state", state);
        session.save();
        return new GqlTaskBoard(task);
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
}
