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
import {Button, Chip, DataTable, Typography} from '@jahia/moonstone';
// Type-only, so nothing is imported at runtime from this subpath: the DataTable *component* comes
// from the package's main entry above, while its types are published under the './DataTable'
// export condition.
import type {DataTableColumn} from '@jahia/moonstone/DataTable';
import type {TaskBoardNode} from './taskBoard.shared';
import {
    dueTone,
    formatDueDate,
    STATE_CHIP_COLOR,
    stateLabel,
    TaskActions,
    waitingDays
} from './taskPresentation.client';
import type {ChipColor} from './taskPresentation.client';
import {capitalize} from './task.shared';

/**
 * One row of the table.
 *
 * The two synthetic fields exist because a DataTable column key must be a key of the row type:
 * 'waitingDays' is the value the Waiting column sorts and renders, and 'actions' is a column with
 * no value at all -- its cell is built from the whole row.
 */
type TaskRow = TaskBoardNode & {
    waitingDays: number;
    actions: null;
};

export type ListSortableColumn = 'title' | 'dueDate' | 'waitingDays' | 'owner' | 'state';

type SortDirection = 'ascending' | 'descending';

/**
 * Which taskBoard(sortBy:) argument each sortable column maps to.
 *
 * 'waitingDays' is the only one that isn't a straight rename: waiting duration is stored nowhere,
 * it is derived from jcr:created, and the server sorts on the raw property -- which is also what
 * keeps this column on the query-level fast path, where title/owner/state are resolved-value sorts
 * that scan. 'dueDate' is a raw property too and is already on the server's allow-list
 * (TaskBoardQueryExtensions#ALLOWED_SORT_PROPERTIES), so it joins jcr:created on that fast path.
 *
 * Priority is deliberately absent: it is a stored property but not an allow-listed one, and the
 * server maps anything unrecognised back to its default sort rather than erroring -- so declaring
 * the column sortable would give a header that silently reorders by creation date instead. Making
 * it sort means adding "priority" to that allow-list, and deciding what its order even means
 * (low/normal/high sorts alphabetically as high < low < normal, which is not the useful order).
 */
export const LIST_COLUMN_SORT_ARGUMENT: Record<ListSortableColumn, string> = {
    title: 'title',
    dueDate: 'dueDate',
    waitingDays: 'jcr:created',
    owner: 'owner',
    state: 'state'
};

const LIST_SORT_ARGUMENT_COLUMN: Record<string, ListSortableColumn> = {
    title: 'title',
    dueDate: 'dueDate',
    'jcr:created': 'waitingDays',
    owner: 'owner',
    state: 'state'
};

/**
 * Waiting duration runs BACKWARDS from creation date: the longest-waiting task is the oldest one,
 * so "waiting, descending" has to ask the server for jcr:created ascending. Applied in both
 * directions by the two helpers below, so the column header's arrow always means what the column
 * says ("most waiting first") rather than what the underlying property does.
 */
const invertsDirection = (column: ListSortableColumn): boolean => column === 'waitingDays';

const flip = (direction: SortDirection): SortDirection =>
    (direction === 'ascending' ? 'descending' : 'ascending');

/** A clicked column header, as the sortBy/sortOrder the server wants. */
export function toListSortArgument(column: ListSortableColumn, direction: SortDirection): {sortBy: string; sortOrder: SortDirection} {
    return {
        sortBy: LIST_COLUMN_SORT_ARGUMENT[column],
        sortOrder: invertsDirection(column) ? flip(direction) : direction
    };
}

/**
 * The reverse: the sort currently in effect, as the column and arrow to show.
 *
 * A sort the table has no column for -- 'creator', which the board's own sort-by dropdown offers
 * and no column here displays -- has no header to mark, so it falls back to the Waiting column.
 * The rows are still in the order the server returned; only the arrow is approximate.
 */
export function fromListSortArgument(sortBy: string, sortOrder: SortDirection): {column: ListSortableColumn; direction: SortDirection} {
    const column = LIST_SORT_ARGUMENT_COLUMN[sortBy] ?? 'waitingDays';
    return {column, direction: invertsDirection(column) ? flip(sortOrder) : sortOrder};
}

const PRIORITY_WEIGHT: Record<string, 'default' | 'bold' | 'light'> = {
    high: 'bold',
    normal: 'default',
    low: 'light'
};

/**
 * How long a wait is worth noticing. A fortnight is the point the colour turns red, a week the
 * point it turns amber -- the same thresholds the due date uses, read from the other end.
 */
function waitingColor(days: number): ChipColor {
    if (days > 14) {
        return 'danger';
    }

    return days > 7 ? 'warning' : 'default';
}

function waitingLabel(days: number): string {
    if (days === 0) {
        return 'Today';
    }

    return days === 1 ? '1 day' : `${days} days`;
}

type TaskListTableProps = {
    tasks: TaskBoardNode[];
    currentUserKey: string;
    canReviewAll: boolean;
    busyTaskId: string | null;
    /** True while the viewer is looking at tasks nobody has taken, which is the only list where who else could take one is worth a line. */
    showCandidates: boolean;
    sortBy: string;
    sortOrder: SortDirection;
    onSortChange: (sortBy: string, sortOrder: SortDirection) => void;
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
    /** Absent when the server has no further page, which is what hides the button. */
    onShowMore: (() => void) | null;
};

export default function TaskListTable({
    tasks, currentUserKey, canReviewAll, busyTaskId, showCandidates,
    sortBy, sortOrder, onSortChange, onAction, onShowMore
}: Readonly<TaskListTableProps>) {
    // Computed once per task list rather than per cell: waitingDays is both rendered and used as
    // the column's sort key, and Date.now() has to be the same instant for every row in one render
    // or two tasks created a millisecond apart could round to different day counts.
    const rows: TaskRow[] = useMemo(() => {
        const now = Date.now();
        return tasks.map(task => ({...task, waitingDays: waitingDays(task.createdDate, now), actions: null}));
    }, [tasks]);

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
            key: 'priority',
            label: 'Priority',
            width: '120px',
            // Deliberately NOT sortable -- see LIST_COLUMN_SORT_ARGUMENT for why.
            render: ({data}) => (data.priority ? (
                <Typography variant="body" weight={PRIORITY_WEIGHT[data.priority] ?? 'default'}>
                    {capitalize(data.priority)}
                </Typography>
            ) : null)
        },
        {
            key: 'waitingDays',
            label: 'Waiting',
            width: '120px',
            isSortable: true,
            render: ({data}) => (
                <Chip label={waitingLabel(data.waitingDays)} color={waitingColor(data.waitingDays)}/>
            )
        },
        {
            key: 'owner',
            label: 'Assigned to',
            width: '180px',
            isSortable: true,
            render: ({data}) => (
                <Typography variant="body">{data.assigneeDisplayName ?? 'Unassigned'}</Typography>
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
    ], [showCandidates, currentUserKey, canReviewAll, busyTaskId, onAction]);

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
            <DataTable
                enableSorting
                data={rows}
                columns={columns}
                primaryKey="id"
                sortBy={sortColumn}
                sortDirection={sortDirection}
                onSortChange={handleSortChange}
            />
            {onShowMore && (
                <div className="task-list__show-more">
                    <Button label="Show more" size="big" variant="outlined" onClick={onShowMore}/>
                </div>
            )}
        </div>
    );
}
