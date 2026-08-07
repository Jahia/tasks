package org.jahia.modules.tasks.graphql;

import org.jahia.osgi.BundleUtils;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.usermanager.JahiaUserManagerService;
import org.osgi.service.component.annotations.Component;

import javax.jcr.RepositoryException;
import javax.jcr.Value;
import java.util.Objects;

/**
 * Single place owning "who may see / act on which task" for the task board,
 * replacing the JSP-side candidate/assignee string-matching in the legacy views.
 *
 * Published as an OSGi service (not a plain utility) because GraphQL extension
 * classes (e.g. {@link TaskBoardQueryExtensions}) are instantiated per-request by
 * graphql-core, not by Declarative Services, so they cannot use &#64;Reference --
 * they look this service up via {@link #get()}.
 */
@Component(service = TaskAuthorizationService.class, immediate = true)
public class TaskAuthorizationService {

    /**
     * Looks up the running OSGi service instance -- the one place every GraphQL extension
     * class in this package resolves it from, instead of each repeating the
     * {@code BundleUtils.getOsgiService} + null-check boilerplate independently.
     */
    public static TaskAuthorizationService get() {
        return Objects.requireNonNull(
                BundleUtils.getOsgiService(TaskAuthorizationService.class, null),
                "TaskAuthorizationService OSGi service is not available");
    }

    /**
     * Returns the session's user, or throws if it's the guest/anonymous user -- the shared
     * "you must be logged in" gate every mutation and non-public query in this module applies.
     */
    public static JahiaUser requireNonGuest(JCRSessionWrapper session) {
        JahiaUser user = session.getUser();
        if (JahiaUserManagerService.isGuest(user)) {
            throw new TaskGraphQLException("You must be logged in to act on tasks");
        }
        return user;
    }

    /**
     * Whether the current user may see every task (Admin/Reviewer), not just
     * their own (Contributor). Uses the JCR "publish" permission on {@code scopeNode}
     * as the reviewer-capability proxy, since publication approval is exactly what
     * "review all tasks" is standing in for here.
     *
     * <p>Known limitation (Phase 4): this checks a single, caller-supplied scope node. Once tasks
     * are queried across multiple sites, this needs to become a per-task (or
     * per-site) check rather than one global grant.
     */
    public boolean canReviewAllTasks(JCRNodeWrapper scopeNode) {
        return scopeNode.hasPermission("publish");
    }

    /**
     * Whether {@code user} owns {@code taskNode} (is its assignee) or is eligible to
     * self-assign it (listed in its {@code candidates}).
     */
    public boolean isOwnerOrCandidate(JCRNodeWrapper taskNode, JahiaUser user) throws RepositoryException {
        String assigneeKey = taskNode.getPropertyAsString("assigneeUserKey");
        if (assigneeKey != null && assigneeKey.equals(user.getUserKey())) {
            return true;
        }

        if (!taskNode.hasProperty("candidates")) {
            return false;
        }

        for (Value candidate : taskNode.getProperty("candidates").getValues()) {
            String candidateValue = candidate.getString();
            if (candidateValue.equals(user.getUserKey()) || candidateValue.equals(user.getLocalPath())) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether {@code user} is the current assignee of {@code taskNode} -- distinct from
     * {@link #isOwnerOrCandidate}, which also admits an eligible-but-not-yet-assigned
     * candidate (the right check for "assign to me"). Owner-restricted actions (suspend,
     * unassign, complete, ...) need this stricter "is actually the assignee" check instead.
     */
    public boolean isAssignee(JCRNodeWrapper taskNode, JahiaUser user) {
        String assigneeKey = taskNode.getPropertyAsString("assigneeUserKey");
        return assigneeKey != null && !assigneeKey.isEmpty() && assigneeKey.equals(user.getUserKey());
    }

    /**
     * Whether {@code user} may perform an owner-restricted action (suspend, unassign,
     * complete, ...) on {@code taskNode}: either they are its assignee, or they hold the
     * review role that already grants visibility into every task on the board.
     */
    public boolean canActOnTask(JCRNodeWrapper taskNode, JahiaUser user, JCRNodeWrapper scopeNode) {
        return isAssignee(taskNode, user) || canReviewAllTasks(scopeNode);
    }
}
