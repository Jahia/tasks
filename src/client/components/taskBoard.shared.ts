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

// Every field a board row needs, written once and spliced into both queries below -- the initial
// fetch and the paging/filtering one ask for identical rows, and a row field added to one of them
// only is a row that renders differently before and after the first interaction.
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

// Which scope the board opens on: "All tasks", always (#61). Every viewer sees the whole board
// they are entitled to see first, and narrows it themselves with the scope tabs -- rather than
// landing on a pre-filtered subset whose emptiness (or smallness) reads as "there is nothing
// here" when there usually is. Kept a named constant rather than inlined at both entry points, so
// the client default and the initial query below can't drift apart.
//
// Replaces #61's pickInitialScope(), which opened on the first NON-EMPTY of assignedToMe /
// claimable / all. That function was the only consumer of the other two scopes' pages, so
// dropping it also drops two thirds of the initial query -- see below.
//
// Typed as the literal scope it is, NOT widened to TaskScope: both entry points index the initial
// result with it (result[INITIAL_SCOPE]), and that result only carries the one scope's page --
// widening the type here would make those lookups an "implicitly any" compile error rather than
// the checked field access they are.
export const INITIAL_SCOPE: typeof SCOPE_ALL = SCOPE_ALL;

// Used only by the two entry points for the first page: adds the viewer fields the client island
// needs for its action display logic (see TaskBoardQueryExtensions#taskBoardCurrentUserKey/
// #taskBoardCanReviewAll), and fetches page 1 of the scope the board opens on.
//
// ONE page, not the three aliased ones #61 fetched. Those three existed solely to decide the
// opening scope from real rows; with that decision now fixed at INITIAL_SCOPE, the other two
// pages were fetched and discarded on every single board load. Nothing else consumed them: the
// scope tabs carry no counts (see SCOPE_OPTIONS in TaskBoard.client.tsx), and switching scope
// re-fetches page 1 of the new scope anyway (the effect on `scope` in that file), so there was no
// instant-switch cache to preserve either.
//
// Still an aliased field rather than a plain `taskBoard`, so the result keeps the shape both
// entry points index with (result[INITIAL_SCOPE]) and a second scope could be added back here
// without changing them.
export const INITIAL_TASK_BOARD_QUERY = /* GraphQL */ `
    query InitialTaskBoard($first: Int!, $filterState: [String], $sortBy: String, $sortOrder: String, $language: String) {
        ${INITIAL_SCOPE}: taskBoard(first: $first, filterState: $filterState, sortBy: $sortBy, sortOrder: $sortOrder, scope: "${INITIAL_SCOPE}") {
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

// Keyed by INITIAL_SCOPE's own value (SCOPE_ALL), so the type follows the query's alias rather
// than restating it: both entry points read result[INITIAL_SCOPE].
export type InitialTaskBoardQueryResult = {
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
