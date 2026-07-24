import {jahiaComponent, Island} from '@jahia/javascript-modules-library';
import {TaskBoard} from '../../../../client/components/TaskBoard';

jahiaComponent(
    {
        nodeType: 'jnt:currentUserTasks',
        name: 'default',
        componentType: 'view',
        displayName: 'Task board (React)',
        // Higher than the module's legacy .jsp default view, so this one wins.
        priority: 10
    },
    () => (
        <div className="task-board">
            <Island component={TaskBoard} clientOnly/>
        </div>
    )
);
