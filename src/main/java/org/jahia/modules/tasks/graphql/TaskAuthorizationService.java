package org.jahia.modules.tasks.graphql;

import org.jahia.osgi.BundleUtils;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaGroupManagerService;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.usermanager.JahiaUserManagerService;
import org.osgi.service.component.annotations.Component;

import javax.jcr.RepositoryException;
import javax.jcr.Value;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

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
     * Every identifier under which {@code user} can legitimately appear in a task's
     * {@code candidates} property: their own user identity, plus every group they are a
     * member of (transitively -- {@code getMembershipByPath} already flattens nested groups).
     *
     * <p>Format: {@code candidates} stores JCR paths, for both kinds of principal. Core writes
     * that property in JBPMTaskLifeCycleEventListener#createTask from
     * {@code JahiaGroup#getGroupKey()} / {@code JahiaUser#getUserKey()}, and in Jahia 8 both of
     * those return the principal's JCR path (JahiaGroupImpl/JahiaUserImpl return their {@code path}
     * field verbatim) -- e.g. {@code /users/jb/ac/eh/pam}, {@code /groups/administrators},
     * {@code /sites/luxe/groups/site-administrators}. That is the same shape
     * {@link JahiaGroupManagerService#getMembershipByPath} returns, so group memberships can be
     * matched against candidate values directly, with no key/path translation. Both
     * {@code getUserKey()} and {@code getLocalPath()} are added because the two are only
     * guaranteed to coincide for the default JCR user provider -- a custom provider may key its
     * users differently from where they are mounted in the JCR.
     *
     * <p>This restores what the legacy JSPs did via {@code user:getUserMembership} (whose map keys
     * are exactly these membership paths), with one deliberate difference: that taglib drops the
     * built-in "everyone" groups (paths ending in {@code /guest}, {@code /users},
     * {@code /site-users}) because it exists to render a user's *interesting* group list. Those
     * are real memberships, so they are kept here -- a task that explicitly lists {@code
     * /groups/users} among its candidates is one whose workflow role was granted to all users, and
     * dropping it would silently deny a candidacy the administrator did grant.
     */
    public Set<String> getCandidateIdentifiers(JahiaUser user) {
        if (user == null || JahiaUserManagerService.isGuest(user)) {
            return Collections.emptySet();
        }
        // Insertion-ordered so the generated bind-variable order (and therefore the query string)
        // is stable for a given user, which keeps JCR's parsed-query cache effective.
        Set<String> identifiers = new LinkedHashSet<>();
        addIfNotBlank(identifiers, user.getUserKey());
        addIfNotBlank(identifiers, user.getLocalPath());

        List<String> memberships = JahiaGroupManagerService.getInstance().getMembershipByPath(user.getLocalPath());
        if (memberships != null) {
            for (String membership : memberships) {
                addIfNotBlank(identifiers, membership);
            }
        }
        return identifiers;
    }

    private static void addIfNotBlank(Set<String> identifiers, String value) {
        if (value != null && !value.isEmpty()) {
            identifiers.add(value);
        }
    }

    /**
     * Whether {@code taskNode} lists any of {@code candidateIdentifiers} (the caller-supplied
     * result of {@link #getCandidateIdentifiers}) among its {@code candidates}.
     *
     * <p>Takes the already-expanded set rather than a {@link JahiaUser} so a caller iterating many
     * task rows expands the viewer's group membership once for the whole request instead of once
     * per row -- {@link #getCandidateIdentifiers} hits the membership cache and, for a global user,
     * additionally walks every site.
     */
    public boolean isCandidate(JCRNodeWrapper taskNode, Set<String> candidateIdentifiers) throws RepositoryException {
        if (candidateIdentifiers == null || candidateIdentifiers.isEmpty() || !taskNode.hasProperty("candidates")) {
            return false;
        }
        for (Value candidate : taskNode.getProperty("candidates").getValues()) {
            if (candidateIdentifiers.contains(candidate.getString())) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether {@code user} owns {@code taskNode} (is its assignee) or is eligible to
     * self-assign it (listed in its {@code candidates}, directly or through one of their groups).
     */
    public boolean isOwnerOrCandidate(JCRNodeWrapper taskNode, JahiaUser user) throws RepositoryException {
        return isOwnerOrCandidate(taskNode, user, getCandidateIdentifiers(user));
    }

    /**
     * {@link #isOwnerOrCandidate(JCRNodeWrapper, JahiaUser)} against a pre-computed identifier set,
     * for callers that already expanded it once for the whole request.
     */
    public boolean isOwnerOrCandidate(JCRNodeWrapper taskNode, JahiaUser user, Set<String> candidateIdentifiers)
            throws RepositoryException {
        String assigneeKey = taskNode.getPropertyAsString("assigneeUserKey");
        if (assigneeKey != null && assigneeKey.equals(user.getUserKey())) {
            return true;
        }
        return isCandidate(taskNode, candidateIdentifiers);
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
