import {jahiaComponent, Render, getNodesByJCRQuery} from '@jahia/javascript-modules-library';
import type {JCRNodeWrapper} from 'org.jahia.services.content';
import {sqlEncode} from '../../lib/jcrSql2';

jahiaComponent(
    {
        nodeType: 'jnt:taskList',
        name: 'default',
        componentType: 'view',
        displayName: 'Task list (React)',
        // Higher than the module's legacy .jsp default view, so this one wins.
        priority: 10
    },
    (props, {currentNode, mainNode, jcrSession}) => {
        // Mirrors uiComponents:getBindedComponent(currentNode, renderContext, 'j:bindedComponent') --
        // an explicitly bound component if configured, otherwise the current page's main resource.
        // (The legacy JSP also accepted a `bindedComponent` request param override for its own AJAX
        // reload flow; that's specific to the old server-rendered-fragment reload mechanism and has
        // no equivalent need here.)
        let boundNode: JCRNodeWrapper = mainNode;
        if (currentNode.hasProperty('j:bindedComponent')) {
            try {
                boundNode = currentNode.getProperty('j:bindedComponent').getNode() as JCRNodeWrapper;
            } catch {
                // Weak reference target no longer exists -- fall back to the main resource.
            }
        }

        const filterOnTypes = currentNode.hasProperty('filterOnTypes')
            ? currentNode.getPropertyAsString('filterOnTypes')
            : null;

        let statement = `select * from [jnt:task] as t where isdescendantnode(t, ['${sqlEncode(boundNode.getPath())}'])`;
        if (filterOnTypes) {
            statement += ` and t.type = '${sqlEncode(filterOnTypes)}'`;
        }

        statement += ' order by [jcr:created] desc';

        const tasks = getNodesByJCRQuery(jcrSession, statement, -1);

        if (tasks.length === 0) {
            return <div className="task-list task-list--empty">No tasks.</div>;
        }

        return (
            <div className="task-list">
                {tasks.map(task => (
                    <Render key={task.getIdentifier()} node={task} view="taskList"/>
                ))}
            </div>
        );
    }
);
