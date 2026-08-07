package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNode;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNodeImpl;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.usermanager.JahiaUserManagerService;
import org.jahia.services.workflow.Workflow;
import org.jahia.services.workflow.WorkflowService;
import org.jahia.services.workflow.WorkflowTask;
import org.jahia.utils.i18n.JahiaLocaleContextHolder;
import org.jahia.utils.i18n.Messages;

import javax.jcr.ItemNotFoundException;
import javax.jcr.PathNotFoundException;
import javax.jcr.RepositoryException;
import javax.jcr.Value;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One row of the task board GraphQL query -- wraps a {@code jnt:task} or
 * {@code jnt:workflowTask} node. Checked JCR exceptions are caught and rethrown
 * unchecked so this type stays usable as a plain stream-mapping target.
 */
@GraphQLDescription("A row of the task board: a jnt:task or jnt:workflowTask node")
public class GqlTaskBoard {

    // Deliberately narrower than core's Messages#RB_MACRO: that pattern is only ever matched
    // with Matcher#matches() (whole-input), so it can't be reused as-is against our titles,
    // which embed the macro followed by literal text (see getTitle()'s javadoc below).
    private static final Pattern RESOURCE_BUNDLE_MACRO = Pattern.compile("##resourceBundle\\([^\"#]*\\)##");

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
        // Workflow-created tasks store jcr:title as a "##resourceBundle##" macro -- taking a
        // resource key and a bundle name as its two arguments -- followed by literal text of the
        // form " : <page name>" (see core's JBPMTaskLifeCycleEventListener -- the key is the
        // workflow step, e.g. "review"; the suffix after the macro is the target content's display
        // name, appended as literal text, not part of the macro itself). Core's own
        // Messages#interpolateResourceBundleMacro only resolves a macro that is the ENTIRE input
        // (it matches with Matcher#matches()), so it can't be called on this title directly -- it
        // would just return it unchanged, macro and all. This extracts just the resource-bundle
        // macro substring, resolves that through the same core utility, and splices the result
        // back into the surrounding literal text. Plain jnt:task titles (no macro at all) pass
        // through unchanged.
        String title = node.getPropertyAsString("jcr:title");
        if (title == null) {
            return null;
        }
        Matcher matcher = RESOURCE_BUNDLE_MACRO.matcher(title);
        if (!matcher.find()) {
            return title;
        }
        try {
            JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
            Locale locale = session.getLocale() != null ? session.getLocale() : JahiaLocaleContextHolder.getLocale();
            String resolvedMacro = Messages.interpolateResourceBundleMacro(matcher.group(), locale, null);
            return title.substring(0, matcher.start()) + resolvedMacro + title.substring(matcher.end());
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task title", e);
        }
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
    @GraphQLDescription("Task description")
    public String getDescription() {
        return node.getPropertyAsString("description");
    }

    @GraphQLField
    @GraphQLDescription("Task priority: low, normal or high")
    public String getPriority() {
        return node.getPropertyAsString("priority");
    }

    @GraphQLField
    @GraphQLDescription("Display name of the current assignee, resolved from assigneeUserKey; null if unassigned "
            + "or the key doesn't resolve to a readable user node")
    public String getAssigneeDisplayName() {
        String assigneeUserKey = node.getPropertyAsString("assigneeUserKey");
        if (assigneeUserKey == null || assigneeUserKey.isEmpty()) {
            return null;
        }
        try {
            return resolveUserDisplayName(assigneeUserKey);
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve assignee display name", e);
        }
    }

    // Shared by getAssigneeDisplayName() and getWorkflowSummary()'s start-user resolution --
    // both are "a JCR user-key property that should resolve to a readable display name".
    private static String resolveUserDisplayName(String userKey) throws RepositoryException {
        try {
            return JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE)
                    .getNode(userKey).getName();
        } catch (PathNotFoundException e) {
            // Not a resolvable node path on this provider/version -- fall back to the raw key
            // rather than erroring, since legacy data may store it in a different format.
            return userKey;
        }
    }

    @GraphQLField
    @GraphQLDescription("Task creation date/time (jcr:created), as an ISO-8601 instant; null if unavailable")
    public String getCreatedDate() {
        try {
            if (!node.hasProperty("jcr:created")) {
                return null;
            }
            return node.getProperty("jcr:created").getDate().toInstant().toString();
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read task creation date", e);
        }
    }

    @GraphQLField
    @GraphQLDescription("One-line workflow summary for a jnt:workflowTask whose process is still live, e.g. "
            + "\"en - One step publication started by anne on 7/20/26 - 1 content items involved\". Null for a "
            + "plain jnt:task (no workflow at all), or if the underlying process can no longer be resolved.")
    public String getWorkflowSummary() {
        try {
            if (!node.hasProperty("provider") || !node.hasProperty("taskId")) {
                // Plain jnt:task -- never had a workflow process to begin with.
                return null;
            }
            Locale locale = JahiaLocaleContextHolder.getLocale();
            String provider = node.getPropertyAsString("provider");
            String taskId = node.getPropertyAsString("taskId");

            WorkflowService workflowService = WorkflowService.getInstance();
            WorkflowTask task = workflowService.getWorkflowTask(taskId, provider, locale);
            if (task == null || task.getWorkflowDefinition() == null) {
                return null;
            }

            // (provider, id, locale) -- WorkflowService#getWorkflow is the one method in this API
            // where provider comes FIRST; getWorkflowTask/getHistoryWorkflow both take (id,
            // provider, locale) instead. Getting this backwards throws (provider looked up by an
            // arbitrary process id never matches a registered WorkflowProvider key).
            Workflow workflow = workflowService.getWorkflow(provider, task.getProcessId(), locale);
            if (workflow == null || workflow.getStartUser() == null || workflow.getStartTime() == null) {
                // WorkflowService returns null once a process instance is no longer live in the
                // jBPM session -- shouldn't normally happen for a task whose process is still
                // open, but isn't guaranteed, so this degrades to "no summary" rather than erroring.
                return null;
            }

            String startUserDisplayName = resolveUserDisplayName(workflow.getStartUser());
            String startDate = DateFormat.getDateInstance(DateFormat.SHORT, locale).format(workflow.getStartTime());
            Object nodeIds = workflow.getVariables() != null ? workflow.getVariables().get("nodeIds") : null;
            int itemCount = nodeIds instanceof List ? ((List<?>) nodeIds).size() : 0;

            return locale.getLanguage() + " - " + task.getWorkflowDefinition().getDisplayName()
                    + " started by " + startUserDisplayName + " on " + startDate
                    + " - " + itemCount + " content items involved";
        } catch (Exception e) {
            // Best-effort enrichment, not core task data: any failure here (a workflow-provider
            // hiccup, a process that vanished between the two lookups above) just means this one
            // summary line is missing from this row, not that the whole board query fails.
            return null;
        }
    }

    @GraphQLField
    @GraphQLName("isAssignableToMe")
    @GraphQLDescription("Whether the current viewer is eligible to self-assign this task (owner-or-candidate), "
            + "independent of canReviewAll -- a reviewer can act on any task regardless of candidacy, but "
            + "\"Assign to me\" for a non-reviewer only makes sense when they're an eligible candidate")
    public boolean isAssignableToMe() {
        try {
            JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
            JahiaUser user = session.getUser();
            if (JahiaUserManagerService.isGuest(user)) {
                return false;
            }
            return TaskAuthorizationService.get().isOwnerOrCandidate(node, user);
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task assignability", e);
        }
    }

    @GraphQLField
    @GraphQLDescription("The page this task is about (e.g. a page pending publication), if any -- resolved to the "
            + "nearest containing page when the workflow's actual target is a sub-node within one (an area's "
            + "content item, e.g. a slider slide or a news entry), since only pages have their own renderable URL")
    public GqlJcrNode getTargetNode() {
        try {
            if (!node.hasProperty("targetNode")) {
                return null;
            }
            JCRNodeWrapper target = (JCRNodeWrapper) node.getProperty("targetNode").getNode();
            JCRNodeWrapper renderable = isRenderablePage(target) ? target : findContainingPage(target);
            if (renderable == null) {
                renderable = target;
            }
            // Re-resolved through a session with an explicit locale: this class's own session
            // (opened without one, see TaskBoardQueryExtensions) makes GqlJcrNodeImpl#getUrl()
            // embed a literal "null" in place of the language segment (the exact same missing-
            // locale issue getTitle() above works around, just surfacing in core's URL builder
            // instead of ours).
            JCRSessionWrapper localizedSession = JCRSessionFactory.getInstance()
                    .getCurrentUserSession(Constants.EDIT_WORKSPACE, JahiaLocaleContextHolder.getLocale());
            return new GqlJcrNodeImpl(localizedSession.getNodeByIdentifier(renderable.getIdentifier()));
        } catch (ItemNotFoundException e) {
            // Weak reference target no longer exists.
            return null;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task target node", e);
        }
    }

    private static boolean isRenderablePage(JCRNodeWrapper node) throws RepositoryException {
        return node.isNodeType("jnt:page") || node.isNodeType("jmix:mainResource");
    }

    // Same walk-up-to-the-nearest-page pattern as core's own NavigationHelper#lookUpParentPageNode
    // (private there, so reimplemented here rather than depended on).
    private static JCRNodeWrapper findContainingPage(JCRNodeWrapper node) throws RepositoryException {
        JCRNodeWrapper parent = node.getParent();
        while (true) {
            if (isRenderablePage(parent)) {
                return parent;
            }
            if ("/".equals(parent.getPath())) {
                return null;
            }
            parent = parent.getParent();
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
