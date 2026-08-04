package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNode;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNodeImpl;
import org.jahia.osgi.BundleUtils;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.usermanager.JahiaUserManagerService;
import org.jahia.utils.i18n.JahiaLocaleContextHolder;
import org.jahia.utils.i18n.Messages;

import javax.jcr.ItemNotFoundException;
import javax.jcr.PathNotFoundException;
import javax.jcr.RepositoryException;
import javax.jcr.Value;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
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
        // Workflow-created tasks store jcr:title as "##resourceBundle(key,bundle)## : <page name>"
        // (see core's JBPMTaskLifeCycleEventListener -- key is the workflow step, e.g. "review";
        // the suffix after "##" is the target content's display name, appended as literal text,
        // not part of the macro). Core's own Messages#interpolateResourceBundleMacro only resolves
        // a macro that is the ENTIRE input (it matches with Matcher#matches()), so it can't be
        // called on this title directly -- it would just return it unchanged, macro and all. This
        // extracts just the "##resourceBundle(...)##" substring, resolves that through the same
        // core utility, and splices the result back into the surrounding literal text. Plain
        // jnt:task titles (no macro at all) pass through unchanged.
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
            return JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE)
                    .getNode(assigneeUserKey).getName();
        } catch (PathNotFoundException e) {
            // assigneeUserKey isn't a resolvable node path on this provider/version -- fall back to the raw key
            // rather than erroring, since legacy data may store it in a different format.
            return assigneeUserKey;
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve assignee display name", e);
        }
    }

    @GraphQLField
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
            TaskAuthorizationService authorizationService = Objects.requireNonNull(
                    BundleUtils.getOsgiService(TaskAuthorizationService.class, null),
                    "TaskAuthorizationService OSGi service is not available");
            return authorizationService.isOwnerOrCandidate(node, user);
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve task assignability", e);
        }
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
