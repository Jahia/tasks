package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.workflow.HistoryWorkflow;
import org.jahia.services.workflow.HistoryWorkflowTask;
import org.jahia.services.workflow.Workflow;
import org.jahia.services.workflow.WorkflowAction;
import org.jahia.services.workflow.WorkflowService;
import org.jahia.services.workflow.WorkflowTask;

import javax.jcr.RepositoryException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Root {@code workflowActivity} query -- wraps the live WorkflowService process/history data that
 * taskSchedule.jsp reads directly via the workflow:workflowForPath / workflow:workflow /
 * workflow:workflowHistory taglibs (org.jahia.taglibs.workflow.*, confirmed against the real
 * jahia-impl/jahia-taglib classes). This is deliberately separate from the JCR jnt:task /
 * jnt:workflowTask query (taskBoard/task) -- it surfaces the live process engine's own state
 * (in-progress tasks and history), which is not necessarily fully mirrored into JCR.
 *
 * <p>Call sequence mirrors WorkflowForPathTag exactly: {@code getHistoryWorkflowsByPath(path + "/%",
 * locale)} returns every tracked process (in progress or finished) under path; for each
 * unfinished one, {@code getWorkflow(processId, provider, locale).getAvailableActions()} gives its
 * current actions (filtered to the {@code WorkflowTask} subtype that actually declares a due
 * date); every process (finished or not) also contributes its
 * {@code getHistoryWorkflowTasks(processId, provider, locale)}.
 */
@GraphQLTypeExtension(DXGraphQLProvider.Query.class)
public class WorkflowActivityQueryExtensions {

    @GraphQLField
    @GraphQLDescription("Live WorkflowService activity (not JCR jnt:task/jnt:workflowTask nodes) for every "
            + "workflow process tracked under path: active due-dated tasks and completed task history")
    public static GqlWorkflowActivity workflowActivity(
            @GraphQLName("path") @GraphQLNonNull String path) throws RepositoryException {
        // Only the locale is read off this session (WorkflowService's own API takes the path/id
        // args directly) -- pinned to the edit workspace for consistency with every other query
        // in this module; see TaskBoardQueryExtensions' class comment for why.
        Locale locale = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE).getLocale();
        WorkflowService workflowService = WorkflowService.getInstance();

        List<GqlWorkflowActivityTask> activeTasks = new ArrayList<>();
        List<GqlWorkflowActivityTask> history = new ArrayList<>();

        List<HistoryWorkflow> processes = workflowService.getHistoryWorkflowsByPath(path + "/%", locale);
        for (HistoryWorkflow process : processes) {
            if (!process.isCompleted()) {
                Workflow active = workflowService.getWorkflow(process.getProcessId(), process.getProvider(), locale);
                for (WorkflowAction action : active.getAvailableActions()) {
                    if (action instanceof WorkflowTask) {
                        WorkflowTask task = (WorkflowTask) action;
                        if (task.getDueDate() != null) {
                            String label = task.getDisplayName() != null ? task.getDisplayName() : task.getName();
                            activeTasks.add(new GqlWorkflowActivityTask(label, task.getDueDate(), null, process.getNodeId()));
                        }
                    }
                }
            }

            List<HistoryWorkflowTask> tasks = workflowService.getHistoryWorkflowTasks(
                    process.getProcessId(), process.getProvider(), locale);
            for (HistoryWorkflowTask task : tasks) {
                if (task.getEndTime() != null) {
                    String label = task.getDisplayOutcome() != null ? task.getDisplayOutcome() : task.getOutcome();
                    history.add(new GqlWorkflowActivityTask(label, null, task.getEndTime(), process.getNodeId()));
                }
            }
        }

        return new GqlWorkflowActivity(activeTasks, history);
    }
}
