/**
 * Query/mutation strings and result types shared between the SSR view
 * (CurrentUserTasksView.server.tsx, which fetches the initial page through
 * useGQLQuery) and the client island (TaskBoard.client.tsx, which fetches
 * subsequent pages and runs mutations through plain fetch()). Deliberately
 * has no import from @jahia/javascript-modules-library -- that library is
 * forbidden in the client bundle, and this file needs to be importable from
 * both sides.
 */

// The states the board lists. Closed ("finished") tasks are included: somebody needs to see that
// the work was done, and which of it. They cannot bury the live work, because the server sorts the
// closed ones into a group of their own that always follows the open ones, whatever the caller
// sorted by -- see TaskBoardQueryExtensions' CLOSED_STATE.
//
// "cancelled" is the state left out. It exists in the node type's choicelist and nothing in this UI
// ever writes it, so listing it would only ever show something this board did not put there.
//
// Passed as an explicit filterState value (an existing but, until now, never-actually-called server
// arg -- see TaskBoardQueryExtensions#taskBoard) rather than baked into the server as a hidden
// default, so the taskBoard query itself stays a complete, neutral listing endpoint.
export const BOARD_STATES = ['active', 'started', 'suspended', 'finished'];

// The board's own default sort -- a concrete starting field/direction rather than "no sort at
// all", so a sort-by control always has a real selected value to display (and so the very first
// render already matches whatever that control shows, before any interaction re-fetches anything).
//
// Oldest created first, so the task that has been waiting longest is the one at the top. This is
// also the cheaper path server-side: jcr:created is a raw JCR property, which
// TaskBoardQueryExtensions cuts by the query itself, where the board's own resolved columns
// (title/creator/owner/state) have to be sorted in memory.
export const DEFAULT_SORT_BY = 'jcr:created';
export const DEFAULT_SORT_ORDER = 'ascending';

// The three lists the board offers, in the order they are shown. The screen is called "My Tasks",
// so the default is the narrow reading of that: what is actually assigned to the viewer. The other
// two answer the questions that reading leaves open -- what did I hand out, and what could I pick
// up -- and each is a separate list rather than an extra column, because they overlap: a task I
// created and then assigned to myself belongs in two of them.
//
// The values are the server's own scope strings (see TaskBoardQueryExtensions#appendScopeFilter),
// so the filtering happens in the JCR query and the count beside these badges is the real total
// for the selected list, not a filtered page.
export type TaskScope = 'assignedToMe' | 'createdByMe' | 'claimable';

export const TASK_SCOPES: Array<{label: string; value: TaskScope}> = [
    {label: 'Assigned to me', value: 'assignedToMe'},
    {label: 'Tasks I\'ve created', value: 'createdByMe'},
    // Unassigned and offered to the viewer, usually through one of their groups -- which is how
    // workflow tasks arrive. Taking one is the "Assign to me" action already on the card.
    {label: 'Tasks I can take', value: 'claimable'}
];

export const DEFAULT_SCOPE: TaskScope = 'assignedToMe';

// The one state whose stored name is not the word to show. "Close" is what the button says, so
// "Closed" is what the task has to read as afterwards -- "Finished" would be a second name for
// the same thing, and the reader has no way to know they are the same. Every other state is shown
// capitalised as stored (see TaskCard).
export const CLOSED_STATE = 'finished';
export const CLOSED_STATE_LABEL = 'Closed';

// What an empty board means, which depends entirely on which list is showing.
export const EMPTY_SCOPE_MESSAGE: Record<TaskScope, string> = {
    assignedToMe: 'No task is assigned to you.',
    createdByMe: 'You have not created any task.',
    claimable: 'There is no task waiting to be taken.'
};

/**
 * The variables the FIRST page is fetched with, by the two places that fetch it before TaskBoard
 * exists to fetch it itself: the SSR content view (CurrentUserTasksView.server.tsx) and the
 * dashboard route (TasksDashboardApp.tsx).
 *
 * Shared rather than written out twice, because every value here has to agree with TaskBoard's
 * own initial state -- and a value that disagrees does not fail, it renders one list and then
 * silently replaces it with another as soon as the island's first re-fetch lands. That is exactly
 * what happened when `scope` was added and only one of the two call sites was updated: the board
 * arrived showing every task with "Assigned to me" selected.
 */
export const initialBoardVariables = (pageSize: number) => ({
    first: pageSize,
    filterState: BOARD_STATES,
    sortBy: DEFAULT_SORT_BY,
    sortOrder: DEFAULT_SORT_ORDER,
    scope: DEFAULT_SCOPE
});

export const TASK_BOARD_QUERY = /* GraphQL */ `
    query TaskBoard($first: Int!, $after: String, $search: String, $sortBy: String, $sortOrder: String, $filterState: [String], $scope: String) {
        taskBoard(first: $first, after: $after, search: $search, sortBy: $sortBy, sortOrder: $sortOrder, filterState: $filterState, scope: $scope) {
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
                    createdDate
                    dueDate
                    owner
                    assigneeDisplayName
                    state
                    taskType
                    possibleOutcomes
                    description
                    workflowSummary
                    viewerRole
                    candidateDisplayNames
                    targets {
                        uuid
                        displayName
                        typeName
                        inPage
                        locationPath
                    }
                    targetNode {
                        url
                        property(name: "jcr:title") {
                            value
                        }
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
    query InitialTaskBoard($first: Int!, $filterState: [String], $sortBy: String, $sortOrder: String, $scope: String) {
        taskBoard(first: $first, filterState: $filterState, sortBy: $sortBy, sortOrder: $sortOrder, scope: $scope) {
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
                    createdDate
                    dueDate
                    owner
                    assigneeDisplayName
                    state
                    taskType
                    possibleOutcomes
                    description
                    workflowSummary
                    viewerRole
                    candidateDisplayNames
                    targets {
                        uuid
                        displayName
                        typeName
                        inPage
                        locationPath
                    }
                    targetNode {
                        url
                        property(name: "jcr:title") {
                            value
                        }
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

export type TaskTarget = {
    uuid: string;
    displayName: string;
    typeName: string;
    // Whether the content sits inside a page, which decides where its button goes: jContent listing
    // the page that holds it, or jContent listing the folder that holds it.
    inPage: boolean;
    locationPath: string;
};

export type TaskBoardNode = {
    id: string;
    title: string | null;
    creator: string | null;
    createdDate: string | null;
    dueDate: string | null;
    owner: string | null;
    assigneeDisplayName: string | null;
    state: string | null;
    // "jnt:task" or "jnt:workflowTask" -- which decides whether the task can be closed by
    // writing state=finished, or has to go through its workflow outcome. See TaskActions.
    taskType: string | null;
    possibleOutcomes: string[];
    description: string | null;
    workflowSummary: string | null;
    // "assignee" | "candidate" | "none" -- kept as a plain string rather than a union, mirroring
    // the server's deliberately non-enum GraphQL field (see GqlTaskBoard#getViewerRole), so a role
    // added later doesn't turn into a type error here before anything consumes it.
    viewerRole: string;
    candidateDisplayNames: string[];
    // Every node the task references, named rather than pathed - see GqlTaskTarget. `targetNode`
    // stays for the preview link: it resolves to a page, which is the only thing with a URL.
    targets: TaskTarget[];
    targetNode: {url: string; property: {value: string} | null} | null;
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
