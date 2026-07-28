package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;

import java.util.List;

@GraphQLDescription("Live WorkflowService activity for a path: active due-dated tasks and completed task history")
public class GqlWorkflowActivity {

    private final List<GqlWorkflowActivityTask> activeTasks;
    private final List<GqlWorkflowActivityTask> history;

    GqlWorkflowActivity(List<GqlWorkflowActivityTask> activeTasks, List<GqlWorkflowActivityTask> history) {
        this.activeTasks = activeTasks;
        this.history = history;
    }

    @GraphQLField
    @GraphQLDescription("Active workflow tasks that declare a due date")
    public List<GqlWorkflowActivityTask> getActiveTasks() {
        return activeTasks;
    }

    @GraphQLField
    @GraphQLDescription("Completed workflow task history entries")
    public List<GqlWorkflowActivityTask> getHistory() {
        return history;
    }
}
