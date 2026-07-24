package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import org.jahia.services.content.JCRNodeWrapper;

import javax.jcr.RepositoryException;

/**
 * One row of the task board GraphQL query -- wraps a {@code jnt:task} or
 * {@code jnt:workflowTask} node. Checked JCR exceptions are caught and rethrown
 * unchecked so this type stays usable as a plain stream-mapping target.
 */
@GraphQLDescription("A row of the task board: a jnt:task or jnt:workflowTask node")
public class GqlTaskBoard {

    private final JCRNodeWrapper node;

    public GqlTaskBoard(JCRNodeWrapper node) {
        this.node = node;
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("Task node identifier")
    public String getId() {
        try {
            return node.getIdentifier();
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read task identifier", e);
        }
    }

    @GraphQLField
    @GraphQLDescription("Task title")
    public String getTitle() {
        return node.getPropertyAsString("jcr:title");
    }

    @GraphQLField
    @GraphQLDescription("Username of the task creator")
    public String getCreator() {
        return node.getPropertyAsString("jcr:createdBy");
    }

    @GraphQLField
    @GraphQLDescription("User key of the current task owner (assignee)")
    public String getOwner() {
        return node.getPropertyAsString("assigneeUserKey");
    }

    @GraphQLField
    @GraphQLDescription("Task state: active, started, finished or suspended")
    public String getState() {
        return node.getPropertyAsString("state");
    }

    @GraphQLField
    @GraphQLDescription("The underlying node type: jnt:task or jnt:workflowTask")
    public String getTaskType() {
        try {
            return node.getPrimaryNodeTypeName();
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read task node type", e);
        }
    }

    @GraphQLField
    @GraphQLDescription("Due date, as stored on the task node")
    public String getDueDate() {
        return node.getPropertyAsString("dueDate");
    }
}
