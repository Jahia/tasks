package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import graphql.annotations.connection.GraphQLConnection;
import graphql.schema.DataFetchingEnvironment;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.modules.graphql.provider.dxm.relay.DXPaginatedData;
import org.jahia.modules.graphql.provider.dxm.relay.DXPaginatedDataConnectionFetcher;
import org.jahia.modules.graphql.provider.dxm.relay.PaginationHelper;
import org.jahia.osgi.BundleUtils;
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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/**
 * Root {@code taskBoard} query -- consolidates the three duplicated, hand-built
 * JCR-SQL2 queries from the legacy JSPs (currentUserTasks.hidden.load.jsp,
 * taskList.hidden.load.jsp/taskSchedule.jsp, tasksCount.groovy) into one
 * parameterized query, with pagination as real GraphQL (Relay connection) args
 * instead of the legacy list-rendering pipeline.
 *
 * <p>TODO(Phase 4): scoped to the whole repository for now (no site/path filter);
 * revisit once the per-site visibility story for jnt:workflowTask is confirmed
 * against a real deployment.
 */
@GraphQLTypeExtension(DXGraphQLProvider.Query.class)
public class TaskBoardQueryExtensions {

    private static final List<String> ALLOWED_SORT_PROPERTIES = Arrays.asList(
            "jcr:created", "jcr:lastModified", "dueDate", "state", "jcr:title");

    @GraphQLField
    @GraphQLConnection(connectionFetcher = DXPaginatedDataConnectionFetcher.class)
    @GraphQLDescription("Paginated task board (jnt:task / jnt:workflowTask), scoped by the caller's role: "
            + "Admin/Reviewer sees every task, Contributor sees only their own, Public sees nothing")
    public static DXPaginatedData<GqlTaskBoard> taskBoard(
            @GraphQLName("sortBy")
            @GraphQLDescription("Property to sort by: jcr:created, jcr:lastModified, dueDate, state or jcr:title (defaults to jcr:created)")
            String sortBy,
            @GraphQLName("sortOrder")
            @GraphQLDescription("asc or desc (defaults to desc)")
            String sortOrder,
            @GraphQLName("filterState")
            @GraphQLDescription("Restrict results to these task states (active, started, finished, suspended)")
            List<String> filterState,
            DataFetchingEnvironment environment) throws RepositoryException {

        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession();
        JahiaUser user = session.getUser();
        PaginationHelper.Arguments paginationArguments = PaginationHelper.parseArguments(environment);

        // Public / guest: no visibility at all.
        if (JahiaUserManagerService.isGuest(user)) {
            return PaginationHelper.paginate(Stream.empty(), n -> "", paginationArguments);
        }

        TaskAuthorizationService authorizationService = Objects.requireNonNull(
                BundleUtils.getOsgiService(TaskAuthorizationService.class, null),
                "TaskAuthorizationService OSGi service is not available");
        boolean canReviewAll = authorizationService.canReviewAllTasks(session.getNode("/"));

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

        if (filterState != null && !filterState.isEmpty()) {
            statement.append(" and (");
            for (int i = 0; i < filterState.size(); i++) {
                if (i > 0) {
                    statement.append(" or ");
                }
                String bindName = "state" + i;
                statement.append("task.state = $").append(bindName);
                bindNames.add(bindName);
                bindValues.add(session.getValueFactory().createValue(filterState.get(i)));
            }
            statement.append(")");
        }

        // Sort target is an identifier, not a value -- bind variables can't parameterize
        // it, so it's constrained to a fixed allow-list instead (jahia-injection-defense).
        String orderProperty = ALLOWED_SORT_PROPERTIES.contains(sortBy) ? sortBy : "jcr:created";
        String orderDirection = "asc".equalsIgnoreCase(sortOrder) ? "asc" : "desc";
        statement.append(" order by task.[").append(orderProperty).append("] ").append(orderDirection);

        QueryWrapper query = session.getWorkspace().getQueryManager().createQuery(statement.toString(), Query.JCR_SQL2);
        for (int i = 0; i < bindNames.size(); i++) {
            query.bindValue(bindNames.get(i), bindValues.get(i));
        }

        JCRNodeIteratorWrapper nodes = query.execute().getNodes();
        Stream<GqlTaskBoard> stream = StreamSupport.stream(nodes.spliterator(), false)
                .map(GqlTaskBoard::new);

        return PaginationHelper.paginate(stream, task -> PaginationHelper.encodeCursor(task.getId()), paginationArguments);
    }

    @GraphQLField
    @GraphQLDescription("A single task by id, for the task detail view (jnt:task's own page). Visibility is "
            + "governed by the normal JCR read permission on the node -- no board-style RBAC scoping applies here, "
            + "since viewing a task you already have a direct path/id to is a different concern than the "
            + "aggregated board's owner-scoped listing")
    public static GqlTaskBoard task(@GraphQLName("id") @GraphQLNonNull String id) throws RepositoryException {
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession();
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
        return JCRSessionFactory.getInstance().getCurrentUserSession().getUser().getUserKey();
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("Whether the current viewer can act on every task on the board, not just their own")
    public static boolean taskBoardCanReviewAll() throws RepositoryException {
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession();
        TaskAuthorizationService authorizationService = Objects.requireNonNull(
                BundleUtils.getOsgiService(TaskAuthorizationService.class, null),
                "TaskAuthorizationService OSGi service is not available");
        return authorizationService.canReviewAllTasks(session.getNode("/"));
    }
}
