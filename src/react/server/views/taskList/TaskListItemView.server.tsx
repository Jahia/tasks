import {jahiaComponent, Island, Render, useGQLQuery, buildEndpointUrl} from '@jahia/javascript-modules-library';
import TaskListItem from '../../../../client/components/TaskListItem.client';
import {TASK_QUERY} from '../../../../client/components/task.shared';
import type {TaskQueryResult} from '../../../../client/components/task.shared';

jahiaComponent(
    {
        nodeType: 'jnt:task',
        // Explicit "taskList" view name -- this is the per-row view TaskListView.server.tsx
        // requests for each task under a bound node (`<Render view="taskList"/>`), not jnt:task's
        // own default detail view (TaskView.server.tsx, from Phase 1).
        name: 'taskList',
        componentType: 'view',
        displayName: 'Task list row (React)',
        priority: 10
    },
    (props, {currentNode}) => {
        const id = currentNode.getIdentifier();
        const {data} = useGQLQuery({query: TASK_QUERY, variables: {id}});
        const result = data as TaskQueryResult;

        // taskData sub-view dispatch: a jnt:simpleWorkflow child gets its dedicated view (Phase 1's
        // SimpleWorkflowTaskDataView); anything else falls back to whatever other module registers
        // the generic "taskData" view -- same dispatch task.taskList.jsp did.
        const taskDataNode = currentNode.hasNode('taskData') ? currentNode.getNode('taskData') : null;

        return (
            <div className="task-list-item">
                <Island
                    component={TaskListItem}
                    props={{
                        task: result.task,
                        currentUserKey: result.taskBoardCurrentUserKey,
                        canReviewAll: result.taskBoardCanReviewAll,
                        graphqlEndpoint: buildEndpointUrl('/modules/graphql')
                    }}
                />
                {taskDataNode && (
                    <Render
                        node={taskDataNode}
                        view={taskDataNode.isNodeType('jnt:simpleWorkflow') ? 'simpleWorkflow' : 'taskData'}
                    />
                )}
            </div>
        );
    }
);
