import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Banner, Button, Chip, DataTable, EmptyData, Header, Input, Loader, Search, Tab, TabItem, Typography} from '@jahia/moonstone';
// Type-only, so nothing is imported at runtime from this subpath: the DataTable *component* comes
// from the package root above (moonstone re-exports it there), but its column/sort types are only
// published under the './DataTable' export condition.
import type {DataTableColumn} from '@jahia/moonstone/DataTable';
// Deep import, not the package's bare '@jahia/moonstone-alpha' entry point: that barrel
// (dist/components/index.js) re-exports Checkbox/DatePicker/etc. too, which drag in transitive
// deps (e.g. @react-aria/focus) this module never installs and doesn't otherwise need -- see
// the matching deep path in moonstone-alpha.d.ts.
import {ContentLayout} from '@jahia/moonstone-alpha/dist/components/ContentLayout';
import {callGraphQL} from '../lib/graphqlClient';
import {
    ASSIGN_TASK_TO_ME_MUTATION,
    COMPLETE_TASK_MUTATION,
    DEFAULT_SORT_BY,
    DEFAULT_SORT_ORDER,
    NOT_FINISHED_STATES,
    RESUME_TASK_MUTATION,
    SCOPE_ALL,
    SCOPE_ASSIGNED_TO_ME,
    SCOPE_CLAIMABLE,
    SUSPEND_TASK_MUTATION,
    TASK_BOARD_QUERY,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import type {TaskBoardConnection, TaskBoardNode, TaskScope} from './taskBoard.shared';
import {capitalize, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import './TaskBoard.client.css';

export const DEFAULT_PAGE_SIZE = 25;
const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
// Debounce so every keystroke doesn't fire its own request -- this is a server round-trip
// (TaskBoardQueryExtensions#taskBoard filters title/creator/assignee/state), not a client-side
// filter over an already-loaded page.
const SEARCH_DEBOUNCE_MS = 350;

// Every user-visible string on this board, gathered in one object. NOT an i18n mechanism (that's
// #62) -- just the single place #62 has to reach into, instead of thirty inline literals.
const labels = {
    boardTitle: 'Tasks',
    columnTask: 'Task',
    columnWaiting: 'Waiting',
    columnOwner: 'Owner',
    columnState: 'State',
    columnActions: 'Actions',
    scopeAssignedToMe: 'Assigned to me',
    scopeClaimable: 'Available to my group(s)',
    scopeAll: 'All tasks',
    searchLabel: 'Search:',
    searchPlaceholder: 'Search tasks...',
    untitledTask: 'Untitled task',
    unassigned: 'Unassigned',
    unknownCreator: 'Unknown',
    noActions: 'No actions available',
    emptyBoard: 'No tasks to show.',
    errorTitle: 'Something went wrong',
    loadError: 'Unable to load tasks.',
    actionError: 'Unable to complete this action.',
    actionAssignToMe: 'Assign to me',
    actionUnassign: 'Unassign',
    actionStart: 'Start',
    actionSuspend: 'Suspend',
    actionResume: 'Resume',
    actionPreview: 'Preview',
    outcomePublish: 'Publish',
    outcomeReject: 'Reject publication',
    waitingToday: 'today',
    waitingUnknown: 'unknown',
    taskCount: (count: number) => `${count} task(s)`,
    waitingDays: (days: number) => (days === 1 ? '1 day' : `${days} days`),
    waitingWeeks: (weeks: number) => (weeks === 1 ? '1 week' : `${weeks} weeks`),
    createdBy: (creator: string, date: string) => `Created by: ${creator}, on ${date}`,
    availableTo: (names: string) => `Available to: ${names}`
};

type ChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'reassuring' | 'light';

// active: ready to be picked up. started: in progress. suspended: parked. finished: done.
const STATE_CHIP_COLOR: Record<string, ChipColor> = {
    active: 'accent',
    started: 'warning',
    suspended: 'light',
    finished: 'success'
};

// ---------------------------------------------------------------------------------------------
// Waiting duration
// ---------------------------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
// Past this many whole days the duration reads in weeks instead of days, so a months-old task
// says "9 weeks" rather than "64 days".
const WAITING_WEEKS_FROM_DAYS = 14;
// Escalation thresholds. The colour is never the only carrier of this information -- the chip's
// own text always states the duration, so the same escalation is readable without seeing colour.
const WAITING_WARNING_DAYS = 5;
const WAITING_DANGER_DAYS = 10;
// createdDate is nullable (a task whose jcr:created can't be read), and this column has to sort
// and render regardless: one sentinel, checked in both places, rather than a nullable number.
const WAITING_UNKNOWN = -1;

// Whole 24h periods elapsed, not calendar days: "created 25 hours ago" is 1 day here even if that
// crosses two midnights. Deliberate -- this is an age/SLA indicator ("how long has this been
// sitting?"), and elapsed time is what that question means.
function waitingDaysSince(createdDate: string | null): number {
    if (!createdDate) {
        return WAITING_UNKNOWN;
    }

    const created = new Date(createdDate).getTime();
    if (Number.isNaN(created)) {
        return WAITING_UNKNOWN;
    }

    // Clamped at 0: a task whose jcr:created is slightly in the future (clock skew between the
    // server that wrote it and the browser reading it) is "today", not a negative age.
    return Math.max(0, Math.floor((Date.now() - created) / MS_PER_DAY));
}

function waitingLabel(days: number): string {
    if (days === WAITING_UNKNOWN) {
        return labels.waitingUnknown;
    }

    if (days === 0) {
        return labels.waitingToday;
    }

    if (days < WAITING_WEEKS_FROM_DAYS) {
        return labels.waitingDays(days);
    }

    return labels.waitingWeeks(Math.floor(days / DAYS_PER_WEEK));
}

function waitingColor(days: number): ChipColor {
    if (days === WAITING_UNKNOWN) {
        return 'default';
    }

    if (days > WAITING_DANGER_DAYS) {
        return 'danger';
    }

    if (days > WAITING_WARNING_DAYS) {
        return 'warning';
    }

    return 'default';
}

// ---------------------------------------------------------------------------------------------
// Sorting: table columns <-> server sort arguments
// ---------------------------------------------------------------------------------------------

type SortDirection = 'ascending' | 'descending';

// One row of the table. The two synthetic fields exist because a DataTable column key must be a
// key of the row type: 'waitingDays' is the value the Waiting column sorts and renders, and
// 'actions' is a column that has no value at all (its cell is built from the whole row).
type TaskRow = TaskBoardNode & {
    waitingDays: number;
    actions: null;
};

type SortableColumn = 'title' | 'waitingDays' | 'owner' | 'state';

// Which taskBoard(sortBy:) argument each sortable column maps to. 'waitingDays' is the only one
// that isn't a straight rename: waiting duration isn't stored anywhere, it's derived from
// jcr:created, and the server sorts on the raw property (which is also what keeps this column on
// the query-level fast path, #64 -- the other three are resolved-value sorts and scan).
const COLUMN_SORT_ARGUMENT: Record<SortableColumn, string> = {
    title: 'title',
    waitingDays: 'jcr:created',
    owner: 'owner',
    state: 'state'
};

const SORT_ARGUMENT_COLUMN: Record<string, SortableColumn> = {
    title: 'title',
    'jcr:created': 'waitingDays',
    owner: 'owner',
    state: 'state'
};

// Waiting duration runs BACKWARDS from creation date: the longest-waiting task is the oldest one,
// so "waiting, descending" has to ask the server for jcr:created ascending. Applied in both
// directions by this one helper, so the column header's arrow always means what the column says
// ("most waiting first") rather than what the underlying property does.
function invertsDirection(column: SortableColumn): boolean {
    return column === 'waitingDays';
}

function toSortArgument(column: SortableColumn, direction: SortDirection): {sortBy: string; sortOrder: SortDirection} {
    const flipped: SortDirection = direction === 'ascending' ? 'descending' : 'ascending';
    return {
        sortBy: COLUMN_SORT_ARGUMENT[column],
        sortOrder: invertsDirection(column) ? flipped : direction
    };
}

// The board's default sort (taskBoard.shared.ts) expressed as a table column + header direction,
// derived rather than restated so the two can't drift apart.
const DEFAULT_SORT_COLUMN: SortableColumn = SORT_ARGUMENT_COLUMN[DEFAULT_SORT_BY] ?? 'waitingDays';
const DEFAULT_SORT_DIRECTION: SortDirection = (() => {
    if (!invertsDirection(DEFAULT_SORT_COLUMN)) {
        return DEFAULT_SORT_ORDER;
    }

    return DEFAULT_SORT_ORDER === 'ascending' ? 'descending' : 'ascending';
})();

// ---------------------------------------------------------------------------------------------

type TaskBoardProps = {
    initialConnection: TaskBoardConnection;
    initialScope: TaskScope;
    graphqlEndpoint: string;
    currentUserKey: string;
    canReviewAll: boolean;
};

// All three are offered to every viewer, reviewer or not. "All tasks" is not a reviewer-only
// switch: for a contributor it means the union they can already see (owned + created + candidate),
// which is exactly the board they had before this control existed.
const SCOPE_OPTIONS: Array<{scope: TaskScope; label: string}> = [
    {scope: SCOPE_ASSIGNED_TO_ME, label: labels.scopeAssignedToMe},
    {scope: SCOPE_CLAIMABLE, label: labels.scopeClaimable},
    {scope: SCOPE_ALL, label: labels.scopeAll}
];

// One button per outcome the task actually declares (workflow-specific --
// see TaskBoardMutationExtensions#completeTask). Common synonyms get the
// checklist's fixed labels; anything else falls back to its own raw label.
function outcomeLabel(outcome: string): string {
    const normalized = outcome.toLowerCase();
    if (/publi|approve|accept|finish/.test(normalized)) {
        return labels.outcomePublish;
    }

    if (/reject|refuse|deny|decline/.test(normalized)) {
        return labels.outcomeReject;
    }

    return capitalize(outcome);
}

// "2026-07-20T11:39:20.123Z" -> "July 20, 2026". Formatted client-side (rather than baking a fixed
// locale into the server's ISO-8601 getCreatedDate()) so it can follow the viewer's own locale
// later; hardcoded to 'en-US' for now, matching every other hardcoded English label in this file.
// Module-scope singleton: a row is rendered per page row, so hoisting this out of the formatter
// avoids allocating a new Intl.DateTimeFormat on every render.
const CREATED_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'long', day: 'numeric'});

function formatCreatedDate(iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return CREATED_DATE_FORMAT.format(date);
}

type MenuAction = {
    label: string;
    mutation: string;
    variables: {id: string} & Record<string, unknown>;
};

type TaskActionsProps = {
    task: TaskBoardNode;
    currentUserKey: string;
    canReviewAll: boolean;
    isBusy: boolean;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
};

// Same state/ownership rules as before this component's redesign -- just rendered as visible,
// always-on-screen buttons now instead of a 3-dot menu. TaskBoardMutationExtensions
// independently re-checks every one of these server-side and is the real security boundary; a
// wrong guess here just surfaces as an error banner.
function TaskActions({task, currentUserKey, canReviewAll, isBusy, onAction}: Readonly<TaskActionsProps>) {
    const canAct = task.owner === currentUserKey || canReviewAll;
    const targetUrl = task.targetNode?.url;
    // Three phases, not two: Unassigned (active, no owner) -> Assigned (active, owned, not yet
    // started) -> Active/In-Progress (started). assignTaskToMe deliberately leaves state
    // "active" (see its own comment), so "owner present" is what distinguishes Assigned from
    // Unassigned within that one state value; "Start" (updateTaskState -> "started") is the only
    // way from Assigned into Active/In-Progress.
    const isUnassigned = !task.owner;
    const primaryActions: MenuAction[] = [];
    // Kept visually separated (own row below) from primaryActions: these are workflow publication
    // decisions, not routine task-management actions.
    const decisionActions: MenuAction[] = [];
    let showPreview = false;

    if (task.state === 'active' && isUnassigned) {
        primaryActions.push({label: labels.actionAssignToMe, mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}});
    } else if (canAct && task.state === 'active') {
        // Assigned, not started yet.
        primaryActions.push(
            {label: labels.actionUnassign, mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            {label: labels.actionStart, mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}}
        );
    } else if (canAct && task.state === 'started') {
        primaryActions.push(
            {label: labels.actionUnassign, mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            {label: labels.actionSuspend, mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}}
        );
        showPreview = true;
        // Reject publication before Publish, matching the requested layout order, regardless of
        // the order possibleOutcomes happens to list them in (workflow-definition-specific).
        const outcomes = task.possibleOutcomes
            .map(outcome => ({outcome, label: outcomeLabel(outcome)}))
            .sort((a, b) => Number(a.label !== labels.outcomeReject) - Number(b.label !== labels.outcomeReject));
        for (const {outcome, label} of outcomes) {
            decisionActions.push({label, mutation: COMPLETE_TASK_MUTATION, variables: {id: task.id, outcome}});
        }
    } else if (canAct && task.state === 'suspended') {
        primaryActions.push({label: labels.actionResume, mutation: RESUME_TASK_MUTATION, variables: {id: task.id}});
    }

    if (primaryActions.length === 0 && decisionActions.length === 0 && !showPreview) {
        return <Typography variant="caption" weight="light">{labels.noActions}</Typography>;
    }

    return (
        <div className="task-board__actions">
            <div className="task-board__actions-row">
                {primaryActions.map(action => (
                    <Button
                        key={action.mutation}
                        label={action.label}
                        size="small"
                        isDisabled={isBusy}
                        onClick={() => onAction(action.mutation, action.variables)}
                    />
                ))}
                {showPreview && targetUrl && (
                    <Button
                        label={labels.actionPreview}
                        size="small"
                        variant="ghost"
                        isDisabled={isBusy}
                        onClick={() => window.open(targetUrl, '_blank', 'noopener,noreferrer')}
                    />
                )}
            </div>
            {decisionActions.length > 0 && (
                <div className="task-board__actions-row task-board__actions-row--decisions">
                    {decisionActions.map(action => (
                        <Button
                            key={String(action.variables.outcome)}
                            label={action.label}
                            size="small"
                            color="accent"
                            isDisabled={isBusy}
                            onClick={() => onAction(action.mutation, action.variables)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

type TaskCellProps = {
    task: TaskRow;
    showCandidates: boolean;
};

// The Task column's cell. Everything the card layout showed above the badges lives here as
// secondary lines rather than being dropped: the workflow summary (or, for a plain jnt:task, its
// own description) and who created it when. Chosen over an expandable row because the summary is
// a single line the reviewer scans while triaging -- hiding it behind a per-row toggle would make
// the common case (read it) cost a click.
function TaskCell({task, showCandidates}: Readonly<TaskCellProps>) {
    const targetTitle = task.targetNode?.property?.value;
    const createdDate = formatCreatedDate(task.createdDate);
    // The workflow-engine-derived summary (TaskBoardQueryExtensions#getWorkflowSummary) is only
    // available for a jnt:workflowTask whose process is still live; a plain jnt:task, or one
    // whose summary couldn't be resolved, falls back to its own free-text description instead.
    const summaryLine = task.workflowSummary ?? task.description;

    return (
        <div className="task-board__task-cell">
            <div className="task-board__task-title">
                <Typography component="span" weight="semiBold" variant="body">
                    {task.title ?? labels.untitledTask}
                </Typography>
                {targetTitle && task.targetNode?.url && (
                    <a
                        className="task-board__target-link"
                        href={task.targetNode.url}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {targetTitle}
                    </a>
                )}
            </div>
            {summaryLine && (
                <Typography component="p" variant="body" className="task-board__summary">
                    {summaryLine}
                </Typography>
            )}
            {createdDate && (
                <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                    {labels.createdBy(task.creator ?? labels.unknownCreator, createdDate)}
                </Typography>
            )}
            {showCandidates && task.candidateDisplayNames.length > 0 && (
                <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                    {labels.availableTo(task.candidateDisplayNames.join(', '))}
                </Typography>
            )}
        </div>
    );
}

export default function TaskBoard({initialConnection, initialScope, graphqlEndpoint, currentUserKey, canReviewAll}: Readonly<TaskBoardProps>) {
    const [currentPage, setCurrentPage] = useState(1);
    const [connection, setConnection] = useState(initialConnection);
    const [isLoading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
    const [itemsPerPage, setItemsPerPage] = useState(DEFAULT_PAGE_SIZE);
    const [scope, setScope] = useState<TaskScope>(initialScope);
    // searchInput is what the box shows on every keystroke; search is the debounced value
    // that actually goes into the query (see SEARCH_DEBOUNCE_MS above).
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    // Held as the TABLE's column + direction, not as the server's sortBy/sortOrder: that's what
    // the sorted column header renders, and toSortArgument() derives the query arguments from it.
    const [sortColumn, setSortColumn] = useState<SortableColumn>(DEFAULT_SORT_COLUMN);
    const [sortDirection, setSortDirection] = useState<SortDirection>(DEFAULT_SORT_DIRECTION);
    // Relay-style cursor pagination only supports moving forward one page at a
    // time; this caches the cursor needed to fetch each page once it has been
    // reached, so navigating back to an already-visited page doesn't require
    // re-fetching every page before it.
    const cursorsByPage = useRef<Map<number, string | undefined>>(new Map([[1, undefined]]));

    useEffect(() => {
        if (connection.pageInfo.hasNextPage) {
            cursorsByPage.current.set(currentPage + 1, connection.pageInfo.endCursor ?? undefined);
        }
    }, [currentPage, connection.pageInfo.hasNextPage, connection.pageInfo.endCursor]);

    useEffect(() => {
        const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [searchInput]);

    const loadPage = useCallback(async (page: number) => {
        setLoading(true);
        setError(null);
        try {
            const data = await callGraphQL<{taskBoard: TaskBoardConnection}>(graphqlEndpoint, TASK_BOARD_QUERY, {
                first: itemsPerPage,
                after: cursorsByPage.current.get(page),
                search: search === '' ? null : search,
                ...toSortArgument(sortColumn, sortDirection),
                filterState: NOT_FINISHED_STATES,
                scope
            });
            setConnection(data.taskBoard);
            setCurrentPage(page);
        } catch (e) {
            setError(e instanceof Error ? e.message : labels.loadError);
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint, itemsPerPage, search, sortColumn, sortDirection, scope]);

    // itemsPerPage/search/sort/scope all change what the *first* page even means, so none of them
    // can be applied by just re-fetching the current page -- every cached cursor is invalidated and
    // this always jumps back to page 1. Skipped on mount: initialConnection already is page 1 of
    // initialScope at the (unchanged) defaults.
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }

        cursorsByPage.current = new Map([[1, undefined]]);
        loadPage(1);
        // Deliberately reacts only to the five inputs that redefine page 1: loadPage already
        // closes over all of them (declared above) plus graphqlEndpoint/currentPage, which this
        // effect doesn't care about.
    }, [itemsPerPage, search, sortColumn, sortDirection, scope]);

    const handlePageChange = (nextPage: number) => {
        // Clamp forward jumps to one page at a time -- see the cursor cache
        // comment above for why arbitrary jumps aren't possible here.
        const target = nextPage <= currentPage ? Math.max(1, nextPage) : currentPage + 1;
        if (target !== currentPage) {
            loadPage(target);
        }
    };

    // DataTable reports the clicked column by key; anything that isn't one of the board's four
    // sortable columns (it shouldn't be -- only those declare isSortable) is ignored rather than
    // sent to the server as an unknown sortBy.
    const handleSortChange = useCallback((column: string, direction: SortDirection) => {
        if (!(column in COLUMN_SORT_ARGUMENT)) {
            return;
        }

        setSortColumn(column as SortableColumn);
        setSortDirection(direction);
    }, []);

    const handleAction = useCallback(async (mutation: string, variables: Record<string, unknown>) => {
        setBusyTaskId(String(variables.id));
        setError(null);
        try {
            await callGraphQL(graphqlEndpoint, mutation, variables);
            await loadPage(currentPage);
        } catch (e) {
            setError(e instanceof Error ? e.message : labels.actionError);
        } finally {
            setBusyTaskId(null);
        }
    }, [graphqlEndpoint, currentPage, loadPage]);

    const rows: TaskRow[] = useMemo(() => connection.edges.map(edge => ({
        ...edge.node,
        waitingDays: waitingDaysSince(edge.node.createdDate),
        actions: null
    })), [connection]);

    const columns: Array<DataTableColumn<TaskRow>> = useMemo(() => [
        {
            key: 'title',
            label: labels.columnTask,
            isSortable: true,
            // Only shown in the claimable scope: everywhere else the row is either already
            // someone's or listed alongside tasks that aren't offered to anyone in particular,
            // and a "who else could take this" line would just be noise.
            render: ({data}) => <TaskCell task={data} showCandidates={scope === SCOPE_CLAIMABLE}/>
        },
        {
            key: 'waitingDays',
            label: labels.columnWaiting,
            width: '120px',
            isSortable: true,
            render: ({data}) => (
                <Chip
                    label={waitingLabel(data.waitingDays)}
                    color={waitingColor(data.waitingDays)}
                />
            )
        },
        {
            key: 'owner',
            label: labels.columnOwner,
            width: '160px',
            isSortable: true,
            render: ({data}) => (
                <Typography variant="body">{data.assigneeDisplayName ?? labels.unassigned}</Typography>
            )
        },
        {
            key: 'state',
            label: labels.columnState,
            width: '120px',
            isSortable: true,
            render: ({data}) => (
                <Chip label={capitalize(data.state)} color={(data.state && STATE_CHIP_COLOR[data.state]) || 'default'}/>
            )
        },
        {
            key: 'actions',
            label: labels.columnActions,
            width: '280px',
            render: ({data}) => (
                <TaskActions
                    task={data}
                    currentUserKey={currentUserKey}
                    canReviewAll={canReviewAll}
                    isBusy={busyTaskId === data.id}
                    onAction={handleAction}
                />
            )
        }
    ], [scope, currentUserKey, canReviewAll, busyTaskId, handleAction]);

    let boardContent;
    if (isLoading) {
        boardContent = <Loader/>;
    } else if (rows.length === 0) {
        boardContent = <EmptyData message={labels.emptyBoard}/>;
    } else {
        boardContent = (
            <DataTable
                enableSorting
                enablePagination
                data={rows}
                columns={columns}
                primaryKey="id"
                sortBy={sortColumn}
                sortDirection={sortDirection}
                onSortChange={handleSortChange}
                currentPage={currentPage}
                itemsPerPage={itemsPerPage}
                itemsPerPageOptions={ITEMS_PER_PAGE_OPTIONS}
                totalItems={connection.pageInfo.totalCount}
                onPageChange={handlePageChange}
                onItemsPerPageChange={setItemsPerPage}
            />
        );
    }

    return (
        <ContentLayout
            paper
            header={(
                <div style={{backgroundColor: 'white'}}>
                    <Header title={labels.boardTitle}/>
                </div>
            )}
            content={(
                <div className="task-board__content">
                    <Tab>
                        {SCOPE_OPTIONS.map(option => (
                            <TabItem
                                key={option.scope}
                                label={option.label}
                                isSelected={scope === option.scope}
                                onClick={() => setScope(option.scope)}
                            />
                        ))}
                    </Tab>
                    <div className="task-board__toolbar">
                        <Typography variant="caption" weight="light">{labels.taskCount(connection.pageInfo.totalCount)}</Typography>
                        <div className="task-board__search">
                            <Typography variant="body" weight="semiBold">{labels.searchLabel}</Typography>
                            <Input
                                className="task-board__search-input"
                                icon={<Search/>}
                                placeholder={labels.searchPlaceholder}
                                value={searchInput}
                                onChange={e => setSearchInput(e.target.value)}
                            />
                        </div>
                    </div>
                    {error && (
                        <Banner title={labels.errorTitle} variant="danger">
                            {error}
                        </Banner>
                    )}
                    {boardContent}
                </div>
            )}
        />
    );
}
