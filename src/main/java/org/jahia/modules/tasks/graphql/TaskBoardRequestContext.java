package org.jahia.modules.tasks.graphql;

import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.workflow.Workflow;
import org.jahia.services.workflow.WorkflowService;

import javax.jcr.RepositoryException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Everything a single {@code taskBoard} request resolves once and then shares across all of its
 * rows. Created by {@link TaskBoardQueryExtensions#taskBoard} and handed to every
 * {@link GqlTaskBoard} it builds (extending the constructor-injection pattern introduced for the
 * viewer's candidate identifiers in #60).
 *
 * <p>Scope is deliberately one request, never static/global: every value in here is derived from
 * the caller's own JCR session, whose visibility is per-user -- a display name resolved for one
 * viewer is not necessarily resolvable (or even readable) for the next one, and a cross-request
 * cache would leak one user's view of the repository into another's.
 *
 * <p>A row built outside the board query (single-task query, mutation result) gets a context of
 * its own, holding nothing pre-resolved -- see {@link GqlTaskBoard}'s one-argument constructor.
 * Its lifetime is that single row, which is exactly the "one request" scope again.
 *
 * <p>Both maps are synchronized rather than plain HashMaps: graphql-java is free to resolve
 * fields of different rows on different threads, and unlike a ConcurrentHashMap a synchronized
 * map tolerates the null values these lookups legitimately produce (an unresolvable workflow is
 * cached as null so it isn't looked up again for every sibling task of the same process).
 */
final class TaskBoardRequestContext {

    // Resolving this is a membership-cache lookup plus a walk over every site, which has no
    // business running again per row for viewerRole/isAssignableToMe. Resolved eagerly by the
    // board query (which needs it to build the visibility clause anyway); starts out null for a
    // context built around a single standalone row, and is then resolved lazily, once, on first
    // use. volatile because graphql-java may resolve two fields of the same row (viewerRole and
    // isAssignableToMe) on different threads: recomputing the same set twice is harmless,
    // publishing a half-built one is not.
    private volatile Set<String> candidateIdentifiers;

    // userKey (a JCR path for a user or a group) -> display name. Shared by the search filter,
    // the resolved-value sort and the per-row assignee/candidate fields, all of which resolve the
    // same handful of principals over and over across a page of tasks.
    //
    // One map, several QUESTIONS about the same paths: the assignee/start-user fields want the
    // account's node name, the candidate labels want its displayable name (#60). Callers that ask
    // a different question namespace their key -- see GqlTaskBoard#resolveCandidateDisplayName --
    // so a path resolved for one field can't be served back to the other.
    private final Map<String, String> displayNames = Collections.synchronizedMap(new HashMap<>());

    // provider + '|' + processId -> Workflow (nullable). Every workflow task of the same process
    // -- e.g. all the review tasks of one publication -- otherwise repeats the identical
    // WorkflowService#getWorkflow round trip for its workflowSummary.
    private final Map<String, Workflow> workflows = Collections.synchronizedMap(new HashMap<>());

    TaskBoardRequestContext(Set<String> candidateIdentifiers) {
        this.candidateIdentifiers = candidateIdentifiers;
    }

    Set<String> getCandidateIdentifiers(JahiaUser user) {
        if (candidateIdentifiers == null) {
            candidateIdentifiers = TaskAuthorizationService.get().getCandidateIdentifiers(user);
        }
        return candidateIdentifiers;
    }

    /**
     * Memoized {@code memoKey -> display name}. {@code resolver} is only invoked on a miss, so a
     * board page whose 25 rows are all assigned to the same person performs one JCR lookup rather
     * than 25 (and the resolved-value "owner" sort, which extracts a key per row across the whole
     * result set, performs one per distinct assignee rather than one per task).
     *
     * <p>{@code memoKey} is the user key itself for the account-name lookups, and a namespaced
     * form of it for anything resolving the same path a different way (see the field above).
     */
    String displayName(String memoKey, DisplayNameResolver resolver) throws RepositoryException {
        // Not computeIfAbsent: the resolver throws a checked RepositoryException, and a miss here
        // is cheap enough that the get/resolve/put race (two threads resolving the same key to
        // the same value) is harmless.
        String cached = displayNames.get(memoKey);
        if (cached != null) {
            return cached;
        }
        String resolved = resolver.resolve(memoKey);
        displayNames.put(memoKey, resolved);
        return resolved;
    }

    /**
     * Memoized {@link WorkflowService#getWorkflow(String, String, Locale)}. Returns null both for
     * "this process no longer resolves" and for "not looked up yet, and the lookup returned
     * null" -- the negative result is cached too, since a process that vanished for one row has
     * vanished for all its siblings as well.
     */
    Workflow workflow(String provider, String processId, Locale locale, WorkflowService workflowService) {
        String key = provider + '|' + processId + '|' + locale;
        synchronized (workflows) {
            if (workflows.containsKey(key)) {
                return workflows.get(key);
            }
        }
        // (provider, id, locale) -- WorkflowService#getWorkflow is the one method in this API
        // where provider comes FIRST; getWorkflowTask/getHistoryWorkflow both take (id, provider,
        // locale) instead. Getting this backwards throws (provider looked up by an arbitrary
        // process id never matches a registered WorkflowProvider key).
        Workflow workflow = workflowService.getWorkflow(provider, processId, locale);
        workflows.put(key, workflow);
        return workflow;
    }

    /**
     * Lets {@link GqlTaskBoard} keep owning how a principal path actually resolves to a label.
     * Handed the memo key, which the namespacing callers ignore in favour of the path they
     * captured.
     */
    @FunctionalInterface
    interface DisplayNameResolver {
        String resolve(String memoKey) throws RepositoryException;
    }
}
