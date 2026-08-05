import type {MutableRefObject, ReactElement} from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Add, Banner, Button, Chip, Close, DataTable, EmptyData, Header, Input, Loader, Menu, MenuItem, Search, Separator, Typography} from '@jahia/moonstone';
import type {DataTableColumn, SortDirection} from '@jahia/moonstone/DataTable';
// Deep import, not the package's bare '@jahia/moonstone-alpha' entry point: that barrel
// (dist/components/index.js) re-exports Checkbox/DatePicker/etc. too, which drag in transitive
// deps (e.g. @react-aria/focus) this module never installs and doesn't otherwise need -- see
// the matching deep path in moonstone-alpha.d.ts.
import {ContentLayout} from '@jahia/moonstone-alpha/dist/components/ContentLayout';
import {callGraphQL} from '../lib/graphqlClient';
import {
    ASSIGN_TASK_TO_ME_MUTATION,
    COMPLETE_TASK_MUTATION,
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

type MenuAction = {
    label: string;
    mutation: string;
    variables: {id: string} & Record<string, unknown>;
};

type ActionsCellProps = {
    task: TaskBoardNode;
    currentUserKey: string;
    canReviewAll: boolean;
    isBusy: boolean;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
};

// A client-side mirror of the server's state/ownership rules, for deciding
// which menu items to show -- purely a UX nicety. TaskBoardMutationExtensions
// independently re-checks every one of these server-side and is the real
// security boundary; a wrong guess here just surfaces as an error banner.
function ActionsCell({task, currentUserKey, canReviewAll, isBusy, onAction}: ActionsCellProps) {
    const [isMenuOpen, setMenuOpen] = useState(false);
    // Menu's anchorEl prop is typed as a non-nullable MutableRefObject, but a
    // DOM ref can only ever start out null -- the cast is confined to this one
    // prop instead of widening the ref's own (accurately nullable) type.
    const anchorRef = useRef<HTMLDivElement>(null);

    const canAct = task.owner === currentUserKey || canReviewAll;
    const targetUrl = task.targetNode?.url;
    // Three phases, not two: Unassigned (active, no owner) -> Assigned (active, owned, not yet
    // started) -> Active/In-Progress (started). assignTaskToMe deliberately leaves state
    // "active" (see its own comment), so "owner present" is what distinguishes Assigned from
    // Unassigned within that one state value; "Start" (updateTaskState -> "started") is the only
    // way from Assigned into Active/In-Progress.
    const isUnassigned = !task.owner;
    const primaryActions: MenuAction[] = [];
    // Kept visually separated (a Separator, extra spacing) from primaryActions below: these are
    // workflow publication decisions, not routine task-management actions.
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

    const runAction = (action: MenuAction) => {
        setMenuOpen(false);
        onAction(action.mutation, action.variables);
    };

    // Menu requires each top-level child to be a single MenuItem element -- its internal
    // auto-search-threshold check (Menu.tsx) does `children[0].props[...]`, which throws if
    // children[0] is itself an array (e.g. the direct result of actions.map(...) placed
    // alongside a sibling JSX expression). Building one flat array up front, instead of a
    // ternary/&& mix of JSX expressions as Menu's children, keeps every child a plain element.
    const menuItems: ReactElement[] = [];

    if (primaryActions.length === 0 && decisionActions.length === 0 && !showPreview) {
        menuItems.push(<MenuItem key="none" label="No actions available" isDisabled/>);
    } else {
        primaryActions.forEach((action, index) => {
            menuItems.push(<MenuItem key={`primary-${index}`} label={action.label} onClick={() => runAction(action)}/>);
        });

        if (showPreview && targetUrl) {
            menuItems.push(
                <MenuItem
                    key="preview"
                    label="Preview"
                    onClick={() => {
                        setMenuOpen(false);
                        window.open(targetUrl, '_blank', 'noopener,noreferrer');
                    }}
                />
            );
        }

        if (decisionActions.length > 0) {
            menuItems.push(<Separator key="decision-separator" spacing="medium"/>);
            decisionActions.forEach((action, index) => {
                menuItems.push(<MenuItem key={`decision-${index}`} label={action.label} onClick={() => runAction(action)}/>);
            });
        }
    }

    return (
        <>
            <div ref={anchorRef}>
                <Button
                    icon={isMenuOpen ? <Close/> : <Add/>}
                    variant={isMenuOpen ? 'default' : 'ghost'}
                    size="small"
                    isDisabled={isBusy}
                    aria-label={isMenuOpen ? 'Hide task actions' : 'Show task actions'}
                    onClick={() => setMenuOpen(open => !open)}
                />
            </div>
            <Menu
                isDisplayed={isMenuOpen}
                anchorEl={anchorRef as MutableRefObject<HTMLDivElement>}
                onClose={() => setMenuOpen(false)}
            >
                {menuItems}
            </Menu>
        </>
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
    // undefined = no column sorted yet (server's default jcr:created-desc order). DataTable
    // itself owns the sort-direction toggle/arrow (uncontrolled -- see handleSortChange below);
    // this just mirrors that choice so it can be sent to the server.
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<SortDirection | undefined>(undefined);
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
                sortBy: sortBy ?? null,
                sortOrder: sortOrder ?? null,
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

    const handleSortChange = (nextSortBy: string, nextSortDirection: SortDirection) => {
        setSortBy(nextSortBy);
        setSortOrder(nextSortDirection);
    };

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

    const columns: ReadonlyArray<DataTableColumn<TaskBoardNode>> = [
        {
            key: 'title',
            label: 'Task Name',
            isSortable: true,
            // DataTableColumn's `value` type is the union of every column's
            // property type on T, not just this column's -- these four are
            // all known to be `string | null` on TaskBoardNode.
            render: ({value}) => <Typography weight="semiBold">{(value as string | null) ?? 'Untitled task'}</Typography>
        },
        {
            key: 'creator',
            label: 'Creator',
            isSortable: true,
            render: ({value}) => <Typography variant="body">{(value as string | null) ?? '—'}</Typography>
        },
        {
            key: 'owner',
            label: 'Owner',
            isSortable: true,
            // owner itself is the raw assigneeUserKey (a JCR path, e.g. /users/jb/ac/eh/irina) --
            // it stays the column's `key` because that's what canAct/canReviewAll logic compares
            // against, but the cell displays assigneeDisplayName (just the user node's name), and
            // sorting this column (see TaskBoardQueryExtensions#taskBoard's "owner" sort field)
            // orders by that same display name, not the raw path.
            render: ({data}) => <Typography variant="body">{data.assigneeDisplayName ?? 'Unassigned'}</Typography>
        },
        {
            key: 'state',
            label: 'State',
            isSortable: true,
            render: ({value}) => {
                const state = value as string | null;
                return <Chip label={capitalize(state)} color={(state && STATE_CHIP_COLOR[state]) || 'default'}/>;
            }
        },
        {
            key: 'id',
            label: 'Actions',
            align: 'right',
            render: ({data}) => (
                <ActionsCell
                    task={data}
                    currentUserKey={currentUserKey}
                    canReviewAll={canReviewAll}
                    isBusy={busyTaskId === data.id}
                    onAction={handleAction}
                />
            )
        }
    ];

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
                        <DataTable
                            primaryKey="id"
                            data={rows}
                            columns={columns}
                            enableSorting
                            onSortChange={handleSortChange}
                            enablePagination
                            currentPage={currentPage}
                            itemsPerPage={itemsPerPage}
                            itemsPerPageOptions={ITEMS_PER_PAGE_OPTIONS}
                            onItemsPerPageChange={setItemsPerPage}
                            totalItems={connection.pageInfo.totalCount}
                            onPageChange={handlePageChange}
                        />
                    )}
                </div>
            )}
        />
    );
}
