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

// What the board's "Show finished" toggle widens filterState to. It adds BOTH terminal states,
// not just "finished": "cancelled" is the other end a task can stop at (jnt:task's own choicelist
// declares it, and the task detail view's Cancel button writes it -- see
// TaskBoardMutationExtensions#ALLOWED_STATES), and it is excluded from NOT_FINISHED_STATES
// exactly as "finished" is. With only "finished" added here, a cancelled task would be
// unreachable from this board in either position of the toggle, which is a worse answer than a
// toggle whose label names the state reviewers actually look for.
export const ALL_STATES = [...NOT_FINISHED_STATES, 'finished', 'cancelled'];

// The two states a task STOPS at. Derived from the two lists above rather than restated, so a
// state added to either one can't leave this set silently wrong -- it is what the overdue signal
// below keys on ("past its due date" only means something while the task is still open).
export const CLOSED_STATES = ALL_STATES.filter(state => !NOT_FINISHED_STATES.includes(state));

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
            dueDate
            priority
            icsUrl(language: $language)
            possibleOutcomeDetails(language: $language) {
                name
                displayLabel
            }
            description
            workflowSummary
            viewerRole
            isAssignableToMe
            candidateDisplayNames
            simpleWorkflowTaskData {
                id
                comment
            }
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
    query TaskBoard($first: Int!, $after: String, $search: String, $sortBy: String, $sortOrder: String, $filterState: [String], $scope: String, $language: String) {
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
    query InitialTaskBoard($first: Int!, $filterState: [String], $sortBy: String, $sortOrder: String, $language: String) {
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

// The one-click fast path (#67): claim + complete in a single request, for an ACTIVE task the
// viewer is eligible to take. Deliberately a different mutation from COMPLETE_TASK_MUTATION rather
// than the same one behind a flag -- see TaskBoardMutationExtensions#reviewTask for why the two
// have different state guards, different RBAC and different failure semantics. A started task the
// viewer already owns keeps using completeTask; there is nothing left to claim there.
export const REVIEW_TASK_MUTATION = /* GraphQL */ `
    mutation ReviewTask($id: String!, $outcome: String!) {
        reviewTask(id: $id, outcome: $outcome) {
            id
        }
    }
`;

// One completion decision a started task offers. displayLabel is resolved server-side, in the
// workflow's own resource bundle (GqlTaskBoard#getPossibleOutcomeDetails) -- the client displays
// it verbatim and never derives a label from the name itself.
export type TaskBoardOutcome = {
    name: string;
    displayLabel: string;
};

export type TaskBoardNode = {
    id: string;
    title: string | null;
    creator: string | null;
    createdDate: string | null;
    owner: string | null;
    assigneeDisplayName: string | null;
    state: string | null;
    // ISO-8601 instant, as stored on the node's dueDate property; null for a task with no due
    // date at all (which is most workflow tasks -- only jnt:task declares a default for it).
    dueDate: string | null;
    // "low" | "normal" | "high" -- jnt:task's own choicelist (definitions.cnd). Kept a plain
    // string for the same reason viewerRole is: the server returns the stored value verbatim.
    priority: string | null;
    // Ready-made link to this task's iCalendar (.ics) rendering, built server-side (see
    // GqlTaskBoard#getIcsUrl) because the context path and workspace/locale URL shape are the
    // server's to know, not the island's. Null exactly when dueDate is null -- a VTODO without
    // a DUE line is what that view would otherwise fail to render.
    icsUrl: string | null;
    possibleOutcomeDetails: TaskBoardOutcome[];
    description: string | null;
    workflowSummary: string | null;
    // "assignee" | "candidate" | "none" -- kept as a plain string rather than a union, mirroring
    // the server's deliberately non-enum GraphQL field (see GqlTaskBoard#getViewerRole), so a role
    // added later doesn't turn into a type error here before anything consumes it.
    viewerRole: string;
    // Whether the viewer is owner-or-candidate for this task, i.e. eligible to claim it. Distinct
    // from viewerRole !== 'none' only in intent, but it is the field the one-click fast path gates
    // on: viewerRole is deliberately independent of canReviewAll (see GqlTaskBoard#getViewerRole),
    // so a reviewer acting on a task they are not a candidate for reads 'none' there.
    isAssignableToMe: boolean;
    candidateDisplayNames: string[];
    // The jnt:simpleWorkflow child carrying the reviewer's comment, when this task has one; null
    // for every plain task and for any other taskData node type.
    simpleWorkflowTaskData: {id: string; comment: string | null} | null;
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
 * What a row's due date means right now:
 * - "none": no due date at all (or an unparseable one) -- the Due cell renders empty.
 * - "due": it has one, and nothing is wrong with it.
 * - "overdue": the date has passed AND the task is still open.
 *
 * Lives here rather than in TaskBoard.client.tsx so it stays a pure, framework-free function of
 * its three arguments -- next to the state vocabulary (CLOSED_STATES) it is defined against, and
 * runnable on its own, unlike anything in a module that imports Moonstone. Rendering (formatting
 * the date, choosing the chip) stays in the component; this decides only which of the three cases
 * a row is in.
 *
 * "now" is an argument, not a Date.now() call inside: the whole point of this function is that its
 * answer is a function of the instant it is asked about, so that instant has to be something a
 * caller (or a check of this logic) can state.
 */
export type DueStatus = 'none' | 'due' | 'overdue';

export function dueStatus(dueDate: string | null, state: string | null, now: number = Date.now()): DueStatus {
    if (!dueDate) {
        return 'none';
    }

    const due = new Date(dueDate).getTime();
    if (Number.isNaN(due)) {
        // An unparseable stored value is "no usable due date", not "overdue": the row still has to
        // render, and flagging it red would be an assertion this function can't actually make.
        return 'none';
    }

    // A finished or cancelled task is never overdue, however long ago its date passed: the work
    // stopped, so the deadline stopped meaning anything. Only reachable with the board's "Show
    // finished" toggle on, which is exactly when a screenful of red would be pure noise.
    if (state !== null && CLOSED_STATES.includes(state)) {
        return 'due';
    }

    return due < now ? 'overdue' : 'due';
}

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
