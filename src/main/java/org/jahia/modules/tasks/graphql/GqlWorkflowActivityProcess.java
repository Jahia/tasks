package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNode;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNodeImpl;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;

import javax.jcr.ItemNotFoundException;
import javax.jcr.RepositoryException;
import java.util.Date;

/**
 * One workflow PROCESS the engine knows about for a node -- as opposed to the individual task
 * entries {@link GqlWorkflowActivityTask} carries. Wraps a {@code HistoryWorkflow}, which the
 * engine returns for running and completed processes alike (see
 * {@code WorkflowService#getHistoryWorkflowsByPath}'s own javadoc: "This method also returns
 * 'active' (i.e. not completed) workflow process instance").
 *
 * <p>Added for the task board's preview side panel (#61), whose History tab has to be able to say
 * something about a publication request the moment it is raised. Neither existing list can:
 * {@code activeTasks} only carries steps that declare a DUE DATE (1-step publication's review step
 * declares none), and {@code history} only carries steps that have already ENDED. A freshly
 * started process is therefore invisible in both, while being exactly what the reviewer opening
 * the panel is looking at -- the process-level "started by X on Y" line is the one fact that
 * always exists.
 */
@GraphQLDescription("A workflow process tracked for a node: who started it, when, and whether it has finished")
public class GqlWorkflowActivityProcess {

    private final String name;
    private final String startUser;
    private final Date startTime;
    private final Date endTime;
    private final boolean completed;
    private final String targetNodeId;

    GqlWorkflowActivityProcess(String name, String startUser, Date startTime, Date endTime, boolean completed,
            String targetNodeId) {
        this.name = name;
        this.startUser = startUser;
        this.startTime = startTime;
        this.endTime = endTime;
        this.completed = completed;
        this.targetNodeId = targetNodeId;
    }

    @GraphQLField
    @GraphQLDescription("Display name of the workflow definition this process runs, e.g. \"One step publication\"")
    public String getName() {
        return name;
    }

    @GraphQLField
    @GraphQLDescription("Display name of the user who started the process, resolved from the engine's own start-user "
            + "value; the raw value when it doesn't resolve to a node this viewer can read")
    public String getStartUser() {
        return startUser;
    }

    @GraphQLField
    @GraphQLDescription("When the process was started, as an ISO-8601 instant")
    public String getStartTime() {
        return startTime != null ? startTime.toInstant().toString() : null;
    }

    @GraphQLField
    @GraphQLDescription("When the process finished, as an ISO-8601 instant; null while it is still running")
    public String getEndTime() {
        return endTime != null ? endTime.toInstant().toString() : null;
    }

    @GraphQLField
    @GraphQLName("isCompleted")
    @GraphQLDescription("Whether the process has finished")
    public boolean isCompleted() {
        return completed;
    }

    @GraphQLField
    @GraphQLDescription("The content node this process concerns, if it still exists")
    public GqlJcrNode getTargetNode() {
        if (targetNodeId == null) {
            return null;
        }
        try {
            JCRNodeWrapper node = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE)
                    .getNodeByIdentifier(targetNodeId);
            return new GqlJcrNodeImpl(node);
        } catch (ItemNotFoundException e) {
            return null;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve workflow process target node", e);
        }
    }
}
