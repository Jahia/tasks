package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUserManagerService;
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
public final class WorkflowActivityQueryExtensions {

    private WorkflowActivityQueryExtensions() {
    }

    @GraphQLField
    @GraphQLDescription("Live WorkflowService activity (not JCR jnt:task/jnt:workflowTask nodes) for every "
            + "workflow process tracked under path: active due-dated tasks and completed task history")
    public static GqlWorkflowActivity workflowActivity(
            @GraphQLName("path") @GraphQLNonNull String path) throws RepositoryException {
        // Pinned to the edit workspace for consistency with every other query in this module; see
        // TaskBoardQueryExtensions' class comment for why.
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        if (JahiaUserManagerService.isGuest(session.getUser())) {
            throw new TaskGraphQLException("You must be logged in to view workflow activity");
        }
        // WorkflowService.getHistoryWorkflowsByPath queries the workflow engine's own process
        // store directly, bypassing JCR read-ACLs entirely -- resolving path through the caller's
        // own session first re-applies that enforcement (a non-existent or unreadable path throws
        // PathNotFoundException, same as getNodeByIdentifier does for task(id) above) instead of
        // letting an arbitrary caller-supplied path (e.g. "/sites") disclose every site's workflow
        // activity regardless of whether they can read that content.
        session.getNode(path);
        Locale locale = session.getLocale();
        WorkflowService workflowService = WorkflowService.getInstance();

        List<GqlWorkflowActivityTask> activeTasks = new ArrayList<>();
        List<GqlWorkflowActivityTask> history = new ArrayList<>();

        for (HistoryWorkflow process : workflowService.getHistoryWorkflowsByPath(path + "/%", locale)) {
            if (!process.isCompleted()) {
                collectActiveTasks(workflowService, process, locale, activeTasks);
            }
            collectHistoryTasks(workflowService, process, locale, history);
        }

        return new GqlWorkflowActivity(activeTasks, history);
    }

    // Split out of workflowActivity() above to keep its own cognitive complexity down --
    // one process's currently-available due-dated actions.
    private static void collectActiveTasks(WorkflowService workflowService, HistoryWorkflow process, Locale locale,
            List<GqlWorkflowActivityTask> activeTasks) {
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

    // Split out of workflowActivity() above -- one process's completed task history entries.
    private static void collectHistoryTasks(WorkflowService workflowService, HistoryWorkflow process, Locale locale,
            List<GqlWorkflowActivityTask> history) {
        List<HistoryWorkflowTask> tasks = workflowService.getHistoryWorkflowTasks(
                process.getProcessId(), process.getProvider(), locale);
        for (HistoryWorkflowTask task : tasks) {
            if (task.getEndTime() != null) {
                String label = task.getDisplayOutcome() != null ? task.getDisplayOutcome() : task.getOutcome();
                history.add(new GqlWorkflowActivityTask(label, null, task.getEndTime(), process.getNodeId()));
            }
        }
    }
}
