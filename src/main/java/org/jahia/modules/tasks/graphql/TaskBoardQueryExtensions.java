package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import graphql.annotations.connection.GraphQLConnection;
import graphql.schema.DataFetchingEnvironment;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.modules.graphql.provider.dxm.relay.DXPaginatedData;
import org.jahia.modules.graphql.provider.dxm.relay.DXPaginatedDataConnectionFetcher;
import org.jahia.modules.graphql.provider.dxm.relay.PaginationHelper;
import org.jahia.services.content.JCRNodeIteratorWrapper;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.query.QueryWrapper;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.usermanager.JahiaUserManagerService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.jcr.RepositoryException;
import javax.jcr.Value;
import javax.jcr.query.Query;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/**
 * Root {@code taskBoard} query -- consolidates the three duplicated, hand-built
 * JCR-SQL2 queries from the legacy JSPs (currentUserTasks.hidden.load.jsp,
 * taskList.hidden.load.jsp/taskSchedule.jsp, tasksCount.groovy) into one
 * parameterized query, with pagination as real GraphQL (Relay connection) args
 * instead of the legacy list-rendering pipeline.
 *
 * <p>Known limitation (Phase 4): scoped to the whole repository for now (no site/path filter);
 * revisit once the per-site visibility story for jnt:workflowTask is confirmed
 * against a real deployment.
 *
 * <p>Every query here explicitly targets {@link Constants#EDIT_WORKSPACE} rather than using
 * whatever workspace the ambient rendering session happens to be in: jnt:task/jnt:workflowTask
 * data is operational content that only ever lives in the edit/default workspace, never
 * published to live (this is exactly what the legacy JSPs' own {@code currentResource.workspace
 * eq 'live'} branches worked around, by redirecting to a preview/edit-workspace fetch instead of
 * querying directly). A board rendered from a "live" session context would otherwise silently
 * return zero tasks even though they exist.
 *
 * <h2>Two pagination paths (#64)</h2>
 * The board serves a page one of two ways, and which one it takes is purely a performance
 * decision -- the two are required to produce identical rows, order, cursors, hasNextPage and
 * totalCount for the same data:
 * <ul>
 *   <li><b>Query-level slicing</b> (the fast path) when the ordering is a raw JCR property and
 *       there is no {@code search}: the page is cut by the JCR query itself
 *       (setOffset/setLimit), and the total is a second count-only query. Cost is proportional
 *       to the page size, not to the size of the board.</li>
 *   <li><b>Scanning</b> (the original path) when the request needs values that only exist after
 *       the query -- a {@code search} term, or one of the board's own resolved-value sort columns.
 *       Those are filtered/sorted in memory, so the page cannot be delegated to JCR and the whole
 *       result set is walked. Still O(N), by design; see {@link #RESOLVED_VALUE_SORT_FIELDS}.</li>
 * </ul>
 */
@GraphQLTypeExtension(DXGraphQLProvider.Query.class)
public final class TaskBoardQueryExtensions {

    private static final Logger logger = LoggerFactory.getLogger(TaskBoardQueryExtensions.class);

    private TaskBoardQueryExtensions() {
    }

    // Raw JCR-SQL2-orderable properties -- the fallback/default ordering (still applied at the
    // query level) for whichever of these isn't superseded by RESOLVED_VALUE_SORT_FIELDS below.
    private static final List<String> ALLOWED_SORT_PROPERTIES = Arrays.asList(
            "jcr:created", "jcr:lastModified", "dueDate");

    // The board's documented default ordering: newest first (jahia-private#5292). Both halves are
    // stated explicitly here rather than falling out of "no sortBy happens to land on jcr:created"
    // plus "no sortOrder happens to mean descending", so that the default a caller gets when they
    // pass neither argument is a decision this class makes, not an accident of two fallbacks.
    private static final String DEFAULT_SORT_PROPERTY = "jcr:created";
    private static final boolean DEFAULT_ASCENDING = false;

    // The board's own clickable columns (Task Name/Creator/Owner/State) sort by their RESOLVED
    // display value instead, the same way the search filter above matches resolved values rather
    // than raw properties: jcr:title can be a "##resourceBundle(...)##" macro, and
    // assigneeUserKey/jcr:createdBy are paths/user keys -- neither is what's shown (or would sort
    // correctly) in the UI, so these are sorted in-memory, after the query, instead of via
    // JCR-SQL2's "order by".
    private static final String STATE_FIELD = "state";

    private static final Set<String> RESOLVED_VALUE_SORT_FIELDS = new HashSet<>(Arrays.asList(
            "title", "creator", "owner", STATE_FIELD));

    // The board's "mine vs. my group's" split (#61). Deliberately a further NARROWING of the
    // visibility clause each caller already gets, never a widening of it: a contributor stays
    // scoped to what they may see, and a reviewer's "all" stays their full view. Values are plain
    // strings rather than a GraphQL enum, matching sortBy/sortOrder above. The third value, "all",
    // needs no constant of its own: it means "no narrowing", which is also what any unrecognized
    // value degrades to -- see appendScopeFilter.
    private static final String SCOPE_ASSIGNED_TO_ME = "assignedToMe";
    private static final String SCOPE_CLAIMABLE = "claimable";

    // "Nobody has taken this task yet". Two conditions, not one: a task that was never assigned has
    // no assigneeUserKey property at all, while unassignTask writes an empty string back (see
    // TaskBoardMutationExtensions#unassignTask), and JCR-SQL2's "is null" only covers the first.
    // The empty literal is a constant of this class, not caller input, so it needs no bind variable.
    private static final String UNASSIGNED_CONDITION =
            "(task.assigneeUserKey is null or task.assigneeUserKey = '')";

    // An always-false condition that is still valid JCR-SQL2, used when a scope provably matches
    // nothing (see appendScopeFilter). Mirror image of the canReviewAll branch's always-true
    // "jcr:createdBy is not null": every task node has jcr:createdBy.
    private static final String NEVER_MATCHES_CONDITION = "task.[jcr:createdBy] is null";

    @GraphQLField
    @GraphQLConnection(connectionFetcher = DXPaginatedDataConnectionFetcher.class)
    @GraphQLDescription("Paginated task board (jnt:task / jnt:workflowTask), scoped by the caller's role: "
            + "Admin/Reviewer sees every task; a Contributor sees the ones they own, created, or are an "
            + "eligible candidate for (directly or through one of their groups); Public sees nothing")
    public static DXPaginatedData<GqlTaskBoard> taskBoard(
            @GraphQLName("sortBy")
            @GraphQLDescription("Either a board column -- title, creator, owner or state, sorted in-memory by the "
                    + "same resolved value the UI displays -- or one of the raw date properties jcr:created "
                    + "(creation date), jcr:lastModified (last update) or dueDate, sorted by JCR itself. "
                    + "Anything else, including omitting it, falls back to the board default: jcr:created, "
                    + "newest first.")
            String sortBy,
            @GraphQLName("sortOrder")
            @GraphQLDescription("ascending/asc or descending/desc; omitting it means descending, so the default "
                    + "board (no sortBy, no sortOrder) is newest-created first")
            String sortOrder,
            @GraphQLName("filterState")
            @GraphQLDescription("Restrict results to these task states (active, started, finished, suspended)")
            List<String> filterState,
            @GraphQLName("search")
            @GraphQLDescription("Case-insensitive substring match against title, creator, assignee and state; "
                    + "matches if any one of them contains it")
            String search,
            @GraphQLName("scope")
            @GraphQLDescription("Narrows the caller's own visibility further: \"assignedToMe\" keeps only the tasks "
                    + "they are the current assignee of; \"claimable\" keeps only the unassigned tasks they are an "
                    + "eligible candidate for (directly or through one of their groups); \"all\" (the default, and "
                    + "what any unrecognized value falls back to) keeps everything they may see. Applies to "
                    + "reviewers too -- a reviewer with no candidacy of their own gets an empty \"claimable\", "
                    + "since being able to act on every task is not the same as being eligible to take one.")
            String scope,
            DataFetchingEnvironment environment) throws RepositoryException {

        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        JahiaUser user = session.getUser();
        PageArguments pageArguments = PageArguments.parse(environment);

        // Built here and not where it is used, because constructing it is also how the pagination
        // arguments get validated: core rejects a negative first/last/offset/limit, and rejects
        // mixing offset/limit with the cursor arguments, from this constructor. Building it up
        // front keeps those errors identical whichever path ends up serving the request -- the
        // fast path below never reaches core's pagination at all.
        PaginationHelper.Arguments coreArguments = pageArguments.toCoreArguments();

        // Public / guest: no visibility at all.
        if (JahiaUserManagerService.isGuest(user)) {
            return PaginationHelper.paginate(Stream.empty(), n -> "", coreArguments);
        }

        TaskAuthorizationService authorizationService = TaskAuthorizationService.get();
        boolean canReviewAll = authorizationService.canReviewAllTasks(session.getNode("/"));

        // Expanded once here and handed to every row below (see GqlTaskBoard's constructor):
        // resolving it is a membership-cache lookup plus a walk over every site, which has no
        // business running again per row for viewerRole/isAssignableToMe. It travels inside the
        // per-request context, together with the display-name and workflow memos every row of
        // this one page shares (#64).
        Set<String> candidateIdentifiers = authorizationService.getCandidateIdentifiers(user);
        TaskBoardRequestContext context = new TaskBoardRequestContext(candidateIdentifiers);

        QueryPlan plan = buildQueryPlan(session, user, canReviewAll, candidateIdentifiers, filterState,
                sortBy, sortOrder, scope);

        // The two values below are what decides between the two pagination paths: both force rows
        // to be filtered/sorted after the query, on values JCR-SQL2 never saw, so neither can be
        // delegated to setOffset/setLimit.
        boolean hasSearch = search != null && !search.trim().isEmpty();
        boolean sortsOnResolvedValue = RESOLVED_VALUE_SORT_FIELDS.contains(sortBy);

        if (!hasSearch && !sortsOnResolvedValue) {
            DXPaginatedData<GqlTaskBoard> page = slicedPage(session, plan, pageArguments, context);
            if (page != null) {
                return page;
            }
            // Fell through: this particular combination of pagination arguments can't be
            // expressed as an offset (see slicedPage). Serve it by scanning instead -- slower,
            // but the two paths agree on what they return.
        }
        return scannedPage(session, plan, coreArguments, context, search, sortBy);
    }

    // ------------------------------------------------------------------------------------------
    // Fast path: let JCR cut the page
    // ------------------------------------------------------------------------------------------

    /**
     * The page, sliced by the JCR query itself, or null when these pagination arguments can't be
     * turned into an offset -- in which case the caller falls back to {@link #scannedPage}.
     *
     * <p>Returning null rather than throwing is the whole safety story here: every case this
     * method isn't sure about (backwards paging, an unbounded page, a cursor it can't place, a
     * cursor whose row has moved) is handed back to the path that was always able to serve it.
     */
    private static DXPaginatedData<GqlTaskBoard> slicedPage(JCRSessionWrapper session, QueryPlan plan,
            PageArguments arguments, TaskBoardRequestContext context) throws RepositoryException {

        // Backwards paging (last/before) is defined relative to the END of the result set, which
        // an offset can't express without knowing the total first. Left to the scanning path.
        if (arguments.last != null || arguments.before != null) {
            return null;
        }
        Integer pageSize = arguments.pageSize();
        if (pageSize == null) {
            // No first/limit: the caller asked for the entire board, so there is no page to cut.
            return null;
        }
        // Past core's node limit it stops the query and reports a truncated result; that guard
        // only exists on the scanning path, so hand oversized pages back to it rather than
        // quietly serving something core would have refused.
        if (pageSize > PaginationHelper.getNodeLimit() - 2) {
            return null;
        }

        String cursorIdentifier = null;
        int firstRow;
        int startOffset;
        if (arguments.after != null) {
            int cursorIndex = TaskBoardPage.indexOf(arguments.after);
            if (cursorIndex < 0) {
                // A bare-identifier cursor (issued by the scanning path, or by a build from
                // before cursors carried an index): its position is unknown without a scan.
                return null;
            }
            cursorIdentifier = TaskBoardPage.identifierOf(arguments.after);
            // Start one row EARLIER than the page, on the cursor's own row, so that the offset
            // can be verified against the identifier the cursor carries before it is trusted.
            firstRow = cursorIndex;
            startOffset = cursorIndex + 1;
        } else {
            // offset/limit and the cursor arguments are mutually exclusive -- core rejects the
            // combination outright when the Arguments were built -- so reaching here means there
            // is no cursor and offset is the only thing that can move the window.
            firstRow = arguments.offset != null ? arguments.offset : 0;
            startOffset = firstRow;
        }

        // One extra row to answer hasNextPage without a second query, plus -- when resuming from
        // a cursor -- the cursor's own row, which is dropped again below.
        int fetchCount = pageSize + 1 + (cursorIdentifier != null ? 1 : 0);
        List<GqlTaskBoard> rows = executePage(session, plan, firstRow, fetchCount, context);

        if (cursorIdentifier != null) {
            if (rows.isEmpty() || !cursorIdentifier.equals(rows.get(0).getId())) {
                // Rows were inserted or removed since this cursor was issued, so its index no
                // longer points at its own row. Rather than silently serving a shifted (or empty)
                // page, fall back to the scanning path, which finds the row by identifier.
                logger.debug("taskBoard cursor index {} no longer holds node {}, falling back to a full scan",
                        firstRow, cursorIdentifier);
                return null;
            }
            rows.remove(0);
        }

        boolean hasNextPage = rows.size() > pageSize;
        int totalCount;
        if (hasNextPage) {
            rows = new ArrayList<>(rows.subList(0, pageSize));
            totalCount = countAll(session, plan);
            if (totalCount < 0) {
                // getSize() is allowed to say "I don't know"; counting by hand is exactly what the
                // scanning path does anyway.
                return null;
            }
        } else {
            // The probe row came back empty, so there is nothing past this page and the total is
            // already known: everything skipped, plus everything on the page. Worth the branch --
            // it keeps a board that fits on one page (the common case for a contributor, whose
            // visibility clause usually matches a handful of rows) down to a single query, which
            // is what it cost before any of this existed.
            totalCount = startOffset + rows.size();
        }
        return new TaskBoardPage(rows, startOffset, totalCount, startOffset > 0, hasNextPage);
    }

    private static List<GqlTaskBoard> executePage(JCRSessionWrapper session, QueryPlan plan, int offset,
            int limit, TaskBoardRequestContext context) throws RepositoryException {
        long startedAt = System.nanoTime();
        QueryWrapper query = plan.createOrderedQuery(session);
        query.setOffset(offset);
        query.setLimit(limit);
        JCRNodeIteratorWrapper nodes = query.execute().getNodes();
        List<GqlTaskBoard> rows = new ArrayList<>();
        while (nodes.hasNext()) {
            rows.add(new GqlTaskBoard((JCRNodeWrapper) nodes.next(), context));
        }
        if (logger.isDebugEnabled()) {
            logger.debug("taskBoard sliced page: offset={} limit={} materialized={} rows in {} ms",
                    offset, limit, rows.size(), elapsedMs(startedAt));
        }
        return rows;
    }

    /**
     * The total number of rows the board's WHERE clause matches, as reported by the result
     * iterator rather than by walking it. Jahia applies read-permission filtering inside the
     * index rather than while iterating, so this count is the exact number of rows this caller
     * would have been able to see -- not an upper bound. The ordering is deliberately left off
     * the statement: a count doesn't depend on it, and sorting is a real cost on a large result.
     */
    private static int countAll(JCRSessionWrapper session, QueryPlan plan) throws RepositoryException {
        long startedAt = System.nanoTime();
        long size = plan.createCountQuery(session).execute().getNodes().getSize();
        if (logger.isDebugEnabled()) {
            logger.debug("taskBoard count query: totalCount={} in {} ms", size, elapsedMs(startedAt));
        }
        if (size < 0) {
            return -1;
        }
        return size > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) size;
    }

    // ------------------------------------------------------------------------------------------
    // Scanning path: filter/sort in memory, then let core paginate the stream
    // ------------------------------------------------------------------------------------------

    private static DXPaginatedData<GqlTaskBoard> scannedPage(JCRSessionWrapper session, QueryPlan plan,
            PaginationHelper.Arguments arguments, TaskBoardRequestContext context, String search, String sortBy)
            throws RepositoryException {

        long startedAt = System.nanoTime();
        JCRNodeIteratorWrapper nodes = plan.createOrderedQuery(session).execute().getNodes();
        Stream<GqlTaskBoard> stream = StreamSupport.stream(nodes.spliterator(), false)
                .map(node -> new GqlTaskBoard(node, context));

        // Not part of the JCR-SQL2 statement above: title/assignee are resolved values (the
        // stored jcr:title can be a "##resourceBundle(...)##" macro, and assigneeUserKey is a
        // path, neither of which is what the search box's placeholder promises to match against),
        // so this filters the same per-row values getTitle()/getAssigneeDisplayName() already
        // compute for display, after the JCR query, rather than against the raw stored properties.
        stream = applySearch(stream, search);

        if (RESOLVED_VALUE_SORT_FIELDS.contains(sortBy)) {
            // Comparator.comparing(valueOf, ...) would call valueOf on every pairwise comparison
            // during the sort (O(n log n) calls) -- for "owner" that's a repeated JCR node lookup
            // (getAssigneeDisplayName) per comparison for the same n values. Computing each
            // element's sort key once up front (a Schwartzian transform) makes the extractor run
            // exactly once per row instead.
            Function<GqlTaskBoard, String> valueOf = resolvedValueExtractor(sortBy);
            Comparator<String> keyComparator = resolvedValueComparator(plan.ascending);
            stream = stream.map(task -> new AbstractMap.SimpleEntry<>(valueOf.apply(task), task))
                    .sorted(Comparator.comparing(Map.Entry::getKey, keyComparator))
                    .map(Map.Entry::getValue);
        }

        if (logger.isDebugEnabled()) {
            // Logged before the stream is consumed: this path is lazy, so what is measured here
            // is only the JCR query itself -- the per-row cost lands on core's paginate() below.
            logger.debug("taskBoard full scan (search={}, resolved-value sort={}): query executed in {} ms",
                    search != null && !search.trim().isEmpty(), RESOLVED_VALUE_SORT_FIELDS.contains(sortBy),
                    elapsedMs(startedAt));
        }

        // Core is given, and matches on, bare identifier cursors -- the format this query has
        // always emitted -- so it keeps locating a row by identity rather than by position. The
        // wrapper only re-publishes each cursor with the row's index attached, so that a client
        // coming off this path can go back to the sliced one on its next page.
        DXPaginatedData<GqlTaskBoard> page = TaskBoardPage.withIndexedCursors(PaginationHelper.paginate(
                stream, task -> TaskBoardPage.encodeCursor(task.getId()), arguments));
        if (logger.isDebugEnabled()) {
            // getTotalCount() is what drains the rest of the stream, so this line reports the real
            // cost of the scan -- and, on debug only, forces that drain even for a caller that
            // never asked for totalCount. That is the measurement being switched on, not a side
            // effect of it: at info level nothing here runs.
            logger.debug("taskBoard full scan: {} rows on the page, {} rows matched, {} ms total",
                    page.getNodesCount(), page.getTotalCount(), elapsedMs(startedAt));
        }
        return page;
    }

    // Split out of taskBoard() above -- the search box's case-insensitive substring match against
    // every resolved (not raw-property) value the board displays.
    private static Stream<GqlTaskBoard> applySearch(Stream<GqlTaskBoard> stream, String search) {
        if (search == null || search.trim().isEmpty()) {
            return stream;
        }
        String needle = search.trim().toLowerCase();
        return stream.filter(task -> containsIgnoreCase(task.getTitle(), needle)
                || containsIgnoreCase(task.getCreator(), needle)
                || containsIgnoreCase(task.getAssigneeDisplayName(), needle)
                || containsIgnoreCase(task.getState(), needle));
    }

    private static boolean containsIgnoreCase(String value, String lowercaseNeedle) {
        return value != null && value.toLowerCase().contains(lowercaseNeedle);
    }

    private static Function<GqlTaskBoard, String> resolvedValueExtractor(String sortBy) {
        switch (sortBy) {
            case "title":
                return GqlTaskBoard::getTitle;
            case "creator":
                return GqlTaskBoard::getCreator;
            case "owner":
                return GqlTaskBoard::getAssigneeDisplayName;
            case STATE_FIELD:
                return GqlTaskBoard::getState;
            default:
                // Unreachable: only called when RESOLVED_VALUE_SORT_FIELDS.contains(sortBy).
                throw new IllegalArgumentException("Not a resolved-value sort field: " + sortBy);
        }
    }

    // Case-insensitive, with nulls sorted last regardless of direction (an unassigned owner or
    // blank creator/title should always fall to the bottom, not jump to the top on "descending").
    private static Comparator<String> resolvedValueComparator(boolean ascending) {
        Comparator<String> direction = ascending ? String.CASE_INSENSITIVE_ORDER : String.CASE_INSENSITIVE_ORDER.reversed();
        return Comparator.nullsLast(direction);
    }

    private static long elapsedMs(long startedAtNanos) {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    // ------------------------------------------------------------------------------------------
    // Statement building
    // ------------------------------------------------------------------------------------------

    /**
     * The board's JCR-SQL2 statement, split in two so the same WHERE clause and the same bind
     * values can be reused for the page query and for the count query without rebuilding either.
     */
    private static final class QueryPlan {
        private final String selection;
        private final String orderBy;
        private final List<String> bindNames;
        private final List<Value> bindValues;
        private final boolean ascending;

        private QueryPlan(String selection, String orderBy, List<String> bindNames, List<Value> bindValues,
                boolean ascending) {
            this.selection = selection;
            this.orderBy = orderBy;
            this.bindNames = bindNames;
            this.bindValues = bindValues;
            this.ascending = ascending;
        }

        QueryWrapper createOrderedQuery(JCRSessionWrapper session) throws RepositoryException {
            return create(session, selection + orderBy);
        }

        QueryWrapper createCountQuery(JCRSessionWrapper session) throws RepositoryException {
            return create(session, selection);
        }

        private QueryWrapper create(JCRSessionWrapper session, String statement) throws RepositoryException {
            QueryWrapper query = session.getWorkspace().getQueryManager().createQuery(statement, Query.JCR_SQL2);
            for (int i = 0; i < bindNames.size(); i++) {
                query.bindValue(bindNames.get(i), bindValues.get(i));
            }
            return query;
        }
    }

    private static QueryPlan buildQueryPlan(JCRSessionWrapper session, JahiaUser user, boolean canReviewAll,
            Set<String> candidateIdentifiers, List<String> filterState, String sortBy, String sortOrder, String scope)
            throws RepositoryException {

        List<String> bindNames = new ArrayList<>();
        List<Value> bindValues = new ArrayList<>();
        StringBuilder statement = new StringBuilder("select * from [jnt:task] as task where ");

        if (canReviewAll) {
            // Always-true condition -- every task node has jcr:createdBy -- so an
            // Admin/Reviewer's WHERE clause stays valid JCR-SQL2 with no owner scoping.
            statement.append("task.[jcr:createdBy] is not null");
        } else {
            statement.append("(task.assigneeUserKey = $userKey or task.[jcr:createdBy] = $userName");
            bindNames.add("userKey");
            bindValues.add(session.getValueFactory().createValue(user.getUserKey()));
            bindNames.add("userName");
            bindValues.add(session.getValueFactory().createValue(user.getName()));
            appendCandidateFilter(statement, candidateIdentifiers, bindNames, bindValues, session);
            statement.append(")");
        }

        // Composed INTO the statement rather than applied to the rows afterwards, so that a scoped
        // board still takes the query-level fast path (#64) instead of falling back to a scan.
        appendScopeFilter(statement, scope, user, candidateIdentifiers, bindNames, bindValues, session);

        appendStateFilter(statement, filterState, bindNames, bindValues, session);

        boolean ascending = resolveAscending(sortOrder);

        // Sort target is an identifier, not a value -- bind variables can't parameterize it, so
        // it's constrained to a fixed allow-list instead (jahia-injection-defense). When sortBy
        // is one of the board's own columns (RESOLVED_VALUE_SORT_FIELDS), this default JCR-level
        // order is just the stable pre-sort the in-memory sort re-sorts on top of -- it still
        // needs to be *some* deterministic order for that stable sort to be meaningful.
        String orderProperty = ALLOWED_SORT_PROPERTIES.contains(sortBy) ? sortBy : DEFAULT_SORT_PROPERTY;
        String orderBy = " order by task.[" + orderProperty + "] " + (ascending ? "asc" : "desc");

        return new QueryPlan(statement.toString(), orderBy, bindNames, bindValues, ascending);
    }

    // Omitting sortOrder means descending, which is what makes the board's documented default
    // (no sortBy either) newest-created first; anything that isn't recognisably "ascending" is
    // descending too, so an unknown value degrades to the default rather than to an error.
    private static boolean resolveAscending(String sortOrder) {
        if (sortOrder == null) {
            return DEFAULT_ASCENDING;
        }
        return "asc".equalsIgnoreCase(sortOrder) || "ascending".equalsIgnoreCase(sortOrder);
    }

    // Split out of buildQueryPlan() above -- appends "or task.candidates = $candidate0 or ..." to
    // the non-reviewer visibility clause, one bind variable per identifier the viewer can be
    // listed under (their own user key/path plus every group they belong to, see
    // TaskAuthorizationService#getCandidateIdentifiers).
    private static void appendCandidateFilter(StringBuilder statement, Set<String> candidateIdentifiers,
            List<String> bindNames, List<Value> bindValues, JCRSessionWrapper session) throws RepositoryException {
        String matches = candidateMatches(candidateIdentifiers, "candidate", bindNames, bindValues, session);
        if (!matches.isEmpty()) {
            statement.append(" or ").append(matches);
        }
    }

    /**
     * {@code task.candidates = $prefix0 or task.candidates = $prefix1 or ...}, one equality per
     * identifier the viewer can be listed under, with every value registered as a bind variable.
     * Empty when the viewer has no candidate identifier at all -- callers decide what that means.
     *
     * <p>{@code task.candidates = $x} is a match-any-value comparison on the multivalued
     * {@code candidates} property in JCR-SQL2, so one equality per identifier is all that's needed
     * -- exactly the or-chain the legacy JSPs built by hand, except every value is bound rather
     * than string-concatenated into the statement (jahia-injection-defense). The bind-name prefix
     * exists because the visibility clause and the {@code claimable} scope filter can both need
     * this chain in the same statement, and a bind name may only be declared once.
     */
    private static String candidateMatches(Set<String> candidateIdentifiers, String bindPrefix,
            List<String> bindNames, List<Value> bindValues, JCRSessionWrapper session) throws RepositoryException {
        StringBuilder matches = new StringBuilder();
        int index = 0;
        for (String identifier : candidateIdentifiers) {
            if (index > 0) {
                matches.append(" or ");
            }
            String bindName = bindPrefix + index++;
            matches.append("task.candidates = $").append(bindName);
            bindNames.add(bindName);
            bindValues.add(session.getValueFactory().createValue(identifier));
        }
        return matches.toString();
    }

    /**
     * Split out of buildQueryPlan() above -- the {@code scope} argument's "and (...)", narrowing
     * whatever the visibility clause already allows down to the viewer's own slice of it.
     *
     * <ul>
     *   <li>{@code assignedToMe}: the tasks they currently hold. Note this is the assignee, not
     *       "owner-or-candidate" -- a task merely offered to them is not one of theirs yet.</li>
     *   <li>{@code claimable}: the ones they could take, i.e. listed as a candidate AND still
     *       unassigned. A viewer with no candidate identifier at all (only really possible for a
     *       principal with no identity to match on) gets a provably empty board rather than an
     *       unconstrained one -- the same conservative direction as the rest of this clause.</li>
     *   <li>anything else, including null: no narrowing.</li>
     * </ul>
     */
    private static void appendScopeFilter(StringBuilder statement, String scope, JahiaUser user,
            Set<String> candidateIdentifiers, List<String> bindNames, List<Value> bindValues,
            JCRSessionWrapper session) throws RepositoryException {

        if (SCOPE_ASSIGNED_TO_ME.equals(scope)) {
            statement.append(" and task.assigneeUserKey = $scopeUserKey");
            bindNames.add("scopeUserKey");
            bindValues.add(session.getValueFactory().createValue(user.getUserKey()));
            return;
        }
        if (!SCOPE_CLAIMABLE.equals(scope)) {
            // "all", null, or an unrecognized value: the board stays exactly as wide as the
            // caller's own visibility clause made it.
            return;
        }
        String matches = candidateMatches(candidateIdentifiers, "scopeCandidate", bindNames, bindValues, session);
        if (matches.isEmpty()) {
            statement.append(" and ").append(NEVER_MATCHES_CONDITION);
            return;
        }
        statement.append(" and (").append(matches).append(")").append(" and ").append(UNASSIGNED_CONDITION);
    }

    // Split out of buildQueryPlan() above to keep its own cognitive complexity down -- appends the
    // "and (task.state = $state0 or task.state = $state1 or ...)" clause plus its bind values,
    // one bind variable per requested state (identical bind-by-value approach as the userKey/
    // userName scoping above, so a state value can never be interpreted as SQL).
    private static void appendStateFilter(StringBuilder statement, List<String> filterState,
            List<String> bindNames, List<Value> bindValues, JCRSessionWrapper session) throws RepositoryException {
        if (filterState == null || filterState.isEmpty()) {
            return;
        }
        statement.append(" and (");
        for (int i = 0; i < filterState.size(); i++) {
            if (i > 0) {
                statement.append(" or ");
            }
            String bindName = STATE_FIELD + i;
            statement.append("task.state = $").append(bindName);
            bindNames.add(bindName);
            bindValues.add(session.getValueFactory().createValue(filterState.get(i)));
        }
        statement.append(")");
    }

    // ------------------------------------------------------------------------------------------
    // Pagination arguments
    // ------------------------------------------------------------------------------------------

    /**
     * The connection's pagination arguments, read straight off the {@link DataFetchingEnvironment}
     * the same way {@link PaginationHelper#parseArguments} does.
     *
     * <p>They are re-read here rather than taken from core's own {@code PaginationHelper.Arguments}
     * because that type exposes no accessors -- it can be built and handed back to core, but not
     * inspected, and the fast path has to inspect them to decide whether it can serve the request.
     */
    private static final class PageArguments {
        private final String before;
        private final String after;
        private final Integer first;
        private final Integer last;
        private final Integer offset;
        private final Integer limit;

        private PageArguments(String before, String after, Integer first, Integer last, Integer offset,
                Integer limit) {
            this.before = before;
            this.after = after;
            this.first = first;
            this.last = last;
            this.offset = offset;
            this.limit = limit;
        }

        static PageArguments parse(DataFetchingEnvironment environment) {
            return new PageArguments(
                    environment.getArgument("before"),
                    environment.getArgument("after"),
                    environment.getArgument("first"),
                    environment.getArgument("last"),
                    environment.getArgument("offset"),
                    environment.getArgument("limit"));
        }

        /**
         * How many rows the page holds. Null means "no page size at all", i.e. the caller wants
         * every matching row -- which the fast path has nothing to slice and hands to the
         * scanning path instead.
         *
         * <p>{@code first} and {@code limit} belong to the two mutually exclusive argument styles
         * and core refuses requests that mix them, so in practice only one is ever set; the
         * smaller-wins tie-break just matches what core's own collect loop would do (it stops on
         * whichever of the two caps is reached first) rather than picking arbitrarily.
         */
        Integer pageSize() {
            if (limit != null && first != null) {
                return Math.min(limit, first);
            }
            return limit != null ? limit : first;
        }

        /**
         * The same arguments in the shape core's pagination wants, with any index-bearing cursor
         * normalized back to the bare identifier the scanning path matches on -- so a client that
         * starts searching, or switches to a resolved-value sort, in the middle of paginating
         * still resumes from the row its cursor names instead of losing its place. A cursor that
         * doesn't decode at all is passed through untouched: it matched nothing before this
         * normalization existed and it still matches nothing, which is the same empty page.
         */
        PaginationHelper.Arguments toCoreArguments() {
            return new PaginationHelper.Arguments(toIdentifierCursor(before), toIdentifierCursor(after),
                    first, last, offset, limit);
        }

        private static String toIdentifierCursor(String cursor) {
            String identifier = TaskBoardPage.identifierOf(cursor);
            return identifier == null ? cursor : TaskBoardPage.encodeCursor(identifier);
        }
    }

    // ------------------------------------------------------------------------------------------

    @GraphQLField
    @GraphQLDescription("A single task by id, for the task detail view (jnt:task's own page). Visibility is "
            + "governed by the normal JCR read permission on the node -- no board-style RBAC scoping applies here, "
            + "since viewing a task you already have a direct path/id to is a different concern than the "
            + "aggregated board's owner-scoped listing")
    public static GqlTaskBoard task(@GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        JCRNodeWrapper node = session.getNodeByIdentifier(id);
        if (!node.isNodeType("jnt:task")) {
            throw new TaskGraphQLException("Node " + id + " is not a task");
        }
        return new GqlTaskBoard(node);
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("The current viewer's user key. Client-side UI uses this to decide which row actions to "
            + "show; every mutation independently re-checks authorization server-side regardless of this value.")
    public static String taskBoardCurrentUserKey() throws RepositoryException {
        return JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE).getUser().getUserKey();
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("Whether the current viewer can act on every task on the board, not just their own")
    public static boolean taskBoardCanReviewAll() throws RepositoryException {
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        return TaskAuthorizationService.get().canReviewAllTasks(session.getNode("/"));
    }
}
