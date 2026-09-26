package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLNonNull;

/**
 * A task's {@code taskData} child of type {@code jnt:simpleWorkflow} -- the free-text note the
 * reviewer submits alongside their decision (the legacy board embedded it as a form inside the
 * started task's action list, and posted it just before the completion itself).
 *
 * <p>The note is stored in the child node's {@code jcr:title} property, which is what the legacy
 * simpleWorkflow.jsp form wrote and what {@code updateTaskDataTitle} still writes; it is exposed
 * here as {@code comment} because that is what the value means on this screen -- the workflow
 * engine pre-fills it with the process summary, and the reviewer replaces it with their own text.
 */
@GraphQLDescription("A task's jnt:simpleWorkflow taskData child: the free-text comment submitted with a decision")
public class GqlSimpleWorkflowTaskData {

    private final String id;
    private final String comment;

    GqlSimpleWorkflowTaskData(String id, String comment) {
        this.id = id;
        this.comment = comment;
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("Identifier of the taskData node -- what updateTaskDataTitle(id:) expects")
    public String getId() {
        return id;
    }

    @GraphQLField
    @GraphQLDescription("The comment currently stored on the node (its jcr:title); null when it has none")
    public String getComment() {
        return comment;
    }
}
