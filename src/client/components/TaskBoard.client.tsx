import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowDown, ArrowUp, Banner, Button, Chip, Dropdown, EmptyData, Header, Input, Loader, Search, Typography} from '@jahia/moonstone';
// Deep import, not the package's bare '@jahia/moonstone-alpha' entry point: that barrel
// (dist/components/index.js) re-exports Checkbox/DatePicker/etc. too, which drag in transitive
// deps (e.g. @react-aria/focus) this module never installs and doesn't otherwise need -- see
// the matching deep path in moonstone-alpha.d.ts.
import {ContentLayout} from '@jahia/moonstone-alpha/dist/components/ContentLayout';
import {callGraphQL} from '../lib/graphqlClient';
import {
    BOARD_COLUMNS,
    CLOSED_STATE,
    COMPLETE_TASK_MUTATION,
    DEFAULT_SCOPE,
    DEFAULT_SORT_BY,
    DEFAULT_SORT_ORDER,
    DEFAULT_VIEW_MODE,
    EMPTY_SCOPE_MESSAGE,
    isTaskViewMode,
    TASK_BOARD_QUERY,
    TASK_LIST_QUERY,
    TASK_SCOPES,
    VIEW_MODE_STORAGE_KEY,
    columnFirstsFrom,
    columnStep
} from './taskBoard.shared';
import type {
    BoardColumn,
    ColumnKey,
    ColumnLimits,
    TaskBoardConnection,
    TaskBoardNode,
    TaskBoardQueryResult,
    TaskListQueryResult,
    TaskScope,
    TaskViewMode
} from './taskBoard.shared';
import {announceCreatedListViewed, announceTaskClosed} from '../lib/closedTaskAlerts';
import {announceTaskChanged} from '../lib/assignedTaskAlerts';
import {UPDATE_TASK_STATE_MUTATION} from './task.shared';
import {
    descriptionWithoutPaths,
    dueTone,
    formatCreatedDate,
    formatDueDate,
    jcontentLanguage,
    locationUrl,
    preferListView,
    STATE_CHIP_COLOR,
    stateLabel,
    TaskActions
} from './taskPresentation.client';
import TaskListTable from './TaskListTable.client';
import './TaskBoard.client.css';

export const DEFAULT_PAGE_SIZE = 25;

// How many more rows a column's "show more" asks for each time.
const SHOW_MORE_STEP = DEFAULT_PAGE_SIZE;

// One stable object, not a fresh one per reset: setLimits(DEFAULT_LIMITS) when the limits already
// ARE the defaults has to be a no-op, or every change of search/sort/scope would fetch twice --
// once for the change itself and once for the new object identity.
const DEFAULT_LIMITS: ColumnLimits = Object.freeze({
    active: DEFAULT_PAGE_SIZE,
    started: DEFAULT_PAGE_SIZE,
    closed: DEFAULT_PAGE_SIZE
}) as ColumnLimits;
// Debounce so every keystroke doesn't fire its own request -- this is a server round-trip
// (TaskBoardQueryExtensions#taskBoard filters title/creator/assignee/state), not a client-side
// filter over an already-fully-loaded list.
const SEARCH_DEBOUNCE_MS = 350;

// 'jcr:created' is a raw JCR property rather than one of the board's resolved columns, and the
// server treats the two differently - see TaskBoardQueryExtensions#taskBoard, which sorts a raw
// property in the query and the resolved columns in memory. It is in the same list because to a
// reader they are all just "sort by".
// 'dueDate' is not in SORT_OPTIONS: the dropdown offers the board's own sorts, while the list's Due
// column header sets this one. Both end up in the same sortBy, which is why it belongs in the type
// even though nothing in the dropdown produces it.
type SortField = 'jcr:created' | 'title' | 'creator' | 'owner' | 'state' | 'dueDate';
type SortDirection = 'ascending' | 'descending';

const VIEW_MODE_OPTIONS: Array<{label: string; value: TaskViewMode}> = [
    {label: 'Board', value: 'board'},
    {label: 'List', value: 'list'}
];

const SORT_OPTIONS: Array<{label: string; value: SortField}> = [
    {label: 'Creation date', value: 'jcr:created'},
    {label: 'Task Name', value: 'title'},
    {label: 'Created by', value: 'creator'},
    // The server field is still called "owner" -- it sorts on the assignee - but nobody owns a
    // task, so the control says what it does.
    {label: 'Assigned to', value: 'owner'},
    {label: 'State', value: 'state'}
];

type TaskBoardProps = {
    // Translated by whoever mounts the board -- this file is bundled for the browser by Vite as
    // well as webpack, and neither bundle has a translation library of its own.
    title: string;
    initialColumns: TaskBoardQueryResult;
    graphqlEndpoint: string;
    currentUserKey: string;
    canReviewAll: boolean;
};

type TaskCardProps = {
    task: TaskBoardNode;
    currentUserKey: string;
    canReviewAll: boolean;
    isBusy: boolean;
    canDrag: boolean;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
    onDragStart: () => void;
    onDragEnd: () => void;
};

function TaskCard({task, currentUserKey, canReviewAll, isBusy, canDrag, onAction, onDragStart, onDragEnd}: Readonly<TaskCardProps>) {
    const targetTitle = task.targetNode?.property?.value;
    const createdDate = formatCreatedDate(task.createdDate);
    const closedDate = formatCreatedDate(task.closedDate);
    const language = jcontentLanguage();
    const dueLabel = formatDueDate(task.dueDate);
    const tone = dueTone(task.dueDate);
    // The workflow-engine-derived summary (TaskBoardQueryExtensions#getWorkflowSummary) is only
    // available for a jnt:workflowTask whose process is still live; a plain jnt:task, or one
    // whose summary couldn't be resolved, falls back to its own free-text description instead.
    const summaryLine = task.workflowSummary ?? descriptionWithoutPaths(task.description);
    // A closed task is a record of work rather than work, and the card says so before anything on
    // it is read: recessed, muted, its title struck through. See the --closed rules in the
    // stylesheet - all of it is styling, so nothing here has to be hidden or rearranged.
    const isClosed = task.state === CLOSED_STATE;
    // A deadline is not a footnote on the card, it is the reason to pick this card over the one
    // below it, so the whole card carries it: warm and outlined once the date is inside a week,
    // red and lifted off the page once it has passed. Only those two - a date a month out is
    // information, not a call to act, and highlighting it would leave nothing left to escalate to.
    //
    // Never on a closed card. Its due date is already neutralised (see the --closed rules), for
    // the same reason: hurrying somebody about work that is finished is noise, and dressing the
    // card up as urgent would be the loudest possible version of it.
    const dueHighlight = !isClosed && (tone === 'soon' || tone === 'late') ? ` task-board__card--due-${tone}` : '';

    return (
        <div
            className={`task-board__card${isClosed ? ' task-board__card--closed' : ''}${dueHighlight}${canDrag ? ' task-board__card--draggable' : ''}`}
            data-sel-due-highlight={tone ?? 'none'}
            draggable={canDrag}
            onDragStart={event => {
                // Firefox will not begin a drag with an empty dataTransfer, and the task's own id
                // is the natural payload -- though the board reads the dragged task from its own
                // state rather than back out of here, since it needs the whole node to decide
                // which columns will accept it.
                event.dataTransfer.setData('text/plain', task.id);
                event.dataTransfer.effectAllowed = 'move';
                onDragStart();
            }}
            onDragEnd={onDragEnd}
        >
            {/* Who raised it and who has it, on one line. "Assigned to" rather than "Owner":
                nobody owns a task, and the property behind it is the assignee. */}
            <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                {[
                    `Created by: ${task.creator ?? 'Unknown'}${createdDate ? `, on ${createdDate}` : ''}`,
                    `Assigned to: ${task.assigneeDisplayName ?? 'Unassigned'}`,
                    // Last, and only once there is one: the card reads in the order the task
                    // lived -- raised, handed to somebody, done.
                    ...(closedDate ? [`Closed on ${closedDate}`] : [])
                ].join(' · ')}
            </Typography>
            <div className="task-board__card-header">
                <Typography component="span" weight="semiBold" variant="body" className="task-board__title">
                    {task.title ?? 'Untitled task'}
                </Typography>
                {/* Beside the title, not on its own line: the state is what decides whether a
                    row is worth opening at all, so it reads with the name it belongs to. */}
                <Chip label={stateLabel(task.state)} color={(task.state && STATE_CHIP_COLOR[task.state]) || 'default'}/>
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
            {dueLabel && tone && (
                <Typography
                    component="p"
                    variant="caption"
                    className={`task-board__due task-board__due--${tone}`}
                    data-sel-due-tone={tone}
                >
                    {tone === 'late' ? `Overdue since ${dueLabel}` : `Due ${dueLabel}`}
                </Typography>
            )}
            {summaryLine && (
                <Typography component="p" variant="body" className="task-board__summary">
                    {summaryLine}
                </Typography>
            )}
            {/* What the task is about, named rather than pathed. One row per referenced node:
                targetNode is multi-valued and most tasks raised from the Content Types accordion
                point at several records. */}
            {task.targets.length > 0 && (
                <ul className="task-board__targets">
                    {task.targets.map(target => {
                        const location = locationUrl(target, language);
                        return (
                            <li key={target.uuid} className="task-board__target">
                                <Typography component="span" weight="semiBold" variant="body">
                                    {target.displayName}
                                </Typography>
                                <Typography component="span" variant="caption" weight="light">
                                    {target.typeName}
                                </Typography>
                                {/* No Edit on a closed task: the content is still named, because
                                    that is the record of what the work was about, but there is
                                    nothing left to do to it from here. The live cards keep it. */}
                                {location && !isClosed && (
                                    <Button
                                        size="default"
                                        variant="outlined"
                                        label="Edit"
                                        data-sel-role="target-edit"
                                        data-sel-target-in-page={String(target.inPage)}
                                        onClick={() => {
                                            // A new tab, not this one: the board is a working list
                                            // somebody is going down, and editing one item should
                                            // not cost them their place in it -- there are usually
                                            // several tasks to get through, and often several
                                            // targets on one task.
                                            //
                                            // preferListView writes localStorage, which the new tab
                                            // reads from the same origin, so it still decides what
                                            // is behind the editor once it is closed there.
                                            preferListView(location.site, location.mode);
                                            window.open(location.url, '_blank', 'noopener');
                                        }}
                                    />
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            <TaskActions
                task={task}
                currentUserKey={currentUserKey}
                canReviewAll={canReviewAll}
                isBusy={isBusy}
                onAction={onAction}
            />
        </div>
    );
}

type DragState = {
    task: TaskBoardNode;
    from: ColumnKey;
};

/**
 * Why this card cannot be dropped in that column, as a sentence to show the reader, or null when
 * it can.
 *
 * The server re-checks all of it (TaskBoardMutationExtensions#updateTaskState takes any state it
 * is given from anyone who may act on the task), so this is not the security boundary -- it is
 * what stops a drag from producing a state nobody meant.
 *
 * The step check is the rule the user asked for: one column at a time, forward or back. Dropping a
 * card back into the column it came from is not a refusal, it is simply nothing to do.
 */
function dropRefusal(drag: DragState, to: ColumnKey, currentUserKey: string, canReviewAll: boolean): string | null {
    const step = columnStep(drag.from, to);
    if (step === 0) {
        return null;
    }

    if (Math.abs(step) !== 1) {
        return 'A task moves one column at a time.';
    }

    if (drag.task.owner !== currentUserKey && !canReviewAll) {
        return 'Only the person this task is assigned to can move it.';
    }

    // An unassigned task in the Active column is one nobody has taken. Starting or closing it
    // would leave work in progress that belongs to no one, so it gets taken first -- which is the
    // "Assign to me" button already on the card.
    if (!drag.task.owner) {
        return 'Nobody holds this task yet -- use "Assign to me" first.';
    }

    // The same rule the card's own Close button follows: completeTask writes finalOutcome in the
    // same save because the workflow rule reads it off the node, and a workflow task finished
    // without one tells the real workflow nothing. Its decision buttons are how it closes.
    if (to === 'closed' && drag.task.taskType === 'jnt:workflowTask') {
        return 'A workflow task is closed by its own decision, not by moving it.';
    }

    return null;
}

type BoardColumnViewProps = {
    column: BoardColumn;
    connection: TaskBoardConnection;
    currentUserKey: string;
    canReviewAll: boolean;
    busyTaskId: string | null;
    dragging: DragState | null;
    isUnderPointer: boolean;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
    onDragStart: (drag: DragState) => void;
    onDragEnd: () => void;
    onHover: (key: ColumnKey) => void;
    onDrop: (key: ColumnKey) => void;
    onShowMore: (key: ColumnKey) => void;
};

function BoardColumnView({
    column, connection, currentUserKey, canReviewAll, busyTaskId, dragging, isUnderPointer,
    onAction, onDragStart, onDragEnd, onHover, onDrop, onShowMore
}: Readonly<BoardColumnViewProps>) {
    const rows = connection.edges.map(edge => edge.node);
    const total = connection.pageInfo.totalCount;

    // What this column looks like while a card is in hand: lifted if that card could land here,
    // dimmed if it could not. Neither, for the column the card is already in -- a drop back where
    // it started is nothing to do, and highlighting it would promise a move.
    const refusal = dragging ? dropRefusal(dragging, column.key, currentUserKey, canReviewAll) : null;
    const wouldMove = dragging !== null && columnStep(dragging.from, column.key) !== 0;
    let dragClass = '';
    if (wouldMove) {
        dragClass = refusal ? ' task-board__column--blocked' : ' task-board__column--open';
        if (isUnderPointer) {
            dragClass += ' task-board__column--over';
        }
    }

    return (
        <section
            className={`task-board__column${dragClass}`}
            aria-label={`${column.label}, ${total} task(s)`}
            onDragEnter={() => onHover(column.key)}
            onDragOver={event => {
                // preventDefault is what makes this a drop target at all, and it runs even for a
                // move that will be refused: onDrop is the only place that can say WHY, and the
                // reason is worth more to the reader than a no-drop cursor. The cursor still says
                // it too, via dropEffect.
                event.preventDefault();
                event.dataTransfer.dropEffect = refusal ? 'none' : 'move';
            }}
            onDrop={event => {
                event.preventDefault();
                onDrop(column.key);
            }}
        >
            <header className="task-board__column-header">
                <Typography variant="subheading" weight="semiBold">{column.label}</Typography>
                <Chip label={String(total)} color="light"/>
            </header>
            <div className="task-board__column-body">
                {rows.length === 0 && (
                    <Typography variant="caption" weight="light" className="task-board__column-empty">
                        Nothing here.
                    </Typography>
                )}
                {rows.map(task => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        currentUserKey={currentUserKey}
                        canReviewAll={canReviewAll}
                        isBusy={busyTaskId === task.id}
                        // Same test the card's own buttons use: somebody who cannot act on a task
                        // cannot move it either, so it does not offer a drag that would be refused.
                        canDrag={task.owner === currentUserKey || canReviewAll}
                        onAction={onAction}
                        onDragStart={() => onDragStart({task, from: column.key})}
                        onDragEnd={onDragEnd}
                    />
                ))}
                {connection.pageInfo.hasNextPage && (
                    <Button
                        variant="ghost"
                        size="small"
                        label={`Show more (${rows.length} of ${total})`}
                        onClick={() => onShowMore(column.key)}
                    />
                )}
            </div>
        </section>
    );
}

export default function TaskBoard({title, initialColumns, graphqlEndpoint, currentUserKey, canReviewAll}: Readonly<TaskBoardProps>) {
    const [columns, setColumns] = useState(initialColumns);
    // How many rows each column is asking for. Per column, so "show more" on a long Closed list
    // does not also re-fetch the two beside it.
    const [limits, setLimits] = useState<ColumnLimits>(DEFAULT_LIMITS);
    const [isLoading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A refused drag is not a failure, it is a rule -- so it gets its own banner rather than
    // "Something went wrong", which would tell somebody the board is broken when it is working
    // exactly as intended.
    const [notice, setNotice] = useState<string | null>(null);
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
    // searchInput is what the box shows on every keystroke; search is the debounced value
    // that actually goes into the query (see SEARCH_DEBOUNCE_MS above).
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    // Always a concrete field/direction (never "unsorted") -- see DEFAULT_SORT_BY/_ORDER's own
    // comment for why: the sort-by dropdown always needs a real value to display.
    const [sortBy, setSortBy] = useState<SortField>(DEFAULT_SORT_BY as SortField);
    const [sortOrder, setSortOrder] = useState<SortDirection>(DEFAULT_SORT_ORDER as SortDirection);
    // Which of the three lists is showing (see TASK_SCOPES). Single-select: they are alternative
    // answers to "which tasks", not filters that stack.
    const [scope, setScope] = useState<TaskScope>(DEFAULT_SCOPE);
    // Board or list. Read from the viewer's last choice on first render rather than in an effect,
    // so the remembered view is the first thing painted instead of the board appearing and being
    // replaced. A lazy initializer, so the storage read happens once and not on every render.
    const [viewMode, setViewMode] = useState<TaskViewMode>(() => {
        try {
            const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
            return isTaskViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
        } catch {
            // A private window, or site data blocked. The board is the documented default.
            return DEFAULT_VIEW_MODE;
        }
    });
    // The list's own rows, kept apart from the board's three columns: they come from a different
    // query (TASK_LIST_QUERY, one connection over every state) and neither view can be derived
    // from the other -- the board's pages are per column, so joining them would show whatever each
    // column happened to have fetched rather than the first N tasks overall.
    const [list, setList] = useState<TaskBoardConnection | null>(null);
    const [listLimit, setListLimit] = useState(DEFAULT_PAGE_SIZE);
    // The card in hand, whole rather than by id: deciding which columns will take it needs its
    // assignee and its node type, not just which row it is.
    //
    // Held twice, deliberately. The state drives the columns' drag highlighting, which needs a
    // render to show. The ref is what the DROP reads, and it has to be a ref: a state update from
    // dragstart is not visible to a handler that runs before React has re-rendered, and nothing
    // guarantees a render happens in between - dispatch the two in one task and the drop reads the
    // value from before the drag began, which is null, and silently does nothing.
    const dragRef = useRef<DragState | null>(null);
    const [dragging, setDragging] = useState<DragState | null>(null);
    const [dropTarget, setDropTarget] = useState<ColumnKey | null>(null);

    const beginDrag = useCallback((drag: DragState) => {
        dragRef.current = drag;
        setDragging(drag);
    }, []);

    useEffect(() => {
        const handle = setTimeout(() => {
            setSearch(searchInput.trim());
            // A new search changes what every column holds, so none of them keeps a raised limit.
            setLimits(DEFAULT_LIMITS);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [searchInput]);

    const loadBoard = useCallback(async () => {
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
            const shared = {
                search: search === '' ? null : search,
                sortBy,
                sortOrder,
                scope
            };
            if (viewMode === 'list') {
                // One connection over every state (see TASK_LIST_QUERY), because the table shows
                // them together and sorts across them -- a sort that only ordered within each
                // column would not be a sorted list at all.
                const data = await callGraphQL<TaskListQueryResult>(graphqlEndpoint, TASK_LIST_QUERY, {
                    first: listLimit,
                    ...shared
                });
                setList(data.tasks);
            } else {
                // All three columns in one document (see TASK_BOARD_QUERY): they share the search,
                // the sort and the scope, and fetching them together keeps them consistent with
                // each other as well as saving two round trips.
                const data = await callGraphQL<TaskBoardQueryResult>(graphqlEndpoint, TASK_BOARD_QUERY, {
                    ...columnFirstsFrom(limits),
                    ...shared
                });
                setColumns(data);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to load tasks.');
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint, viewMode, limits, listLimit, search, sortBy, sortOrder, scope]);

    // Every input to the query is already in loadBoard's dependency list, so "re-fetch when
    // something changed" is exactly "re-fetch when loadBoard changed" -- there is no second list
    // here to drift out of step with that one.
    //
    // The mount skip applies to the board only: initialColumns IS that fetch, at these same
    // defaults (see initialBoardVariables). A viewer whose remembered view is the list has no
    // initial rows for it, so that first render does have to fetch -- which is also why switching
    // to the list fetches rather than reusing anything.
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            if (viewMode !== 'list') {
                return;
            }
        }

        loadBoard();
        // Keyed on loadBoard alone: viewMode is read above only to decide whether the mount fetch
        // is needed, and loadBoard already depends on it, so naming it here would add no trigger.
    }, [loadBoard]);

    const handleAction = useCallback(async (mutation: string, variables: Record<string, unknown>) => {
        setBusyTaskId(String(variables.id));
        setError(null);
        setNotice(null);
        try {
            await callGraphQL(graphqlEndpoint, mutation, variables);
            // The profile icon must not report a closure back to the person who performed it.
            // Both routes to the terminal state: writing it directly (the Close button, and a
            // drop into the Closed column) and a workflow decision.
            if (mutation === COMPLETE_TASK_MUTATION || variables.state === CLOSED_STATE) {
                announceTaskClosed(String(variables.id));
            }

            // Whatever changed, the count of tasks waiting on the viewer may have too.
            announceTaskChanged();
            await loadBoard();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to complete this action.');
        } finally {
            setBusyTaskId(null);
        }
    }, [graphqlEndpoint, loadBoard]);

    // A drop is a state change and nothing more: the card lands in the column whose entryState it
    // is given, and the board re-fetches, so where it ends up is what the server actually stored
    // rather than where the pointer let go.
    const handleDrop = useCallback((to: ColumnKey) => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDragging(null);
        setDropTarget(null);
        if (drag === null) {
            return;
        }

        const refusal = dropRefusal(drag, to, currentUserKey, canReviewAll);
        if (refusal !== null) {
            setNotice(refusal);
            return;
        }

        const column = BOARD_COLUMNS.find(candidate => candidate.key === to);
        if (column === undefined || columnStep(drag.from, to) === 0) {
            return;
        }

        handleAction(UPDATE_TASK_STATE_MUTATION, {id: drag.task.id, state: column.entryState});
        // Deliberately not dependent on `dragging`: the drop reads dragRef, so this callback stays
        // stable across the drag instead of being rebuilt the moment one starts.
    }, [currentUserKey, canReviewAll, handleAction]);

    const endDrag = useCallback(() => {
        dragRef.current = null;
        setDragging(null);
        setDropTarget(null);
    }, []);

    const showMore = useCallback((key: ColumnKey) => {
        setLimits(current => ({...current, [key]: current[key] + SHOW_MORE_STEP}));
    }, []);

    const showMoreInList = useCallback(() => {
        setListLimit(current => current + SHOW_MORE_STEP);
    }, []);

    // Changing what the board is showing puts every column back to one page: a limit raised on the
    // old list means nothing on the new one. Same for the list's own single limit.
    const resetPaging = () => {
        setLimits(DEFAULT_LIMITS);
        setListLimit(DEFAULT_PAGE_SIZE);
    };

    const changeScope = (next: TaskScope) => {
        setScope(next);
        resetPaging();
        // Opening this list puts every closed task the viewer raised on screen, in the Closed
        // column -- which is exactly what the profile icon was pointing at, so it stops.
        if (next === 'createdByMe') {
            announceCreatedListViewed();
        }
    };

    const changeSortBy = (next: SortField) => {
        setSortBy(next);
        resetPaging();
    };

    const toggleSortOrder = () => {
        setSortOrder(current => (current === 'ascending' ? 'descending' : 'ascending'));
        resetPaging();
    };

    // The list's column headers set both halves at once, where the board's dropdown and arrow set
    // them one at a time -- so this is a separate entry point rather than the two setters above.
    const changeListSort = useCallback((nextSortBy: string, nextSortOrder: SortDirection) => {
        setSortBy(nextSortBy as SortField);
        setSortOrder(nextSortOrder);
        setListLimit(DEFAULT_PAGE_SIZE);
    }, []);

    const changeViewMode = (next: TaskViewMode) => {
        if (next === viewMode) {
            return;
        }

        setViewMode(next);
        // Each view pages separately, and the one being left may have been scrolled well past its
        // first page; arriving in the other one showing the same depth would be a surprise.
        resetPaging();
        // The other view's last data is still in state and would be painted for the one render
        // before the effect refetches -- stale whenever the search or scope moved on since. Showing
        // the loader instead says "fetching", which is what is actually happening.
        setLoading(true);
        try {
            window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
        } catch {
            // Private window or blocked site data: the switch still happens, it just will not be
            // remembered for next time.
        }
    };

    // Both views answer "how many tasks are there", but from their own query: the board sums its
    // three columns, the list reads the one connection it fetched. Taken from whichever is on
    // screen, so the count beside the scopes always describes what the reader is looking at.
    const isList = viewMode === 'list';
    const totalCount = isList
        ? (list?.pageInfo.totalCount ?? 0)
        : BOARD_COLUMNS.reduce((sum, column) => sum + columns[column.key].pageInfo.totalCount, 0);
    const isEmpty = totalCount === 0;

    let boardContent;
    if (isLoading || (isList && list === null)) {
        // The list has no server-rendered first page, so its very first render has nothing to show
        // yet even before isLoading is set -- see the mount effect above.
        boardContent = <Loader/>;
    } else if (isEmpty) {
        // A search that found nothing is a different situation from a list that is simply empty,
        // and saying "no task is assigned to you" while a search term is in the box would be wrong.
        boardContent = <EmptyData message={search === '' ? EMPTY_SCOPE_MESSAGE[scope] : 'No task matches this search.'}/>;
    } else if (isList && list !== null) {
        boardContent = (
            <TaskListTable
                tasks={list.edges.map(edge => edge.node)}
                currentUserKey={currentUserKey}
                canReviewAll={canReviewAll}
                busyTaskId={busyTaskId}
                showCandidates={scope === 'claimable'}
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSortChange={changeListSort}
                onAction={handleAction}
                onShowMore={list.pageInfo.hasNextPage ? showMoreInList : null}
            />
        );
    } else {
        boardContent = (
            <div className="task-board__columns">
                {BOARD_COLUMNS.map(column => (
                    <BoardColumnView
                        key={column.key}
                        column={column}
                        connection={columns[column.key]}
                        currentUserKey={currentUserKey}
                        canReviewAll={canReviewAll}
                        busyTaskId={busyTaskId}
                        dragging={dragging}
                        isUnderPointer={dropTarget === column.key}
                        onAction={handleAction}
                        onDragStart={beginDrag}
                        onDragEnd={endDrag}
                        onHover={setDropTarget}
                        onDrop={handleDrop}
                        onShowMore={showMore}
                    />
                ))}
            </div>
        );
    }

    return (
        <ContentLayout
            paper
            header={(
                <div style={{backgroundColor: 'white'}}>
                    <Header title={title}/>
                </div>
            )}
            content={(
                <div className="task-board__content">
                    <div className="task-board__toolbar">
                        <div className="task-board__scopes" role="group" aria-label="Which tasks to show">
                            <Typography variant="caption" weight="light">{totalCount} task(s)</Typography>
                            {TASK_SCOPES.map(option => (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={`task-board__scope${scope === option.value ? ' task-board__scope--selected' : ''}`}
                                    // aria-pressed rather than aria-selected: these are toggle
                                    // buttons in a group, not tabs over one panel of content.
                                    aria-pressed={scope === option.value}
                                    onClick={() => changeScope(option.value)}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        <div className="task-board__toolbar-controls">
                            {/* Hidden in the list, deliberately: there the sortable column headers
                                are the sort control, and a dropdown beside them would be a second
                                one for the same setting -- two places showing the same state, which
                                is how they end up disagreeing. */}
                            {!isList && (
                                <div className="task-board__sort">
                                    <Typography variant="body" weight="semiBold">Sort by:</Typography>
                                    <Dropdown
                                        size="small"
                                        data={SORT_OPTIONS}
                                        value={sortBy}
                                        onChange={(_event, item) => changeSortBy(item.value as SortField)}
                                    />
                                    <Button
                                        icon={sortOrder === 'descending' ? <ArrowDown/> : <ArrowUp/>}
                                        variant="ghost"
                                        size="small"
                                        aria-label={sortOrder === 'descending' ? 'Sort ascending' : 'Sort descending'}
                                        onClick={toggleSortOrder}
                                    />
                                </div>
                            )}
                            {/* Same toggle-button idiom as the scopes above: two alternative
                                answers to one question, so aria-pressed rather than tabs. */}
                            <div className="task-board__views" role="group" aria-label="How to show the tasks">
                                {VIEW_MODE_OPTIONS.map(option => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={`task-board__view${viewMode === option.value ? ' task-board__view--selected' : ''}`}
                                        aria-pressed={viewMode === option.value}
                                        onClick={() => changeViewMode(option.value)}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                            <div className="task-board__search">
                                <Typography variant="body" weight="semiBold">Search:</Typography>
                                <Input
                                    className="task-board__search-input"
                                    icon={<Search/>}
                                    placeholder="Search tasks..."
                                    value={searchInput}
                                    onChange={e => setSearchInput(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>
                    {error && (
                        <Banner title="Something went wrong" variant="danger">
                            {error}
                        </Banner>
                    )}
                    {notice && (
                        <Banner title="That move is not allowed" variant="info">
                            {notice}
                        </Banner>
                    )}
                    {boardContent}
                </div>
            )}
        />
    );
}
