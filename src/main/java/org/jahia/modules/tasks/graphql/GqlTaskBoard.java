package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNode;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNodeImpl;
import org.jahia.services.content.JCRNodeWrapper;

import javax.jcr.ItemNotFoundException;
import javax.jcr.RepositoryException;
import javax.jcr.Value;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

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

    @GraphQLField
    @GraphQLDescription("Outcomes this task can be completed with (workflow-specific; empty when none are declared)")
    public List<String> getPossibleOutcomes() {
        return readPossibleOutcomes(node);
    }

    @GraphQLField
    @GraphQLDescription("The content node this task is about (e.g. a page pending publication), if any")
    public GqlJcrNode getTargetNode() {
        try {
            if (!node.hasProperty("targetNode")) {
                return null;
            }
            return new GqlJcrNodeImpl((JCRNodeWrapper) node.getProperty("targetNode").getNode());
        } catch (ItemNotFoundException e) {
            // Weak reference target no longer exists.
            return null;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task target node", e);
        }
    }

    static List<String> readPossibleOutcomes(JCRNodeWrapper node) {
        try {
            if (!node.hasProperty("possibleOutcomes")) {
                return Collections.emptyList();
            }
            List<String> outcomes = new ArrayList<>();
            for (Value value : node.getProperty("possibleOutcomes").getValues()) {
                outcomes.add(value.getString());
            }
            return outcomes;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read task outcomes", e);
        }
    }
}
