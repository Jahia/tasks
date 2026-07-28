package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import graphql.annotations.annotationTypes.GraphQLNonNull;
import graphql.annotations.annotationTypes.GraphQLTypeExtension;
import org.jahia.modules.graphql.provider.dxm.DXGraphQLProvider;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUserManagerService;

import javax.jcr.RepositoryException;

/**
 * Root mutation to create a {@code jnt:task} bound to arbitrary content -- replaces the raw
 * multipart node-creation POST {@code createTaskForm.jsp} used to submit (jcrNodeType=jnt:task,
 * jcrParentType=jnt:tasks). JCR's own write-permission check on {@code parentPath} is the
 * enforcement, same as the legacy contribute-mode POST handler relied on.
 */
@GraphQLTypeExtension(DXGraphQLProvider.Mutation.class)
public class TaskListMutationExtensions {

    @GraphQLField
    @GraphQLDescription("Create a new jnt:task under parentPath (auto-creating the jnt:tasks container child if "
            + "absent, matching the legacy create-task form's jcrParentType=jnt:tasks behavior). Only title is "
            + "required; the rest mirror the create-task form's config-flag-gated optional fields.")
    public static GqlTaskBoard createTask(
            @GraphQLName("parentPath") @GraphQLNonNull String parentPath,
            @GraphQLName("taskType") String taskType,
            @GraphQLName("title") @GraphQLNonNull String title,
            @GraphQLName("description") String description,
            @GraphQLName("priority") String priority,
            @GraphQLName("assigneeUserKey") String assigneeUserKey,
            @GraphQLName("dueDate") String dueDate) throws RepositoryException {
        JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession();
        if (JahiaUserManagerService.isGuest(session.getUser())) {
            throw new TaskGraphQLException("You must be logged in to create a task");
        }

        JCRNodeWrapper parent = session.getNode(parentPath);
        JCRNodeWrapper tasksContainer = parent.hasNode("tasks")
                ? parent.getNode("tasks")
                : parent.addNode("tasks", "jnt:tasks");

        String name = "task";
        int suffix = 0;
        while (tasksContainer.hasNode(name)) {
            suffix++;
            name = "task-" + suffix;
        }

        JCRNodeWrapper task = tasksContainer.addNode(name, "jnt:task");
        task.setProperty("jcr:title", title);
        task.setProperty("state", "active");
        if (taskType != null && !taskType.isEmpty()) {
            task.setProperty("type", taskType);
        }
        if (description != null && !description.isEmpty()) {
            task.setProperty("description", description);
        }
        if (priority != null && !priority.isEmpty()) {
            task.setProperty("priority", priority);
        }
        if (assigneeUserKey != null && !assigneeUserKey.isEmpty()) {
            task.setProperty("assigneeUserKey", assigneeUserKey);
        }
        if (dueDate != null && !dueDate.isEmpty()) {
            task.setProperty("dueDate", dueDate);
        }
        session.save();
        return new GqlTaskBoard(task);
    }
}
