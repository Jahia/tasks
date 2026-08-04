import type {MutableRefObject} from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Banner, Button, DataTable, EmptyData, Header, Loader, Menu, MenuItem, MoreVert} from '@jahia/moonstone';
import type {DataTableColumn} from '@jahia/moonstone/DataTable';
import {callGraphQL} from '../lib/graphqlClient';
import {
    ASSIGN_TASK_TO_ME_MUTATION,
    COMPLETE_TASK_MUTATION,
    RESUME_TASK_MUTATION,
    SUSPEND_TASK_MUTATION,
    TASK_BOARD_QUERY,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import type {TaskBoardConnection, TaskBoardNode} from './taskBoard.shared';

const PAGE_SIZE = 20;

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
    const actions: MenuAction[] = [];

    if (task.state === 'active') {
        actions.push({label: 'Assign to me', mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}});
    }

    if (canAct && (task.state === 'active' || task.state === 'started' || task.state === 'suspended')) {
        actions.push({label: 'Unassign / Refuse', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}});
    }

    if (canAct && task.state === 'started') {
        actions.push({label: 'Suspend', mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}});
        for (const outcome of task.possibleOutcomes) {
            actions.push({
                label: outcomeLabel(outcome),
                mutation: COMPLETE_TASK_MUTATION,
                variables: {id: task.id, outcome}
            });
        }
    }

    if (canAct && task.state === 'suspended') {
        actions.push({label: 'Resume', mutation: RESUME_TASK_MUTATION, variables: {id: task.id}});
    }

    // Menu requires each top-level child to be a single MenuItem element -- its internal
    // auto-search-threshold check (Menu.tsx) does `children[0].props[...]`, which throws if
    // children[0] is itself an array (e.g. the direct result of actions.map(...) placed
    // alongside a sibling JSX expression). Building one flat array up front, instead of a
    // ternary/&& mix of JSX expressions as Menu's children, keeps every child a plain element.
    const menuItems = actions.length === 0
        ? [<MenuItem key="none" label="No actions available" isDisabled/>]
        : actions.map((action, index) => (
            <MenuItem
                key={`${index}-${action.label}`}
                label={action.label}
                onClick={() => {
                    setMenuOpen(false);
                    onAction(action.mutation, action.variables);
                }}
            />
        ));

    if (targetUrl) {
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

    return (
        <>
            <div ref={anchorRef}>
                <Button
                    icon={<MoreVert/>}
                    variant="ghost"
                    size="small"
                    isDisabled={isBusy}
                    aria-label="Task actions"
                    onClick={() => setMenuOpen(true)}
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

    const loadPage = useCallback(async (page: number) => {
        setLoading(true);
        setError(null);
        try {
            const data = await callGraphQL<{taskBoard: TaskBoardConnection}>(graphqlEndpoint, TASK_BOARD_QUERY, {
                first: PAGE_SIZE,
                after: cursorsByPage.current.get(page)
            });
            setConnection(data.taskBoard);
            setCurrentPage(page);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to load tasks.');
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint]);

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
            // DataTableColumn's `value` type is the union of every column's
            // property type on T, not just this column's -- these four are
            // all known to be `string | null` on TaskBoardNode.
            render: ({value}) => (value as string | null) ?? 'Untitled task'
        },
        {
            key: 'creator',
            label: 'Creator',
            render: ({value}) => (value as string | null) ?? '—'
        },
        {
            key: 'owner',
            label: 'Owner',
            render: ({value}) => (value as string | null) ?? 'Unassigned'
        },
        {
            key: 'state',
            label: 'State',
            render: ({value}) => capitalize(value as string | null)
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
        <div className="task-board__layout">
            <Header title="Tasks"/>
            <div className="task-board__toolbar">{connection.pageInfo.totalCount} task(s)</div>
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
                    enablePagination
                    currentPage={currentPage}
                    itemsPerPage={PAGE_SIZE}
                    itemsPerPageOptions={[PAGE_SIZE]}
                    totalItems={connection.pageInfo.totalCount}
                    onPageChange={handlePageChange}
                />
            )}
        </div>
    );
}
