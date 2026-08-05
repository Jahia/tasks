import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowDown, ArrowUp, Banner, Button, Chip, Dropdown, EmptyData, Header, Input, Loader, Pagination, Search, Typography} from '@jahia/moonstone';
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
    SUSPEND_TASK_MUTATION,
    TASK_BOARD_QUERY,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import type {TaskBoardConnection, TaskBoardNode} from './taskBoard.shared';
import {UPDATE_TASK_STATE_MUTATION} from './task.shared';
import './TaskBoard.client.css';

export const DEFAULT_PAGE_SIZE = 25;
const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
// Debounce so every keystroke doesn't fire its own request -- this is a server round-trip
// (TaskBoardQueryExtensions#taskBoard filters title/creator/assignee/state), not a client-side
// filter over an already-fully-loaded list.
const SEARCH_DEBOUNCE_MS = 350;

type SortField = 'title' | 'creator' | 'owner' | 'state';
type SortDirection = 'ascending' | 'descending';

const SORT_OPTIONS: Array<{label: string; value: SortField}> = [
    {label: 'Task Name', value: 'title'},
    {label: 'Creator', value: 'creator'},
    {label: 'Owner', value: 'owner'},
    {label: 'State', value: 'state'}
];

type TaskBoardProps = {
    initialConnection: TaskBoardConnection;
    graphqlEndpoint: string;
    currentUserKey: string;
    canReviewAll: boolean;
};

function capitalize(value: string | null): string {
    if (!value) {
        return 'Unknown';
    }

    return value.charAt(0).toUpperCase() + value.slice(1);
}

type ChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'reassuring' | 'light';

// active: ready to be picked up. started: in progress. suspended: parked. finished: done.
const STATE_CHIP_COLOR: Record<string, ChipColor> = {
    active: 'accent',
    started: 'warning',
    suspended: 'light',
    finished: 'success'
};

// One button per outcome the task actually declares (workflow-specific --
// see TaskBoardMutationExtensions#completeTask). Common synonyms get the
// checklist's fixed labels; anything else falls back to its own raw label.
function outcomeLabel(outcome: string): string {
    const normalized = outcome.toLowerCase();
    if (/publi|approve|accept|finish/.test(normalized)) {
        return 'Publish';
    }

    if (/reject|refuse|deny|decline/.test(normalized)) {
        return 'Reject publication';
    }

    return capitalize(outcome);
}

// "2026-07-20T11:39:20.123Z" -> "July 20, 2026, 11:39:20 AM". Formatted client-side (rather than
// baking a fixed locale into the server's ISO-8601 getCreatedDate()) so it can follow the
// viewer's own locale later; hardcoded to 'en-US' for now, matching every other hardcoded English
// label already in this component.
function formatCreatedDate(iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const datePart = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'long', day: 'numeric'}).format(date);
    const timePart = new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true}).format(date);
    return `${datePart}, ${timePart}`;
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
function TaskActions({task, currentUserKey, canReviewAll, isBusy, onAction}: TaskActionsProps) {
    const canAct = task.owner === currentUserKey || canReviewAll;
    const targetUrl = task.targetNode?.url;
    // Three phases, not two: Unassigned (active, no owner) -> Assigned (active, owned, not yet
    // started) -> Active/In-Progress (started). assignTaskToMe deliberately leaves state
    // "active" (see its own comment), so "owner present" is what distinguishes Assigned from
    // Unassigned within that one state value; "Start" (updateTaskState -> "started") is the only
    // way from Assigned into Active/In-Progress.
    const isUnassigned = !task.owner;
    const primaryActions: MenuAction[] = [];
    // Kept visually separated (extra spacing below) from primaryActions: these are workflow
    // publication decisions, not routine task-management actions.
    const decisionActions: MenuAction[] = [];
    let showPreview = false;

    if (task.state === 'active' && isUnassigned) {
        primaryActions.push({label: 'Assign to me', mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}});
    } else if (canAct && task.state === 'active') {
        // Assigned, not started yet.
        primaryActions.push({label: 'Unassign', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}});
        primaryActions.push({label: 'Start', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}});
    } else if (canAct && task.state === 'started') {
        primaryActions.push({label: 'Unassign', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}});
        primaryActions.push({label: 'Suspend', mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}});
        showPreview = true;
        // Reject publication before Publish, matching the requested layout order, regardless of
        // the order possibleOutcomes happens to list them in (workflow-definition-specific).
        const outcomes = task.possibleOutcomes
            .map(outcome => ({outcome, label: outcomeLabel(outcome)}))
            .sort((a, b) => Number(a.label !== 'Reject publication') - Number(b.label !== 'Reject publication'));
        for (const {outcome, label} of outcomes) {
            decisionActions.push({label, mutation: COMPLETE_TASK_MUTATION, variables: {id: task.id, outcome}});
        }
    } else if (canAct && task.state === 'suspended') {
        primaryActions.push({label: 'Resume', mutation: RESUME_TASK_MUTATION, variables: {id: task.id}});
    }

    if (primaryActions.length === 0 && decisionActions.length === 0 && !showPreview) {
        return <Typography variant="caption" weight="light">No actions available</Typography>;
    }

    return (
        <div className="task-board__actions">
            <div className="task-board__actions-row">
                {primaryActions.map((action, index) => (
                    <Button
                        key={`primary-${index}`}
                        label={action.label}
                        size="small"
                        isDisabled={isBusy}
                        onClick={() => onAction(action.mutation, action.variables)}
                    />
                ))}
                {showPreview && targetUrl && (
                    <Button
                        label="Preview"
                        size="small"
                        variant="ghost"
                        isDisabled={isBusy}
                        onClick={() => window.open(targetUrl, '_blank', 'noopener,noreferrer')}
                    />
                )}
            </div>
            {decisionActions.length > 0 && (
                <div className="task-board__actions-row task-board__actions-row--decisions">
                    {decisionActions.map((action, index) => (
                        <Button
                            key={`decision-${index}`}
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

type TaskCardProps = {
    task: TaskBoardNode;
    currentUserKey: string;
    canReviewAll: boolean;
    isBusy: boolean;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
};

function TaskCard({task, currentUserKey, canReviewAll, isBusy, onAction}: TaskCardProps) {
    const targetTitle = task.targetNode?.property?.value;
    const createdDate = formatCreatedDate(task.createdDate);
    // The workflow-engine-derived summary (TaskBoardQueryExtensions#getWorkflowSummary) is only
    // available for a jnt:workflowTask whose process is still live; a plain jnt:task, or one
    // whose summary couldn't be resolved, falls back to its own free-text description instead.
    const summaryLine = task.workflowSummary ?? task.description;

    return (
        <div className="task-board__card">
            <div className="task-board__card-header">
                <Typography component="span" weight="semiBold" variant="body">
                    {task.title ?? 'Untitled task'}
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
            {createdDate && (
                <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                    {`Created by: ${task.creator ?? 'Unknown'}, on ${createdDate}`}
                </Typography>
            )}
            {summaryLine && (
                <Typography component="p" variant="body" className="task-board__summary">
                    {summaryLine}
                </Typography>
            )}
            <div className="task-board__badges">
                <Typography variant="caption" weight="light">{`Creator: ${task.creator ?? '—'}`}</Typography>
                <Typography variant="caption" weight="light">{`Owner: ${task.assigneeDisplayName ?? 'Unassigned'}`}</Typography>
                <Chip label={capitalize(task.state)} color={(task.state && STATE_CHIP_COLOR[task.state]) || 'default'}/>
            </div>
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

export default function TaskBoard({initialConnection, graphqlEndpoint, currentUserKey, canReviewAll}: TaskBoardProps) {
    const [currentPage, setCurrentPage] = useState(1);
    const [connection, setConnection] = useState(initialConnection);
    const [isLoading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
    const [itemsPerPage, setItemsPerPage] = useState(DEFAULT_PAGE_SIZE);
    // searchInput is what the box shows on every keystroke; search is the debounced value
    // that actually goes into the query (see SEARCH_DEBOUNCE_MS above).
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    // Always a concrete field/direction (never "unsorted") -- see DEFAULT_SORT_BY/_ORDER's own
    // comment for why: the sort-by dropdown always needs a real value to display.
    const [sortBy, setSortBy] = useState<SortField>(DEFAULT_SORT_BY as SortField);
    const [sortOrder, setSortOrder] = useState<SortDirection>(DEFAULT_SORT_ORDER as SortDirection);
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
                sortBy,
                sortOrder,
                filterState: NOT_FINISHED_STATES
            });
            setConnection(data.taskBoard);
            setCurrentPage(page);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to load tasks.');
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint, itemsPerPage, search, sortBy, sortOrder]);

    // itemsPerPage/search/sortBy/sortOrder all change what the *first* page even means, so none
    // of them can be applied by just re-fetching the current page -- every cached cursor is
    // invalidated and this always jumps back to page 1. Skipped on mount: initialConnection
    // already is page 1 at the (unchanged) defaults.
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }

        cursorsByPage.current = new Map([[1, undefined]]);
        loadPage(1);
        // Deliberately reacts only to itemsPerPage/search/sortBy/sortOrder: loadPage already
        // closes over all four (declared above) plus graphqlEndpoint/currentPage, which this
        // effect doesn't care about.
    }, [itemsPerPage, search, sortBy, sortOrder]);

    const handlePageChange = (nextPage: number) => {
        // Clamp forward jumps to one page at a time -- see the cursor cache
        // comment above for why arbitrary jumps aren't possible here.
        const target = nextPage <= currentPage ? Math.max(1, nextPage) : currentPage + 1;
        if (target !== currentPage) {
            loadPage(target);
        }
    };

    const handleAction = useCallback(async (mutation: string, variables: Record<string, unknown>) => {
        setBusyTaskId(String(variables.id));
        setError(null);
        try {
            await callGraphQL(graphqlEndpoint, mutation, variables);
            await loadPage(currentPage);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to complete this action.');
        } finally {
            setBusyTaskId(null);
        }
    }, [graphqlEndpoint, currentPage, loadPage]);

    const rows = connection.edges.map(edge => edge.node);

    return (
        <ContentLayout
            paper
            header={(
                <div style={{backgroundColor: 'white'}}>
                    <Header title="Tasks"/>
                </div>
            )}
            content={(
                <div className="task-board__content">
                    <div className="task-board__toolbar">
                        <Typography variant="caption" weight="light">{connection.pageInfo.totalCount} task(s)</Typography>
                        <div className="task-board__toolbar-controls">
                            <div className="task-board__sort">
                                <Typography variant="body" weight="semiBold">Sort by:</Typography>
                                <Dropdown
                                    size="small"
                                    data={SORT_OPTIONS}
                                    value={sortBy}
                                    onChange={(_event, item) => setSortBy(item.value as SortField)}
                                />
                                <Button
                                    icon={sortOrder === 'descending' ? <ArrowDown/> : <ArrowUp/>}
                                    variant="ghost"
                                    size="small"
                                    aria-label={sortOrder === 'descending' ? 'Sort ascending' : 'Sort descending'}
                                    onClick={() => setSortOrder(current => (current === 'ascending' ? 'descending' : 'ascending'))}
                                />
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
                    {isLoading ? (
                        <Loader/>
                    ) : rows.length === 0 ? (
                        <EmptyData message="No tasks to show."/>
                    ) : (
                        <div className="task-board__list">
                            {rows.map(task => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    currentUserKey={currentUserKey}
                                    canReviewAll={canReviewAll}
                                    isBusy={busyTaskId === task.id}
                                    onAction={handleAction}
                                />
                            ))}
                        </div>
                    )}
                    {!isLoading && rows.length > 0 && (
                        <Pagination
                            currentPage={currentPage}
                            itemsPerPage={itemsPerPage}
                            itemsPerPageOptions={ITEMS_PER_PAGE_OPTIONS}
                            onItemsPerPageChange={setItemsPerPage}
                            totalOfItems={connection.pageInfo.totalCount}
                            onPageChange={handlePageChange}
                        />
                    )}
                </div>
            )}
        />
    );
}
