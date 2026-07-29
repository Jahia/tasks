import {jahiaComponent, Island, useGQLQuery, buildEndpointUrl} from '@jahia/javascript-modules-library';
import TaskBoard from '../../../../client/components/TaskBoard.client';
import {INITIAL_TASK_BOARD_QUERY} from '../../../../client/components/taskBoard.shared';
import type {InitialTaskBoardQueryResult} from '../../../../client/components/taskBoard.shared';

const PAGE_SIZE = 20;

jahiaComponent(
    {
        nodeType: 'jnt:currentUserTasks',
        name: 'default',
        componentType: 'view',
        displayName: 'Task board (React)',
        // Higher than the module's legacy .jsp default view, so this one wins.
        priority: 10
    },
    () => {
        // Fetched here (SSR) rather than in the client island: useGQLQuery and
        // buildEndpointUrl are part of @jahia/javascript-modules-library, which
        // the client bundle is forbidden from importing at all. The island
        // fetches every subsequent page/mutation itself via plain fetch().
        const {data, errors} = useGQLQuery({
            query: INITIAL_TASK_BOARD_QUERY,
            variables: {first: PAGE_SIZE}
        });

        if (errors && errors.length > 0) {
            console.error('[tasks] currentUserTasks board query failed:', errors.map(error => error.message).join('; '));
            return <div className="task-board task-board--error">Unable to load the task board. Check the server log for details.</div>;
        }

        const result = data as InitialTaskBoardQueryResult;

        return (
            <div className="task-board">
                <Island
                    component={TaskBoard}
                    props={{
                        initialConnection: result.taskBoard,
                        graphqlEndpoint: buildEndpointUrl('/modules/graphql'),
                        currentUserKey: result.taskBoardCurrentUserKey,
                        canReviewAll: result.taskBoardCanReviewAll
                    }}
                />
            </div>
        );
    }
);