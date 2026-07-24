import type {FC, ReactNode} from 'react';
import {Component, Suspense, useEffect, useRef, useState} from 'react';
import {useGQLQuery} from '@jahia/javascript-modules-library';
import {Button, DataTable, EmptyData, Header, Loader, MoreVert} from '@jahia/moonstone';
import type {DataTableColumn} from '@jahia/moonstone/DataTable';

const PAGE_SIZE = 20;

const TASK_BOARD_QUERY = /* GraphQL */ `
    query TaskBoard($first: Int!, $after: String) {
        taskBoard(first: $first, after: $after) {
            totalCount
            pageInfo {
                hasNextPage
                endCursor
            }
            edges {
                node {
                    id
                    title
                    creator
                    owner
                    state
                }
            }
        }
    }
`;

type TaskBoardNode = {
    id: string;
    title: string | null;
    creator: string | null;
    owner: string | null;
    state: string | null;
};

type TaskBoardQueryResult = {
    taskBoard: {
        totalCount: number;
        pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
        };
        edges: Array<{node: TaskBoardNode}>;
    };
};

function capitalize(value: string | null): string {
    if (!value) {
        return 'Unknown';
    }

    return value.charAt(0).toUpperCase() + value.slice(1);
}

const columns: ReadonlyArray<DataTableColumn<TaskBoardNode>> = [
    {
        key: 'title',
        label: 'Task Name',
        render: ({value}) => value ?? 'Untitled task'
    },
    {
        key: 'creator',
        label: 'Creator',
        render: ({value}) => value ?? '—'
    },
    {
        key: 'owner',
        label: 'Owner',
        render: ({value}) => value ?? 'Unassigned'
    },
    {
        key: 'state',
        label: 'State',
        render: ({value}) => capitalize(value)
    },
    {
        key: 'id',
        label: 'Actions',
        align: 'right',
        // Row actions (assign/suspend/publish/...) land in a later phase; this
        // is a placeholder trigger so the column shape matches the final UI.
        render: () => (
            <Button
                icon={<MoreVert/>}
                variant="ghost"
                size="small"
                isDisabled
                aria-label="Task actions"
                title="Actions are available in a later phase"
            />
        )
    }
];

/**
 * Catches the error TaskBoardData throws below (a network failure, or a
 * GraphQL error re-thrown to unify both failure paths into one error state)
 * so the board shows a clear message instead of crashing the page.
 */
class TaskBoardErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean}> {
    state = {hasError: false};

    static getDerivedStateFromError() {
        return {hasError: true};
    }

    render() {
        if (this.state.hasError) {
            return (
                <EmptyData
                    title="Unable to load tasks"
                    message="Something went wrong while fetching the task board. Please try again later."
                />
            );
        }

        return this.props.children;
    }
}

const TaskBoardData: FC = () => {
    const [currentPage, setCurrentPage] = useState(1);
    // Relay-style cursor pagination only supports moving forward one page at a
    // time; this caches the cursor needed to fetch each page once it has been
    // reached, so navigating back to an already-visited page doesn't require
    // re-fetching every page before it.
    const cursorsByPage = useRef<Map<number, string | undefined>>(new Map([[1, undefined]]));

    const {data, errors} = useGQLQuery({
        query: TASK_BOARD_QUERY,
        variables: {
            first: PAGE_SIZE,
            after: cursorsByPage.current.get(currentPage)
        }
    });

    if (errors && errors.length > 0) {
        throw new Error(errors.map(error => error.message).join('; '));
    }

    const connection = (data as TaskBoardQueryResult).taskBoard;

    useEffect(() => {
        if (connection.pageInfo.hasNextPage) {
            cursorsByPage.current.set(currentPage + 1, connection.pageInfo.endCursor ?? undefined);
        }
    }, [currentPage, connection.pageInfo.hasNextPage, connection.pageInfo.endCursor]);

    const handlePageChange = (nextPage: number) => {
        // Clamp forward jumps to one page at a time -- see the cursor cache
        // comment above for why arbitrary jumps aren't possible here.
        setCurrentPage(nextPage <= currentPage ? Math.max(1, nextPage) : currentPage + 1);
    };

    const rows = connection.edges.map(edge => edge.node);

    return (
        <>
            <div className="task-board__toolbar">{connection.totalCount} task(s)</div>
            {rows.length === 0 ? (
                <EmptyData message="No tasks to show."/>
            ) : (
                <DataTable
                    primaryKey="id"
                    data={rows}
                    columns={columns}
                    enablePagination
                    currentPage={currentPage}
                    itemsPerPage={PAGE_SIZE}
                    totalItems={connection.totalCount}
                    onPageChange={handlePageChange}
                />
            )}
        </>
    );
};

export const TaskBoard: FC = () => (
    <div className="task-board__layout">
        <Header title="Tasks"/>
        <TaskBoardErrorBoundary>
            <Suspense fallback={<Loader/>}>
                <TaskBoardData/>
            </Suspense>
        </TaskBoardErrorBoundary>
    </div>
);
