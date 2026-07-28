package org.jahia.modules.tasks.graphql;

import org.jahia.modules.graphql.provider.dxm.DXGraphQLExtensionsProvider;
import org.osgi.service.component.annotations.Component;

import java.util.Arrays;
import java.util.Collection;

/**
 * Registers this module's GraphQL schema extensions with graphql-dxm-provider.
 * {@code immediate = true} so it activates without waiting for a consumer.
 */
@Component(service = DXGraphQLExtensionsProvider.class, immediate = true)
public class TaskGraphQLExtensionsProvider implements DXGraphQLExtensionsProvider {

    @Override
    public Collection<Class<?>> getExtensions() {
        return Arrays.asList(TaskBoardQueryExtensions.class, TaskBoardMutationExtensions.class,
                TaskDataMutationExtensions.class, TaskListMutationExtensions.class,
                WorkflowActivityQueryExtensions.class);
    }
}
