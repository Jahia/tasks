package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
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
 */
@GraphQLDescription("A live workflow activity entry: either an active task with a due date, or a completed "
        + "task's history entry with an outcome")
public class GqlWorkflowActivityTask {

    private final String label;
    private final Date dueDate;
    private final Date endTime;
    private final String targetNodeId;

    GqlWorkflowActivityTask(String label, Date dueDate, Date endTime, String targetNodeId) {
        this.label = label;
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
            JCRNodeWrapper node = JCRSessionFactory.getInstance().getCurrentUserSession().getNodeByIdentifier(targetNodeId);
            return new GqlJcrNodeImpl(node);
        } catch (ItemNotFoundException e) {
            return null;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve workflow activity target node", e);
        }
    }
}
