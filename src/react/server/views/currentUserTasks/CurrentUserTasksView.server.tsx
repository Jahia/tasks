import {jahiaComponent, Island, useGQLQuery, buildEndpointUrl} from '@jahia/javascript-modules-library';
import TaskBoard, {DEFAULT_PAGE_SIZE} from '../../../../client/components/TaskBoard.client';
import {DEFAULT_SORT_BY, DEFAULT_SORT_ORDER, INITIAL_TASK_BOARD_QUERY, NOT_FINISHED_STATES, pickInitialScope} from '../../../../client/components/taskBoard.shared';
import type {InitialTaskBoardQueryResult} from '../../../../client/components/taskBoard.shared';

// Must match TaskBoard's own itemsPerPage default -- see TasksDashboardApp's identical constant
// for why (this view has its own separate initial fetch, so the mismatch was independent there).
const PAGE_SIZE = DEFAULT_PAGE_SIZE;

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
            variables: {first: PAGE_SIZE, filterState: NOT_FINISHED_STATES, sortBy: DEFAULT_SORT_BY, sortOrder: DEFAULT_SORT_ORDER}
        });

        if (errors && errors.length > 0) {
            console.error('[tasks] currentUserTasks board query failed:', errors.map(error => error.message).join('; '));
            return <div className="task-board task-board--error">Unable to load the task board. Check the server log for details.</div>;
        }

        const result = data as InitialTaskBoardQueryResult;
        // Same decision as the dashboard route: the query returns page 1 of all three scopes, the
        // board opens on the first non-empty one and receives that scope's page.
        const initialScope = pickInitialScope(result);

        return (
            <div className="task-board">
                <Island
                    component={TaskBoard}
                    props={{
                        initialConnection: result[initialScope],
                        initialScope,
                        graphqlEndpoint: buildEndpointUrl('/modules/graphql'),
                        currentUserKey: result.taskBoardCurrentUserKey,
                        canReviewAll: result.taskBoardCanReviewAll
                    }}
                />
            </div>
        );
    }
);