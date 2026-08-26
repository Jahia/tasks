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
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.usermanager.JahiaUserManagerService;
import org.jahia.services.workflow.HistoryWorkflow;
import org.jahia.services.workflow.HistoryWorkflowTask;
import org.jahia.services.workflow.Workflow;
import org.jahia.services.workflow.WorkflowAction;
import org.jahia.services.workflow.WorkflowService;
import org.jahia.services.workflow.WorkflowTask;
import org.jahia.utils.i18n.JahiaLocaleContextHolder;

import javax.jcr.PathNotFoundException;
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
            + "workflow process tracked under path: tracked processes, active due-dated tasks and completed task "
            + "history")
    public static GqlWorkflowActivity workflowActivity(
            @GraphQLName("path") @GraphQLNonNull String path,
            @GraphQLName("includeSelf")
            @GraphQLDescription("Also report the processes running on the node AT path, not only on its "
                    + "descendants. Off by default, which is the behaviour every caller had before #61: the "
                    + "underlying engine query is a SQL LIKE on the process's own \"nodePath\" variable, and this "
                    + "field has always passed it \"<path>/%\" -- a pattern that deliberately cannot match path "
                    + "itself. The jnt:taskSchedule view wants exactly that (it asks about a PAGE and means the "
                    + "content on it); the board's preview panel wants the opposite -- the workflow raised ON the "
                    + "node it is previewing -- so it turns this on rather than asking about the parent and "
                    + "filtering the answer client-side.")
            Boolean includeSelf) throws RepositoryException {
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
        // Same two-step chain GqlTaskBoard#resolveLocale documents, and for the same reason: a
        // session opened by a plain GraphQL POST -- which is how the board's preview panel calls
        // this -- has NO locale at all, and the engine then skips its resource-bundle lookups, so
        // every workflow definition comes back named by its KEY ("1-step-publication") instead of
        // its label ("One step publication"). That name is the headline of the panel's History tab.
        // Display-only: which processes are found is decided by the path, never by this.
        Locale locale = session.getLocale() != null ? session.getLocale() : JahiaLocaleContextHolder.getLocale();
        WorkflowService workflowService = WorkflowService.getInstance();

        List<GqlWorkflowActivityProcess> processes = new ArrayList<>();
        List<GqlWorkflowActivityTask> activeTasks = new ArrayList<>();
        List<GqlWorkflowActivityTask> history = new ArrayList<>();

        for (HistoryWorkflow process : collectProcesses(workflowService, path, locale, Boolean.TRUE.equals(includeSelf))) {
            processes.add(new GqlWorkflowActivityProcess(
                    process.getDisplayName() != null ? process.getDisplayName() : process.getName(),
                    displayNameOf(session, process.getUser()),
                    process.getStartTime(),
                    process.getEndTime(),
                    process.isCompleted(),
                    process.getNodeId()));
            if (!process.isCompleted()) {
                collectActiveTasks(workflowService, process, locale, activeTasks);
            }
            collectHistoryTasks(workflowService, process, locale, session, history);
        }

        return new GqlWorkflowActivity(processes, activeTasks, history);
    }

    // The engine's LIKE pattern is the literal string it is handed (see
    // GetHistoryWorkflowsForPathCommand: `v.value like :variableValue`), so "<path>/%" matches the
    // descendants and "<path>" matches the node itself -- two disjoint sets, which is why the two
    // result lists can simply be concatenated without deduplicating.
    private static List<HistoryWorkflow> collectProcesses(WorkflowService workflowService, String path, Locale locale,
            boolean includeSelf) {
        List<HistoryWorkflow> found = new ArrayList<>(workflowService.getHistoryWorkflowsByPath(path + "/%", locale));
        if (includeSelf) {
            found.addAll(workflowService.getHistoryWorkflowsByPath(path, locale));
        }
        return found;
    }

    // Split out of workflowActivity() above to keep its own cognitive complexity down --
    // one process's currently-available due-dated actions.
    private static void collectActiveTasks(WorkflowService workflowService, HistoryWorkflow process, Locale locale,
            List<GqlWorkflowActivityTask> activeTasks) {
        Workflow active = workflowService.getWorkflow(process.getProvider(), process.getProcessId(), locale);
        if (active == null) {
            return;
        }
        for (WorkflowAction action : active.getAvailableActions()) {
            if (action instanceof WorkflowTask) {
                WorkflowTask task = (WorkflowTask) action;
                if (task.getDueDate() != null) {
                    String label = task.getDisplayName() != null ? task.getDisplayName() : task.getName();
                    // getAssignee() is already a resolved JahiaUser here (unlike the raw principal
                    // paths the history entries carry), so there is nothing to look up.
                    JahiaUser assignee = task.getAssignee();
                    activeTasks.add(new GqlWorkflowActivityTask(label, label, assignee != null ? assignee.getName() : null,
                            task.getDueDate(), null, process.getNodeId()));
                }
            }
        }
    }

    // Split out of workflowActivity() above -- one process's completed task history entries.
    private static void collectHistoryTasks(WorkflowService workflowService, HistoryWorkflow process, Locale locale,
            JCRSessionWrapper session, List<GqlWorkflowActivityTask> history) {
        List<HistoryWorkflowTask> tasks = workflowService.getHistoryWorkflowTasks(
                process.getProcessId(), process.getProvider(), locale);
        for (HistoryWorkflowTask task : tasks) {
            if (task.getEndTime() != null) {
                String label = task.getDisplayOutcome() != null ? task.getDisplayOutcome() : task.getOutcome();
                String stepName = task.getDisplayName() != null ? task.getDisplayName() : task.getName();
                history.add(new GqlWorkflowActivityTask(label, stepName, displayNameOf(session, task.getUser()),
                        null, task.getEndTime(), process.getNodeId()));
            }
        }
    }

    /**
     * The account name behind one of the engine's own user values. Those are JCR principal PATHS
     * (jBPM stores the process's "user" variable and a task's actual-owner id as e.g.
     * "/users/root"), so this is the same resolution {@code GqlTaskBoard#getAssigneeDisplayName}
     * performs -- and it degrades the same way: a value that isn't a readable node path is returned
     * verbatim rather than failing the query, since what the engine recorded is not something this
     * module controls.
     *
     * <p>Resolved HERE rather than lazily inside the Gql type, because this is where the caller's
     * session already is -- the Gql objects are plain value holders that must not have to reopen one.
     */
    private static String displayNameOf(JCRSessionWrapper session, String userValue) {
        if (userValue == null || userValue.isEmpty()) {
            return null;
        }
        try {
            return session.getNode(userValue).getName();
        } catch (PathNotFoundException e) {
            return userValue;
        } catch (RepositoryException e) {
            return userValue;
        }
    }
}
