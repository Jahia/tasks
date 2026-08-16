package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;

import java.util.List;

@GraphQLDescription("Live WorkflowService activity for a path: tracked processes, active due-dated tasks and "
        + "completed task history")
public class GqlWorkflowActivity {

    private final List<GqlWorkflowActivityProcess> processes;
    private final List<GqlWorkflowActivityTask> activeTasks;
    private final List<GqlWorkflowActivityTask> history;

    GqlWorkflowActivity(List<GqlWorkflowActivityProcess> processes, List<GqlWorkflowActivityTask> activeTasks,
            List<GqlWorkflowActivityTask> history) {
        this.processes = processes;
        this.activeTasks = activeTasks;
        this.history = history;
    }

    @GraphQLField
    @GraphQLDescription("Every workflow process the engine tracks here, running or finished -- the level at which a "
            + "just-raised request is visible at all (see GqlWorkflowActivityProcess). Added in #61; the two lists "
            + "below are unchanged.")
    public List<GqlWorkflowActivityProcess> getProcesses() {
        return processes;
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
