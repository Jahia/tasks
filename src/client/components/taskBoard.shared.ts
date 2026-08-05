/**
 * Query/mutation strings and result types shared between the SSR view
 * (CurrentUserTasksView.server.tsx, which fetches the initial page through
 * useGQLQuery) and the client island (TaskBoard.client.tsx, which fetches
 * subsequent pages and runs mutations through plain fetch()). Deliberately
 * has no import from @jahia/javascript-modules-library -- that library is
 * forbidden in the client bundle, and this file needs to be importable from
 * both sides.
 */

// The board's own default scope: everything except finished tasks, so completed work doesn't
// pile up in the list forever. Passed as an explicit filterState value (an existing but,
// until now, never-actually-called server arg -- see TaskBoardQueryExtensions#taskBoard) rather
// than baked into the server as a hidden default, so the taskBoard query itself stays a
// complete, neutral listing endpoint -- every call site here just opts into this narrower view.
export const NOT_FINISHED_STATES = ['active', 'started', 'suspended'];

export const TASK_BOARD_QUERY = /* GraphQL */ `
    query TaskBoard($first: Int!, $after: String, $search: String, $sortBy: String, $sortOrder: String, $filterState: [String]) {
        taskBoard(first: $first, after: $after, search: $search, sortBy: $sortBy, sortOrder: $sortOrder, filterState: $filterState) {
            pageInfo {
                hasNextPage
                endCursor
                totalCount
            }
            edges {
                node {
                    id
                    title
                    creator
                    owner
                    assigneeDisplayName
                    state
                    possibleOutcomes
                    targetNode {
                        url
                    }
                }
            }
        }
    }
`;

// Used only by the SSR view for the first page: adds the viewer fields the
// client island needs for its action-menu display logic (see
// TaskBoardQueryExtensions#taskBoardCurrentUserKey/#taskBoardCanReviewAll).
export const INITIAL_TASK_BOARD_QUERY = /* GraphQL */ `
    query InitialTaskBoard($first: Int!, $filterState: [String]) {
        taskBoard(first: $first, filterState: $filterState) {
            pageInfo {
                hasNextPage
                endCursor
                totalCount
            }
            edges {
                node {
                    id
                    title
                    creator
                    owner
                    assigneeDisplayName
                    state
                    possibleOutcomes
                    targetNode {
                        url
                    }
                }
            }
        }
        taskBoardCurrentUserKey
        taskBoardCanReviewAll
    }
`;

export const ASSIGN_TASK_TO_ME_MUTATION = /* GraphQL */ `
    mutation AssignTaskToMe($id: String!) {
        assignTaskToMe(id: $id) {
            id
        }
    }
`;

export const UNASSIGN_TASK_MUTATION = /* GraphQL */ `
    mutation UnassignTask($id: String!) {
        unassignTask(id: $id) {
            id
        }
    }
`;

export const SUSPEND_TASK_MUTATION = /* GraphQL */ `
    mutation SuspendTask($id: String!) {
        suspendTask(id: $id) {
            id
        }
    }
`;

export const RESUME_TASK_MUTATION = /* GraphQL */ `
    mutation ResumeTask($id: String!) {
        resumeTask(id: $id) {
            id
        }
    }
`;

export const COMPLETE_TASK_MUTATION = /* GraphQL */ `
    mutation CompleteTask($id: String!, $outcome: String!) {
        completeTask(id: $id, outcome: $outcome) {
            id
        }
    }
`;

export type TaskBoardNode = {
    id: string;
    title: string | null;
    creator: string | null;
    owner: string | null;
    assigneeDisplayName: string | null;
    state: string | null;
    possibleOutcomes: string[];
    targetNode: {url: string} | null;
};

export type TaskBoardConnection = {
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
        totalCount: number;
    };
    edges: Array<{node: TaskBoardNode}>;
};

export type TaskBoardQueryResult = {
    taskBoard: TaskBoardConnection;
};

export type InitialTaskBoardQueryResult = TaskBoardQueryResult & {
    taskBoardCurrentUserKey: string;
    taskBoardCanReviewAll: boolean;
};
