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

// The board's own default sort: newest created first (jahia-private#5292), which is also the
// server's own documented default (TaskBoardQueryExtensions#DEFAULT_SORT_PROPERTY). Sent
// explicitly all the same, so the very first render already matches what the table's sorted
// column header shows, before any interaction re-fetches anything -- and, unlike the previous
// 'title'/'ascending' default, this one is a raw JCR property, so the initial page is served by
// the query-level fast path (#64) instead of a full scan.
export type TaskSortOrder = 'ascending' | 'descending';

export const DEFAULT_SORT_BY = 'jcr:created';
// Typed rather than inferred, so this stays "one of the two directions the server accepts" and
// callers can branch on it -- an inferred 'descending' literal would make comparing it to
// 'ascending' a compile error instead of a runtime branch.
export const DEFAULT_SORT_ORDER: TaskSortOrder = 'descending';

// The "mine vs. my group's" split (#61). Each value narrows the caller's own visibility further,
// server-side (see TaskBoardQueryExtensions#appendScopeFilter) rather than by filtering an
// already-fetched page, so pagination and totalCount stay correct within the selected scope.
export const SCOPE_ASSIGNED_TO_ME = 'assignedToMe';
export const SCOPE_CLAIMABLE = 'claimable';
export const SCOPE_ALL = 'all';

export type TaskScope = typeof SCOPE_ASSIGNED_TO_ME | typeof SCOPE_CLAIMABLE | typeof SCOPE_ALL;

// Every field a board row needs, written once and spliced into each query below -- the initial
// query asks for the same rows three times over (one per scope), so repeating this selection
// inline would be the third copy of it in this file.
const TASK_BOARD_PAGE_SELECTION = /* GraphQL */ `
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
            owner
            assigneeDisplayName
            state
            possibleOutcomes
            description
            workflowSummary
            viewerRole
            candidateDisplayNames
            targetNode {
                url
                property(name: "jcr:title") {
                    value
                }
            }
        }
    }
`;

export const TASK_BOARD_QUERY = /* GraphQL */ `
    query TaskBoard($first: Int!, $after: String, $search: String, $sortBy: String, $sortOrder: String, $filterState: [String], $scope: String) {
        taskBoard(first: $first, after: $after, search: $search, sortBy: $sortBy, sortOrder: $sortOrder, filterState: $filterState, scope: $scope) {
            ${TASK_BOARD_PAGE_SELECTION}
        }
    }
`;

// Used only by the two entry points for the first page: adds the viewer fields the client island
// needs for its action display logic (see TaskBoardQueryExtensions#taskBoardCurrentUserKey/
// #taskBoardCanReviewAll), and fetches page 1 of all three scopes at once.
//
// Three pages in one round trip, rather than a count-only probe followed by a second fetch of
// whichever scope wins: which scope the board opens on is only known after the counts come back
// (see pickInitialScope), and the board has to open with real rows for that scope, not with the
// wrong scope's rows swapped out a moment later. The extra cost is two more query-level-sliced
// pages (#64), each proportional to the page size and not to the size of the board -- and the two
// added ones are the narrow scopes, which are usually the smallest.
export const INITIAL_TASK_BOARD_QUERY = /* GraphQL */ `
    query InitialTaskBoard($first: Int!, $filterState: [String], $sortBy: String, $sortOrder: String) {
        assignedToMe: taskBoard(first: $first, filterState: $filterState, sortBy: $sortBy, sortOrder: $sortOrder, scope: "${SCOPE_ASSIGNED_TO_ME}") {
            ${TASK_BOARD_PAGE_SELECTION}
        }
        claimable: taskBoard(first: $first, filterState: $filterState, sortBy: $sortBy, sortOrder: $sortOrder, scope: "${SCOPE_CLAIMABLE}") {
            ${TASK_BOARD_PAGE_SELECTION}
        }
        all: taskBoard(first: $first, filterState: $filterState, sortBy: $sortBy, sortOrder: $sortOrder, scope: "${SCOPE_ALL}") {
            ${TASK_BOARD_PAGE_SELECTION}
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
    createdDate: string | null;
    owner: string | null;
    assigneeDisplayName: string | null;
    state: string | null;
    possibleOutcomes: string[];
    description: string | null;
    workflowSummary: string | null;
    // "assignee" | "candidate" | "none" -- kept as a plain string rather than a union, mirroring
    // the server's deliberately non-enum GraphQL field (see GqlTaskBoard#getViewerRole), so a role
    // added later doesn't turn into a type error here before anything consumes it.
    viewerRole: string;
    candidateDisplayNames: string[];
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

export type InitialTaskBoardQueryResult = {
    [SCOPE_ASSIGNED_TO_ME]: TaskBoardConnection;
    [SCOPE_CLAIMABLE]: TaskBoardConnection;
    [SCOPE_ALL]: TaskBoardConnection;
    taskBoardCurrentUserKey: string;
    taskBoardCanReviewAll: boolean;
};

/**
 * Which scope the board opens on: the first of "assigned to me" / "available to my group(s)" /
 * "all" that actually has something in it. A user with work of their own lands on it directly;
 * one with nothing assigned but something to pick up lands on the pool; a reviewer (who typically
 * has neither) lands on the full board, which is what they came for anyway.
 *
 * Decided from the initial fetch's own three pages -- no extra request, and no possibility of the
 * decision disagreeing with the rows the board then shows.
 */
export function pickInitialScope(result: InitialTaskBoardQueryResult): TaskScope {
    if (result[SCOPE_ASSIGNED_TO_ME].edges.length > 0) {
        return SCOPE_ASSIGNED_TO_ME;
    }

    if (result[SCOPE_CLAIMABLE].edges.length > 0) {
        return SCOPE_CLAIMABLE;
    }

    return SCOPE_ALL;
}
