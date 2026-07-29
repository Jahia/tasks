package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import org.jahia.api.Constants;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNode;
import org.jahia.modules.graphql.provider.dxm.node.GqlJcrNodeImpl;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUserManagerService;

import javax.jcr.RepositoryException;

/**
 * Inline-edit mutation for a task's {@code taskData} child node (e.g. a {@code jnt:simpleWorkflow})
 * -- replaces the raw {@code jcrMethodToCall=put} form POST simpleWorkflow.simpleWorkflow.jsp used
 * to submit. JCR's own write-permission check on the node (the same ACL the legacy contribute-mode
 * POST handler relied on) is the enforcement here; no extra application-level guard is needed
 * beyond requiring a real (non-guest) session.
 */
@GraphQLTypeExtension(DXGraphQLProvider.Mutation.class)
public class TaskDataMutationExtensions {

    @GraphQLField
    @GraphQLDescription("Update the title of a task's taskData child node (e.g. a jnt:simpleWorkflow)")
    public static GqlJcrNode updateTaskDataTitle(
            @GraphQLName("id") @GraphQLNonNull String id,
            @GraphQLName("title") @GraphQLNonNull String title) throws RepositoryException {
        // taskData nodes only ever live in the edit/default workspace -- see
        // TaskBoardQueryExtensions' class comment for why this is pinned explicitly.
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession(Constants.EDIT_WORKSPACE);
        if (JahiaUserManagerService.isGuest(session.getUser())) {
            throw new TaskGraphQLException("You must be logged in to edit this task");
        }

        JCRNodeWrapper node = session.getNodeByIdentifier(id);
        node.setProperty("jcr:title", title);
        session.save();
        return new GqlJcrNodeImpl(node);
    }
}
