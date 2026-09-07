/**
 * Query/mutation strings and result types shared between the SSR view
 * (CurrentUserTasksView.server.tsx, which fetches the initial page through
 * useGQLQuery) and the client island (TaskBoard.client.tsx, which fetches
 * subsequent pages and runs mutations through plain fetch()). Deliberately
 * has no import from @jahia/javascript-modules-library -- that library is
 * forbidden in the client bundle, and this file needs to be importable from
 * both sides.
 */

export type ColumnKey = 'active' | 'started' | 'closed';

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

export type BoardColumn = {
    key: ColumnKey;
    label: string;
    // The states whose tasks belong in this column. Sent to the server as filterState, so each
    // column is its own query and a long list in one of them cannot push the others around.
    states: string[];
    // The state a card takes when it is dropped into this column.
    entryState: string;
};

/**
 * The board's three columns, in order. The order is not decoration: a card may be dragged to the
 * NEXT or the PREVIOUS column and no further, and "next" means next in this array.
 *
 * **Where "suspended" went.** A refused task is parked, not progressed and not done, so it belongs
 * with the work that has not been started -- this column is "not started yet", of which "active"
 * is the ordinary case and "suspended" the parked one. It keeps its own Suspended chip, so the two
 * are still told apart inside the column. Giving it a fourth column would say it is a stage of its
 * own, which it is not.
 *
 * **"cancelled" is the state left off the board entirely.** It exists in the node type's choicelist
 * and nothing in this UI ever writes it, so a column for it would only ever show something this
 * board did not put there.
 *
 * entryState is what a drop WRITES, which is not always the state the column already holds:
 * dropping a suspended card back into its own column is a no-op, but dropping a started one there
 * resets it to active rather than to suspended -- moving work back is not the same as refusing it.
 */
export const BOARD_COLUMNS: BoardColumn[] = [
    {key: 'active', label: 'Active', states: ['active', 'suspended'], entryState: 'active'},
    {key: 'started', label: 'Started', states: ['started'], entryState: 'started'},
    {key: 'closed', label: CLOSED_STATE_LABEL, states: [CLOSED_STATE], entryState: CLOSED_STATE}
];

/** Which column a task is currently sitting in, or null for a state the board does not list. */
export const columnKeyOf = (state: string | null): ColumnKey | null =>
    BOARD_COLUMNS.find(column => column.states.includes(state ?? ''))?.key ?? null;

/** How many columns apart two of them are, signed: +1 is one to the right. */
export const columnStep = (from: ColumnKey, to: ColumnKey): number =>
    BOARD_COLUMNS.findIndex(column => column.key === to) -
    BOARD_COLUMNS.findIndex(column => column.key === from);

// What an empty board means, which depends entirely on which list is showing.
export const EMPTY_SCOPE_MESSAGE: Record<TaskScope, string> = {
    assignedToMe: 'No task is assigned to you.',
    createdByMe: 'You have not created any task.',
    claimable: 'There is no task waiting to be taken.'
};

/** The per-column page-size variables the document declares, all set to the same size. */
export const columnFirsts = (pageSize: number): Record<string, number> =>
    Object.fromEntries(BOARD_COLUMNS.map(column => [`${column.key}First`, pageSize]));

/** How many rows each column is currently asking for, keyed the way the board's state keeps it. */
export type ColumnLimits = Record<ColumnKey, number>;

export const columnFirstsFrom = (limits: ColumnLimits): Record<string, number> =>
    Object.fromEntries(BOARD_COLUMNS.map(column => [`${column.key}First`, limits[column.key]]));

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
    ...columnFirsts(pageSize),
    search: null,
    sortBy: DEFAULT_SORT_BY,
    sortOrder: DEFAULT_SORT_ORDER,
    scope: DEFAULT_SCOPE
});

/**
 * Everything a card shows. Interpolated into one aliased query per column rather than expressed as
 * a GraphQL fragment: a fragment has to name the type it applies to, and this file is deliberately
 * free of any import from the module library that would tell it what that type is called.
 */
const TASK_CARD_FIELDS = /* GraphQL */ `
    id
    title
    creator
    createdDate
    closedDate
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
`;

/**
 * One column's slice of the board, aliased under the column's own key.
 *
 * Each column is a separate taskBoard call with its own filterState and its own page size, so a
 * hundred closed tasks cannot crowd out the active ones and "show more" in one column leaves the
 * other two alone. The states are this file's own constants, not caller input, so they go into the
 * document as literals; everything a person can influence -- the search text, the sort, the scope
 * -- stays a bind variable.
 */
const columnSelection = (column: BoardColumn) => /* GraphQL */ `
    ${column.key}: taskBoard(
        first: $${column.key}First
        search: $search
        sortBy: $sortBy
        sortOrder: $sortOrder
        scope: $scope
        filterState: ${JSON.stringify(column.states)}
    ) {
        pageInfo {
            hasNextPage
            totalCount
        }
        edges {
            node {
                ${TASK_CARD_FIELDS}
            }
        }
    }
`;

const COLUMN_ARGUMENTS = BOARD_COLUMNS.map(column => `$${column.key}First: Int!`).join(', ');
const COLUMN_SELECTIONS = BOARD_COLUMNS.map(columnSelection).join('\n');

export const TASK_BOARD_QUERY = /* GraphQL */ `
    query TaskBoard(${COLUMN_ARGUMENTS}, $search: String, $sortBy: String, $sortOrder: String, $scope: String) {
        ${COLUMN_SELECTIONS}
    }
`;

// Used only for the board's first render: adds the viewer fields the card's action logic needs
// (see TaskBoardQueryExtensions#taskBoardCurrentUserKey/#taskBoardCanReviewAll). They never change
// while the board is open, so no later fetch asks for them again.
export const INITIAL_TASK_BOARD_QUERY = /* GraphQL */ `
    query InitialTaskBoard(${COLUMN_ARGUMENTS}, $search: String, $sortBy: String, $sortOrder: String, $scope: String) {
        ${COLUMN_SELECTIONS}
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
    // When it reached "finished", or null while it has not. Server-side this is the stamped
    // closedDate, standing in with jcr:lastModified for tasks closed before that property
    // existed -- see GqlTaskBoard#getClosedDate.
    closedDate: string | null;
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

// One connection per column, keyed by the aliases columnSelection() emits.
export type TaskBoardQueryResult = Record<ColumnKey, TaskBoardConnection>;

export type InitialTaskBoardQueryResult = TaskBoardQueryResult & {
    taskBoardCurrentUserKey: string;
    taskBoardCanReviewAll: boolean;
};
