package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNode;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNodeImpl;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;

import javax.jcr.ItemNotFoundException;
import javax.jcr.RepositoryException;
import java.util.Date;

/**
 * A single live workflow activity entry -- either an active {@code WorkflowTask} with a due date,
 * or a completed {@code HistoryWorkflowTask}'s history entry with an outcome. Mirrors what
 * taskSchedule.jsp reads directly off those two object types via the workflow:workflow /
 * workflow:workflowHistory taglibs.
 *
 * <p>{@code name} and {@code user} were added for the board's preview panel (#61) and are purely
 * additive: every field this type had is unchanged, so the existing consumers (the jnt:taskSchedule
 * view and tests/cypress/fixtures/graphql/workflowActivity.query.graphql) select the same shape
 * they always did.
 */
@GraphQLDescription("A live workflow activity entry: either an active task with a due date, or a completed "
        + "task's history entry with an outcome")
public class GqlWorkflowActivityTask {

    private final String label;
    private final String stepName;
    private final String user;
    private final Date dueDate;
    private final Date endTime;
    private final String targetNodeId;

    GqlWorkflowActivityTask(String label, String stepName, String user, Date dueDate, Date endTime,
            String targetNodeId) {
        this.label = label;
        this.stepName = stepName;
        this.user = user;
        this.dueDate = dueDate;
        this.endTime = endTime;
        this.targetNodeId = targetNodeId;
    }

    @GraphQLField
    @GraphQLDescription("Display label: the task's display name if active, or its display outcome if from history")
    public String getLabel() {
        return label;
    }

    @GraphQLField
    @GraphQLDescription("The workflow STEP this entry is about, as its display name (e.g. \"Review\") -- distinct "
            + "from label, which for a history entry is the outcome rather than the step. Added for the board's "
            + "preview panel (#61): the jBPM provider hardcodes a completed task's outcome to the literal string "
            + "\"outcome\" (see GetHistoryWorkflowTasksCommand), so label alone cannot name what was completed.")
    public String getName() {
        return stepName;
    }

    @GraphQLField
    @GraphQLDescription("Display name of the user this entry belongs to -- the step's actual owner for a history "
            + "entry -- resolved from the engine's own value; the raw value when it doesn't resolve to a node this "
            + "viewer can read. Null when the engine records none.")
    public String getUser() {
        return user;
    }

    @GraphQLField
    @GraphQLDescription("Due date, for an active task; null for a history entry")
    public String getDueDate() {
        return dueDate != null ? dueDate.toInstant().toString() : null;
    }

    @GraphQLField
    @GraphQLDescription("Completion time, for a history entry; null for an active task")
    public String getEndTime() {
        return endTime != null ? endTime.toInstant().toString() : null;
    }

    @GraphQLField
    @GraphQLDescription("The content node this workflow process concerns, if it still exists")
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
            throw new TaskGraphQLException("Unable to resolve workflow activity target node", e);
        }
    }
}
