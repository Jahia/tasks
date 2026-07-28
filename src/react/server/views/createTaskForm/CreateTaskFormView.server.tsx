import {jahiaComponent, Island, buildEndpointUrl} from '@jahia/javascript-modules-library';
import type {JCRNodeWrapper} from 'org.jahia.services.content';
import CreateTaskForm from '../../../../client/components/CreateTaskForm.client';

jahiaComponent(
    {
        nodeType: 'jnt:createTaskForm',
        name: 'default',
        componentType: 'view',
        displayName: 'Create task form (React)',
        // Higher than the module's legacy .jsp default view, so this one wins.
        priority: 10
    },
    (props, {currentNode, mainNode}) => {
        // Mirrors uiComponents:getBindedComponent(currentNode, renderContext, 'j:bindedComponent') --
        // an explicitly bound component if configured, otherwise the current page's main resource.
        let boundNode: JCRNodeWrapper = mainNode;
        if (currentNode.hasProperty('j:bindedComponent')) {
            try {
                boundNode = currentNode.getProperty('j:bindedComponent').getNode() as JCRNodeWrapper;
            } catch {
                // Weak reference target no longer exists -- fall back to the main resource.
            }
        }

        // Role names for the legacy-find-users lookup's optional role filter, resolved from the
        // rolesList weakreferences server-side (the client can only fetch(), not read JCR refs).
        const roles: string[] = [];
        const checkRoles = currentNode.hasProperty('checkRolesOnMainResource')
            && currentNode.getProperty('checkRolesOnMainResource').getBoolean();
        if (checkRoles && currentNode.hasProperty('rolesList')) {
            for (const value of currentNode.getProperty('rolesList').getValues()) {
                try {
                    roles.push(value.getNode().getName());
                } catch {
                    // Weak reference target no longer exists -- skip it.
                }
            }
        }

        const flag = (name: string) => currentNode.hasProperty(name) && currentNode.getProperty(name).getBoolean();

        return (
            <Island
                component={CreateTaskForm}
                props={{
                    parentPath: boundNode.getPath(),
                    title: currentNode.getPropertyAsString('jcr:title') || 'Add a task',
                    taskType: currentNode.getPropertyAsString('taskType'),
                    useDescription: flag('useDescription'),
                    usePriority: flag('usePriority'),
                    useAssignee: flag('useAssignee'),
                    useDueDate: flag('useDueDate'),
                    findUserRoles: roles,
                    mainResourcePath: mainNode.getPath(),
                    graphqlEndpoint: buildEndpointUrl('/modules/graphql')
                }}
            />
        );
    }
);
