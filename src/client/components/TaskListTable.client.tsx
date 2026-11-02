/**
 * The same tasks as the board, as one sortable table.
 *
 * The board answers "what is moving where"; this answers "what is there, in the order I asked for".
 * Columns, their widths and which of them sort are taken from the table built on
 * feature/client-only-taskboard, so the two implementations agree on what a task list looks like.
 *
 * Rendering only: every piece of state this reads -- the rows, the sort, which task is busy -- is
 * owned by TaskBoard, which is also where the toolbar that drives them lives, so switching view
 * keeps the search, the sort and the scope that were already in effect.
 */

import {useMemo} from 'react';
import {Chip, DataTable, Typography} from '@jahia/moonstone';
// Type-only, so nothing is imported at runtime from this subpath: the DataTable *component* comes
// from the package's main entry above, while its types are published under the './DataTable'
// export condition.
import type {DataTableColumn} from '@jahia/moonstone/DataTable';
import type {TaskBoardNode, TaskScope} from './taskBoard.shared';
import {
    counterpartyLabel,
    counterpartyName,
    dueTone,
    formatDueDate,
    STATE_CHIP_COLOR,
    stateLabel,
    TaskActions
} from './taskPresentation.client';
import {capitalize} from './task.shared';

/**
 * One row of the table.
 *
 * The synthetic field exists because a DataTable column key must be a key of the row type:
 * 'actions' is a column with no value at all -- its cell is built from the whole row.
 */
type TaskRow = TaskBoardNode & {
    actions: null;
};

export type ListSortableColumn = 'title' | 'priority' | 'dueDate' | 'creator' | 'owner' | 'state';

type SortDirection = 'ascending' | 'descending';

/**
 * Which taskBoard(sortBy:) argument each sortable column maps to -- here, every one of them is a
 * straight rename.
 *
 * 'dueDate' is a raw property on the server's allow-list
 * (TaskBoardQueryExtensions#ALLOWED_SORT_PROPERTIES), so it sorts at query level. The rest are
 * resolved-value sorts that scan, because what the column shows is not what the property stores:
 * jcr:title can be a "##resourceBundle(...)##" macro, creator and owner are user keys the server
 * resolves to account names, and priority sorts by RANK rather than alphabetically -- "high" <
 * "low" < "normal" is not the order the words mean, so the server compares PRIORITY_RANK instead
 * and the arrow reads low -> normal -> high.
 *
 * 'creator' and 'owner' are both here because the counterparty column is one column showing
 * whichever of them the scope has not already pinned to the viewer, and its key switches with it
 * so the header sorts on what it is actually displaying.
 */
export const LIST_COLUMN_SORT_ARGUMENT: Record<ListSortableColumn, string> = {
    title: 'title',
    priority: 'priority',
    dueDate: 'dueDate',
    creator: 'creator',
    owner: 'owner',
    state: 'state'
};

const LIST_SORT_ARGUMENT_COLUMN: Record<string, ListSortableColumn> = {
    title: 'title',
    priority: 'priority',
    dueDate: 'dueDate',
    creator: 'creator',
    owner: 'owner',
    state: 'state'
};

/** A clicked column header, as the sortBy/sortOrder the server wants. */
export function toListSortArgument(column: ListSortableColumn, direction: SortDirection): {sortBy: string; sortOrder: SortDirection} {
    return {
        sortBy: LIST_COLUMN_SORT_ARGUMENT[column],
        sortOrder: direction
    };
}

/**
 * The reverse: the sort currently in effect, as the column and arrow to show.
 *
 * A sort the table has no column for -- 'jcr:created', which the board's own sort-by dropdown
 * offers and no column here displays -- has no header to mark, so it falls back to the Task
 * column. The rows are still in the order the server returned; only the arrow is approximate.
 *
 * 'creator' and 'owner' both map back to a column, but only one of them is on screen at a time:
 * carrying a sort by the absent one across a scope change marks the counterparty header anyway,
 * which is the nearest honest answer, since that header is where the other name would have been.
 */
export function fromListSortArgument(sortBy: string, sortOrder: SortDirection): {column: ListSortableColumn; direction: SortDirection} {
    return {column: LIST_SORT_ARGUMENT_COLUMN[sortBy] ?? 'title', direction: sortOrder};
}

const PRIORITY_WEIGHT: Record<string, 'default' | 'bold' | 'light'> = {
    high: 'bold',
    normal: 'default',
    low: 'light'
};

type TaskListTableProps = {
    tasks: TaskBoardNode[];
    currentUserKey: string;
    canReviewAll: boolean;
    busyTaskId: string | null;
    /** True while the viewer is looking at tasks nobody has taken, which is the only list where who else could take one is worth a line. */
    showCandidates: boolean;
    /** Which list is on screen -- it decides which of the task's two people the counterparty column names. */
    scope: TaskScope;
    sortBy: string;
    sortOrder: SortDirection;
    onSortChange: (sortBy: string, sortOrder: SortDirection) => void;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
    /** Every task the query matched, not just the ones on this page -- Pagination needs the whole count to size itself. */
    totalCount: number;
    /** 1-based, as moonstone's Pagination counts. */
    page: number;
    pageSize: number;
    pageSizeOptions: number[];
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
};

export default function TaskListTable({
    tasks, currentUserKey, canReviewAll, busyTaskId, showCandidates, scope,
    sortBy, sortOrder, onSortChange, onAction,
    totalCount, page, pageSize, pageSizeOptions, onPageChange, onPageSizeChange
}: Readonly<TaskListTableProps>) {
    // 'actions' carries no value of its own; the column exists so DataTable has a key to hang the
    // actions cell on, and that cell is built from the whole row.
    const rows: TaskRow[] = useMemo(() => tasks.map(task => ({...task, actions: null})), [tasks]);

    const {column: sortColumn, direction: sortDirection} = fromListSortArgument(sortBy, sortOrder);

    const columns: Array<DataTableColumn<TaskRow>> = useMemo(() => [
        {
            key: 'title',
            label: 'Task',
            isSortable: true,
            render: ({data}) => (
                <div className="task-list__task-cell">
                    <Typography variant="body" weight="semiBold">{data.title ?? 'Untitled task'}</Typography>
                    {data.workflowSummary && (
                        <Typography variant="caption" weight="light">{data.workflowSummary}</Typography>
                    )}
                    {showCandidates && data.candidateDisplayNames.length > 0 && (
                        <Typography variant="caption" weight="light">
                            {`Can be taken by: ${data.candidateDisplayNames.join(', ')}`}
                        </Typography>
                    )}
                </div>
            )
        },
        {
            key: 'priority',
            label: 'Priority',
            width: '120px',
            // Sortable by rank, not alphabetically -- see LIST_COLUMN_SORT_ARGUMENT and the
            // server's PRIORITY_RANK.
            isSortable: true,
            render: ({data}) => (data.priority ? (
                <Typography variant="body" weight={PRIORITY_WEIGHT[data.priority] ?? 'default'}>
                    {capitalize(data.priority)}
                </Typography>
            ) : null)
        },
        {
            key: 'dueDate',
            // Wider than the other fixed columns: the cell stacks a date and an "Overdue" chip, and
            // 120px would break "August 15, 2026" across two lines.
            label: 'Due',
            width: '160px',
            isSortable: true,
            render: ({data}) => {
                const due = formatDueDate(data.dueDate);
                if (!due) {
                    return null;
                }

                return (
                    <div className="task-list__due-cell">
                        <Typography variant="body">{due}</Typography>
                        {/* Only on a task that is still open: an overdue badge on a closed task
                            describes a deadline nobody can act on any more. */}
                        {data.state !== 'finished' && dueTone(data.dueDate) === 'late' && (
                            <Chip label="Overdue" color="danger"/>
                        )}
                    </div>
                );
            }
        },
        {
            // Whichever of the task's two people the scope has not already pinned to the viewer --
            // the holder in "Tasks I've created", the raiser otherwise. Both are account names
            // ("pam"), since the server resolves a user key to the node's name, not a full name.
            // The key switches with the column so the header sorts on what it is showing.
            key: scope === 'createdByMe' ? 'owner' : 'creator',
            label: counterpartyLabel(scope),
            width: '180px',
            isSortable: true,
            render: ({data}) => (
                <Typography variant="body">{counterpartyName(data, scope)}</Typography>
            )
        },
        {
            key: 'state',
            label: 'State',
            width: '120px',
            isSortable: true,
            render: ({data}) => (
                <Chip label={stateLabel(data.state)} color={STATE_CHIP_COLOR[data.state ?? ''] ?? 'default'}/>
            )
        },
        {
            key: 'actions',
            label: 'Actions',
            // The board's cards show these as a row of buttons and so does this cell, so it needs
            // room for the widest set (Start / Unassign / Refuse / Close) rather than one icon.
            width: '320px',
            render: ({data}) => (
                <TaskActions
                    task={data}
                    currentUserKey={currentUserKey}
                    canReviewAll={canReviewAll}
                    isBusy={busyTaskId === data.id}
                    onAction={onAction}
                />
            )
        }
    ], [showCandidates, scope, currentUserKey, canReviewAll, busyTaskId, onAction]);

    // DataTable reports the clicked column by key; a key that isn't one of the sortable columns
    // (it should not be -- only those declare isSortable) is ignored rather than sent to the server
    // as an unknown sortBy, which it would silently answer with its default ordering.
    const handleSortChange = (nextColumn: string, nextDirection: SortDirection) => {
        if (!(nextColumn in LIST_COLUMN_SORT_ARGUMENT)) {
            return;
        }

        const argument = toListSortArgument(nextColumn as ListSortableColumn, nextDirection);
        onSortChange(argument.sortBy, argument.sortOrder);
    };

    return (
        <div className="task-list">
            {/* DataTable paginates itself -- enablePagination defaults to true -- so its own bar is
                the only one, driven from here. Passing the controlled quartet (currentPage,
                itemsPerPage, totalItems, onPageChange) also sets manualPagination inside it, which
                is what stops it re-slicing rows the server already windowed: `rows` IS the page. */}
            <DataTable
                enableSorting
                enablePagination
                data={rows}
                columns={columns}
                primaryKey="id"
                sortBy={sortColumn}
                sortDirection={sortDirection}
                onSortChange={handleSortChange}
                currentPage={page}
                itemsPerPage={pageSize}
                itemsPerPageOptions={pageSizeOptions}
                totalItems={totalCount}
                i18n={{itemsPerPage: 'Tasks per page', of: 'of'}}
                onPageChange={onPageChange}
                onItemsPerPageChange={onPageSizeChange}
            />
        </div>
    );
}
