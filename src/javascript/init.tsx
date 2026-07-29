import {registry} from '@jahia/ui-extender';
import {Task} from '@jahia/moonstone';
import {TasksDashboardApp} from './TasksDashboardApp';

// NOTE for review: as of @jahia/ui-extender@1.3.0 (the latest published version, resolved here),
// its compiled source has no consumer anywhere for a 'route' registry type or a 'dashboard'
// target -- the only type it reads is 'adminRoute' (used by the jContent nav tree, targets like
// 'jcontent:50', see Formidable's formidable-engine/src/javascript/init.tsx). So this
// registration, as specified, does not currently wire into anything the admin shell renders.
// Keeping the 'route' type/'dashboard:10' target exactly as requested for review -- flagging
// this so it isn't mistaken for a bug in the JSX below rather than a missing consumer upstream.
export default function () {
    registry.add('callback', 'TasksEngineEditor', {
        targets: ['jahiaApp-init:20'],
        callback: () => {
            registry.add('route', 'tasksDashboard', {
                targets: ['dashboard:10'],
                icon: <Task/>,
                label: 'JahiaTasks:jnt_task.myTasks',
                isSelectable: true,
                render: () => <TasksDashboardApp/>
            });

            console.debug('%c Tasks Engine Extensions is activated', 'color: #3c8cba');
        }
    });
}
