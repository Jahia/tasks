import {jahiaComponent, Island, useGQLQuery, buildEndpointUrl} from '@jahia/javascript-modules-library';
import TaskDetail from '../../../../client/components/TaskDetail.client';
import {TASK_QUERY} from '../../../../client/components/task.shared';
import type {TaskQueryResult} from '../../../../client/components/task.shared';

jahiaComponent(
    {
        nodeType: 'jnt:task',
        name: 'default',
        componentType: 'view',
        displayName: 'Task detail (React)',
        // Higher than the module's legacy .jsp default view, so this one wins.
        priority: 10
    },
    (props, {currentNode}) => {
        const id = currentNode.getIdentifier();
        // canModify mirrors task.jsp's jcr:hasPermission(currentNode,'jcr:modifyProperties') check --
        // whether the state-transition buttons show at all is a UX nicety; updateTaskState
        // independently re-checks authorization server-side regardless of this value.
        const canModify = currentNode.hasPermission('jcr:modifyProperties');
        const {data} = useGQLQuery({
            query: TASK_QUERY,
            variables: {id}
        });
        const result = data as TaskQueryResult;

        return (
            <div className="task-detail">
                <Island
                    component={TaskDetail}
                    props={{
                        task: result.task,
                        canModify,
                        graphqlEndpoint: buildEndpointUrl('/modules/graphql')
                    }}
                />
            </div>
        );
    }
);
