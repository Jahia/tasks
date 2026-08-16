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
import org.jahia.utils.LanguageCodeConverters;
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
import java.util.Set;
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

    // viewerRole values -- a small closed vocabulary rather than a real GraphQL enum, so adding a
    // role later doesn't break clients that switch on the string.
    private static final String ROLE_ASSIGNEE = "assignee";
    private static final String ROLE_CANDIDATE = "candidate";
    private static final String ROLE_NONE = "none";

    // The single child node jnt:task declares (see definitions.cnd) -- the workflow-specific form
    // data attached to a task, e.g. a jnt:simpleWorkflow.
    private static final String TASK_DATA_NODE = "taskData";

    // Namespace for the candidate "displayable name" entries in the per-request display-name memo,
    // which the account-name lookups share -- see resolveCandidateDisplayName().
    private static final String DISPLAYABLE_NAME_MEMO_PREFIX = "displayable:";

    private final JCRNodeWrapper node;

    // Everything this row shares with the other rows of the same request: the viewer's expanded
    // candidate identifiers (user key/path + group memberships), the userKey -> display name memo
    // and the workflow-process memo. Supplied by TaskBoardQueryExtensions#taskBoard, which builds
    // one per request; a row built outside that path (single-task query, mutation result) gets a
    // context of its own, so the caches still apply within that one row and no branch here has to
    // care whether it has a context at all.
    private final TaskBoardRequestContext context;

    public GqlTaskBoard(JCRNodeWrapper node) {
        this(node, new TaskBoardRequestContext(null));
    }

    GqlTaskBoard(JCRNodeWrapper node, TaskBoardRequestContext context) {
        this.node = node;
        this.context = context;
    }

    private Set<String> candidateIdentifiers(JahiaUser user) {
        return context.getCandidateIdentifiers(user);
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
            String resolvedMacro = Messages.interpolateResourceBundleMacro(matcher.group(), resolveLocale(null), null);
            return title.substring(0, matcher.start()) + resolvedMacro + title.substring(matcher.end());
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task title", e);
        }
    }

    /**
     * The locale a stored label should be resolved in: what the caller explicitly asked for, else
     * the request's own.
     *
     * <p>"The request's own" is two things, in order: the JCR session's locale, which is set when
     * the board is rendered inside a localized page (the server-side render pass), and the ambient
     * request locale otherwise -- a plain GraphQL POST from the client island opens a session with
     * no locale at all, which is exactly the case {@link JahiaLocaleContextHolder} covers. Same
     * chain {@link #getTitle()} has always used, so a row's title and its outcome labels can never
     * come back in two different languages.
     */
    private static Locale resolveLocale(String language) throws RepositoryException {
        if (language != null && !language.isEmpty()) {
            Locale requested = LanguageCodeConverters.languageCodeToLocale(language);
            if (requested != null) {
                return requested;
            }
        }
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        return session.getLocale() != null ? session.getLocale() : JahiaLocaleContextHolder.getLocale();
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

    // No icsUrl field: #66 offered the board a ready-made link to the module's own
    // "<task path>.ics" view, and the product owner dropped that surface again (#65). The VIEW is
    // untouched -- jnt_task/ics/task.jsp and the org.jahia.taglibs imports it needs (pom.xml) are
    // repairs to a shipped view, independent of whether this board links to it.

    @GraphQLField
    @GraphQLDescription("Outcomes this task can be completed with (workflow-specific; empty when none are declared)")
    public List<String> getPossibleOutcomes() {
        return readPossibleOutcomes(node);
    }

    @GraphQLField
    @GraphQLDescription("The same outcomes as possibleOutcomes, in the same order, each with the label to display "
            + "for it -- resolved from the workflow's own resource bundle, which is the only place those labels "
            + "exist (\"accept\" is \"Publish\" in the one-step publication workflow, and something else entirely "
            + "in another workflow). Empty when the task declares no outcomes.")
    public List<GqlTaskOutcome> getPossibleOutcomeDetails(
            @GraphQLName("language")
            @GraphQLDescription("Language code to resolve the labels in (e.g. \"fr\", \"fr_FR\"). Omitting it, or "
                    + "passing one that isn't a language code, resolves them in the request's own locale.")
            String language) {
        List<String> outcomes = readPossibleOutcomes(node);
        if (outcomes.isEmpty()) {
            return Collections.emptyList();
        }
        try {
            Locale locale = resolveLocale(language);
            // Both are jnt:workflowTask properties, absent on a plain jnt:task -- which is also
            // why every lookup below degrades to the raw outcome rather than erroring.
            String taskBundle = node.getPropertyAsString("taskBundle");
            String taskName = node.getPropertyAsString("taskName");
            List<GqlTaskOutcome> details = new ArrayList<>();
            for (String outcome : outcomes) {
                details.add(new GqlTaskOutcome(outcome, resolveOutcomeLabel(taskBundle, taskName, outcome, locale)));
            }
            return details;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task outcome labels", e);
        }
    }

    /**
     * The label a workflow declares for one of its own outcomes, mirroring what the legacy board
     * did with {@code <utility:setBundle basename="${task.properties['taskBundle'].string}">}: look
     * the key {@code <taskName>.<outcome>} up in the workflow's bundle, with every space in either
     * part written as a dot (the bundles are keyed that way -- e.g. {@code review.accept} in
     * org.jahia.modules.defaultmodule.1-step-publication).
     *
     * <p>Then the same two fallbacks it had, in the same order: a second lookup with the outcome
     * lower-cased (the legacy JSP detected the first miss by testing for JSTL's "???key???"
     * placeholder), and finally the raw outcome itself, capitalized -- which is all a plain
     * jnt:task, or a workflow whose bundle has no entry for this outcome, can offer.
     */
    private static String resolveOutcomeLabel(String taskBundle, String taskName, String outcome, Locale locale) {
        if (taskBundle != null && !taskBundle.isEmpty() && taskName != null && !taskName.isEmpty()) {
            String keyPrefix = taskName.replace(' ', '.') + ".";
            String label = Messages.get(taskBundle, keyPrefix + outcome.replace(' ', '.'), locale, null);
            if (label == null) {
                // Locale.ROOT, not the requested locale: this lower-cases a bundle KEY, and the
                // key is the same ASCII string whoever is reading it (in a Turkish locale,
                // "I".toLowerCase() is "ı", which no bundle is keyed on).
                label = Messages.get(taskBundle,
                        keyPrefix + outcome.toLowerCase(Locale.ROOT).replace(' ', '.'), locale, null);
            }
            if (label != null) {
                return label;
            }
        }
        return capitalize(outcome);
    }

    private static String capitalize(String value) {
        if (value == null || value.isEmpty()) {
            return value;
        }
        return value.substring(0, 1).toUpperCase(Locale.ROOT) + value.substring(1);
    }

    @GraphQLField
    @GraphQLDescription("This task's jnt:simpleWorkflow taskData child -- the comment a reviewer can submit with "
            + "their decision. Null when the task has no taskData child at all, or when that child is some other "
            + "node type (a workflow-specific form this board has no editor for).")
    public GqlSimpleWorkflowTaskData getSimpleWorkflowTaskData() {
        try {
            if (!node.hasNode(TASK_DATA_NODE)) {
                return null;
            }
            JCRNodeWrapper taskData = node.getNode(TASK_DATA_NODE);
            if (!taskData.isNodeType("jnt:simpleWorkflow")) {
                return null;
            }
            return new GqlSimpleWorkflowTaskData(taskData.getIdentifier(), taskData.getPropertyAsString("jcr:title"));
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read the task's workflow data", e);
        }
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

    // Shared by getAssigneeDisplayName() and getWorkflowSummary()'s start-user resolution -- both
    // are "a stored user key that should resolve to the account's own name". Candidates take the
    // friendlier route instead (see lookUpDisplayableName below).
    //
    // Memoized per request (#64): the same assignee, the same candidate group and the same
    // workflow start user recur across the rows of a page, and each miss is a JCR node lookup.
    // The memo lives on the request context, never in a static field -- what a userKey resolves
    // to (or whether it resolves at all) is a function of the caller's own session.
    private String resolveUserDisplayName(String userKey) throws RepositoryException {
        return context.displayName(userKey, GqlTaskBoard::lookUpUserDisplayName);
    }

    private static String lookUpUserDisplayName(String userKey) throws RepositoryException {
        try {
            return JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE)
                    .getNode(userKey).getName();
        } catch (PathNotFoundException e) {
            // Not a resolvable node path on this provider/version -- fall back to the raw key
            // rather than erroring, since legacy data may store it in a different format.
            return userKey;
        }
    }

    /**
     * The label to show for one {@code candidates} value (#60): the principal's own DISPLAYABLE
     * name rather than its node name -- {@link JCRNodeWrapper#getDisplayableName()}, which returns
     * the node's {@code jcr:title} when one is set and the node name when it isn't. A group titled
     * "Task testers (trial)" reads as that instead of as "task-testers"; one with no title set
     * (e.g. /sites/&lt;site&gt;/groups/site-administrators on a stock site, verified on the bench)
     * is unchanged, since the fallback IS the node name. Same for user nodes.
     *
     * <p>Deliberately not routed through {@link #lookUpUserDisplayName} even though both take a
     * JCR principal path: the Owner column and the workflow summary name an ACCOUNT ("root"), and
     * are matched against by the board's search/sort (see TaskBoardQueryExtensions), where an
     * editable title is the wrong thing to key on.
     *
     * <p>Memoized on the same per-request map, under a prefixed key: the two lookups answer
     * different questions about the SAME paths (a user can be both this task's assignee and
     * another's candidate), so sharing one key would let whichever field resolved first decide
     * what the other one shows.
     */
    private String resolveCandidateDisplayName(String principalPath) throws RepositoryException {
        // The resolver reads the captured path, not the memo key it is handed -- the key carries
        // the namespace prefix, the lookup must not.
        return context.displayName(DISPLAYABLE_NAME_MEMO_PREFIX + principalPath,
                memoKey -> lookUpDisplayableName(principalPath));
    }

    private static String lookUpDisplayableName(String principalPath) throws RepositoryException {
        try {
            return JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE)
                    .getNode(principalPath).getDisplayableName();
        } catch (PathNotFoundException e) {
            // Same resilience as lookUpUserDisplayName: a value that doesn't resolve to a node
            // this viewer can read is shown verbatim rather than failing the whole row.
            return principalPath;
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

            // Memoized per request (#64): every task of the same workflow process -- all the
            // review tasks of one publication, say -- resolves the identical Workflow, and
            // getWorkflow is a round trip to the workflow engine. The context also documents the
            // argument-order trap in the WorkflowService call it wraps.
            Workflow workflow = context.workflow(provider, task.getProcessId(), locale, workflowService);
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
            return TaskAuthorizationService.get().isOwnerOrCandidate(node, user, candidateIdentifiers(user));
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task assignability", e);
        }
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("The current viewer's relationship to this task: \"assignee\" when they already own it, "
            + "\"candidate\" when they are listed in its candidates (directly, or through one of their groups), "
            + "\"none\" otherwise. Independent of canReviewAll -- a reviewer sees \"none\" on a task they are "
            + "neither assigned nor a candidate for, even though they may still act on it.")
    public String getViewerRole() {
        try {
            JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
            JahiaUser user = session.getUser();
            if (JahiaUserManagerService.isGuest(user)) {
                return ROLE_NONE;
            }
            TaskAuthorizationService authorizationService = TaskAuthorizationService.get();
            if (authorizationService.isAssignee(node, user)) {
                return ROLE_ASSIGNEE;
            }
            if (authorizationService.isCandidate(node, candidateIdentifiers(user))) {
                return ROLE_CANDIDATE;
            }
            return ROLE_NONE;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve the viewer's role on this task", e);
        }
    }

    @GraphQLField
    @GraphQLDescription("Display names of the principals eligible to take this task, resolved from its raw "
            + "candidates values (JCR paths of users and groups alike) to each principal's own displayable name "
            + "-- its jcr:title where one is set, its node name otherwise; a value that doesn't resolve to a node "
            + "the viewer can read is returned as-is. Empty when the task declares no candidates.")
    public List<String> getCandidateDisplayNames() {
        try {
            if (!node.hasProperty("candidates")) {
                return Collections.emptyList();
            }
            List<String> displayNames = new ArrayList<>();
            for (Value candidate : node.getProperty("candidates").getValues()) {
                displayNames.add(resolveCandidateDisplayName(candidate.getString()));
            }
            return displayNames;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task candidate display names", e);
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
