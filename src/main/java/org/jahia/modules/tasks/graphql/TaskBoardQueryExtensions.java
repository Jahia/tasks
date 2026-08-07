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
 */
@GraphQLTypeExtension(DXGraphQLProvider.Query.class)
public final class TaskBoardQueryExtensions {

    private TaskBoardQueryExtensions() {
    }

    // Raw JCR-SQL2-orderable properties -- the fallback/default ordering (still applied at the
    // query level) for whichever of these isn't superseded by RESOLVED_VALUE_SORT_FIELDS below.
    private static final List<String> ALLOWED_SORT_PROPERTIES = Arrays.asList(
            "jcr:created", "jcr:lastModified", "dueDate");

    // The board's own clickable columns (Task Name/Creator/Owner/State) sort by their RESOLVED
    // display value instead, the same way the search filter above matches resolved values rather
    // than raw properties: jcr:title can be a "##resourceBundle(...)##" macro, and
    // assigneeUserKey/jcr:createdBy are paths/user keys -- neither is what's shown (or would sort
    // correctly) in the UI, so these are sorted in-memory, after the query, instead of via
    // JCR-SQL2's "order by".
    private static final String STATE_FIELD = "state";

    private static final Set<String> RESOLVED_VALUE_SORT_FIELDS = new HashSet<>(Arrays.asList(
            "title", "creator", "owner", STATE_FIELD));

    @GraphQLField
    @GraphQLConnection(connectionFetcher = DXPaginatedDataConnectionFetcher.class)
    @GraphQLDescription("Paginated task board (jnt:task / jnt:workflowTask), scoped by the caller's role: "
            + "Admin/Reviewer sees every task, Contributor sees only their own, Public sees nothing")
    public static DXPaginatedData<GqlTaskBoard> taskBoard(
            @GraphQLName("sortBy")
            @GraphQLDescription("Either a board column -- title, creator, owner or state, sorted by the same "
                    + "resolved value the UI displays -- or a raw property (jcr:created, jcr:lastModified, "
                    + "dueDate) for a JCR-level sort. Defaults to jcr:created.")
            String sortBy,
            @GraphQLName("sortOrder")
            @GraphQLDescription("ascending/asc or descending/desc (defaults to desc)")
            String sortOrder,
            @GraphQLName("filterState")
            @GraphQLDescription("Restrict results to these task states (active, started, finished, suspended)")
            List<String> filterState,
            @GraphQLName("search")
            @GraphQLDescription("Case-insensitive substring match against title, creator, assignee and state; "
                    + "matches if any one of them contains it")
            String search,
            DataFetchingEnvironment environment) throws RepositoryException {

        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        JahiaUser user = session.getUser();
        PaginationHelper.Arguments paginationArguments = PaginationHelper.parseArguments(environment);

        // Public / guest: no visibility at all.
        if (JahiaUserManagerService.isGuest(user)) {
            return PaginationHelper.paginate(Stream.empty(), n -> "", paginationArguments);
        }

        boolean canReviewAll = TaskAuthorizationService.get().canReviewAllTasks(session.getNode("/"));

        List<String> bindNames = new ArrayList<>();
        List<Value> bindValues = new ArrayList<>();
        StringBuilder statement = new StringBuilder("select * from [jnt:task] as task where ");

        if (canReviewAll) {
            // Always-true condition -- every task node has jcr:createdBy -- so an
            // Admin/Reviewer's WHERE clause stays valid JCR-SQL2 with no owner scoping.
            statement.append("task.[jcr:createdBy] is not null");
        } else {
            statement.append("(task.assigneeUserKey = $userKey or task.[jcr:createdBy] = $userName)");
            bindNames.add("userKey");
            bindValues.add(session.getValueFactory().createValue(user.getUserKey()));
            bindNames.add("userName");
            bindValues.add(session.getValueFactory().createValue(user.getName()));
        }

        appendStateFilter(statement, filterState, bindNames, bindValues, session);

        boolean ascending = "asc".equalsIgnoreCase(sortOrder) || "ascending".equalsIgnoreCase(sortOrder);

        // Sort target is an identifier, not a value -- bind variables can't parameterize it, so
        // it's constrained to a fixed allow-list instead (jahia-injection-defense). When sortBy
        // is one of the board's own columns (RESOLVED_VALUE_SORT_FIELDS), this default JCR-level
        // order is just the stable pre-sort the in-memory sort below re-sorts on top of -- it
        // still needs to be *some* deterministic order for that stable sort to be meaningful.
        String orderProperty = ALLOWED_SORT_PROPERTIES.contains(sortBy) ? sortBy : "jcr:created";
        statement.append(" order by task.[").append(orderProperty).append("] ").append(ascending ? "asc" : "desc");

        QueryWrapper query = session.getWorkspace().getQueryManager().createQuery(statement.toString(), Query.JCR_SQL2);
        for (int i = 0; i < bindNames.size(); i++) {
            query.bindValue(bindNames.get(i), bindValues.get(i));
        }

        JCRNodeIteratorWrapper nodes = query.execute().getNodes();
        Stream<GqlTaskBoard> stream = StreamSupport.stream(nodes.spliterator(), false)
                .map(GqlTaskBoard::new);

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
            Comparator<String> keyComparator = resolvedValueComparator(ascending);
            stream = stream.map(task -> new AbstractMap.SimpleEntry<>(valueOf.apply(task), task))
                    .sorted(Comparator.comparing(Map.Entry::getKey, keyComparator))
                    .map(Map.Entry::getValue);
        }

        return PaginationHelper.paginate(stream, task -> PaginationHelper.encodeCursor(task.getId()), paginationArguments);
    }

    // Split out of taskBoard() above to keep its own cognitive complexity down -- appends the
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
