import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Banner, Button, Chip, DataTable, EmptyData, Header, Input, Loader, Search, Switch, Tab, TabItem, Textarea, Typography} from '@jahia/moonstone';
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
import {formatDate, useTasksTranslation} from '../lib/i18n';
import type {Translate, TranslatePlural} from '../lib/i18n';
import {
    ALL_STATES,
    ASSIGN_TASK_TO_ME_MUTATION,
    COMPLETE_TASK_MUTATION,
    DEFAULT_SORT_BY,
    DEFAULT_SORT_ORDER,
    dueStatus,
    NOT_FINISHED_STATES,
    RESUME_TASK_MUTATION,
    REVIEW_TASK_MUTATION,
    SCOPE_ALL,
    SCOPE_ASSIGNED_TO_ME,
    SCOPE_CLAIMABLE,
    SUSPEND_TASK_MUTATION,
    TASK_BOARD_QUERY,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import type {TaskBoardConnection, TaskBoardNode, TaskScope} from './taskBoard.shared';
import {priorityLabel, stateLabel, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import {UPDATE_TASK_DATA_TITLE_MUTATION} from './simpleWorkflow.shared';
import './TaskBoard.client.css';

export const DEFAULT_PAGE_SIZE = 25;
const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
// Debounce so every keystroke doesn't fire its own request -- this is a server round-trip
// (TaskBoardQueryExtensions#taskBoard filters title/creator/assignee/state), not a client-side
// filter over an already-loaded page.
const SEARCH_DEBOUNCE_MS = 350;

// Every user-visible string on this board goes through useTasksTranslation() (#62), against the
// 'tasks' namespace in src/main/resources/javascript/locales/{en,fr,de}.json. The second argument
// of every t() call is the English text: it is both the source-readable label and the value
// actually rendered on the SSR-island path, where no i18next instance exists to translate against
// -- see the header of ../lib/i18n.ts.

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

// Pluralized through i18next's own count mechanism rather than a ternary, so each language applies
// its OWN rule to the locale file's "<key>" / "<key>_plural" pair -- French, for instance, keeps
// the singular at 0 ("0 jour"), which an English-shaped `days === 1 ? ... : ...` cannot express.
function waitingLabel(t: Translate, tPlural: TranslatePlural, days: number): string {
    if (days === WAITING_UNKNOWN) {
        return t('board.waiting.unknown', 'unknown');
    }

    if (days === 0) {
        return t('board.waiting.today', 'today');
    }

    if (days < WAITING_WEEKS_FROM_DAYS) {
        return tPlural('board.waiting.days', days, '{{count}} day', '{{count}} days');
    }

    const weeks = Math.floor(days / DAYS_PER_WEEK);
    return tPlural('board.waiting.weeks', weeks, '{{count}} week', '{{count}} weeks');
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
// Due date and priority (#66)
// ---------------------------------------------------------------------------------------------

// All three date styles this board uses ('short' for the 140px Due column, 'dateTime' for its
// tooltip, 'long' for the created-by line) live in ../lib/i18n.ts, formatted in the VIEWER's locale
// rather than the hardcoded 'en-US' this file used before #62 -- see resolveLocale() there for
// where that locale comes from on each of the two rendering paths.

// Priority is carried by the WORD ("High"/"Normal"/"Low"), which is always rendered; the weight
// only makes the extremes easier to pick out while scanning the column. Nothing here is
// colour-only, and nothing is weight-only either.
const PRIORITY_WEIGHT: Record<string, 'light' | 'default' | 'semiBold'> = {
    low: 'light',
    normal: 'default',
    high: 'semiBold'
};

// priorityLabel / stateLabel (the localized display of those two stored choicelist values) live in
// task.shared.ts, beside capitalize() -- the task detail view renders the same two properties and
// must not disagree with the board about how a given value reads.

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

type SortableColumn = 'title' | 'dueDate' | 'waitingDays' | 'owner' | 'state';

// Which taskBoard(sortBy:) argument each sortable column maps to. 'waitingDays' is the only one
// that isn't a straight rename: waiting duration isn't stored anywhere, it's derived from
// jcr:created, and the server sorts on the raw property (which is also what keeps this column on
// the query-level fast path, #64 -- title/owner/state are resolved-value sorts and scan).
// 'dueDate' is a raw property too, and is on the server's own sort allow-list already (see
// TaskBoardQueryExtensions#ALLOWED_SORT_PROPERTIES), so it joins jcr:created on the fast path.
//
// Priority is deliberately NOT here: it is a stored property, but not an allow-listed one, and the
// server maps anything unrecognized back to its default sort rather than erroring -- so declaring
// the column sortable would give a header that silently reorders by creation date instead. Making
// it sort means adding "priority" to that allow-list (and deciding what its order even means:
// low/normal/high sorts alphabetically as high < low < normal, which is not the useful order).
const COLUMN_SORT_ARGUMENT: Record<SortableColumn, string> = {
    title: 'title',
    dueDate: 'dueDate',
    waitingDays: 'jcr:created',
    owner: 'owner',
    state: 'state'
};

const SORT_ARGUMENT_COLUMN: Record<string, SortableColumn> = {
    title: 'title',
    dueDate: 'dueDate',
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
    // Language the server resolves outcome labels in. Passed down from whoever rendered the board
    // (the SSR view knows the page's own locale), so the labels the island re-fetches match the
    // ones it was handed. Omitted -- e.g. from the admin dashboard route, which has no server
    // render pass -- the server falls back to the request's own locale.
    language?: string;
};

// All three are offered to every viewer, reviewer or not. "All tasks" is not a reviewer-only
// switch: for a contributor it means the union they can already see (owned + created + candidate),
// which is exactly the board they had before this control existed.
//
// Each scope carries its own empty-state sentence (#62): "No tasks to show" is accurate for the
// unfiltered board but says the wrong thing under "Assigned to me", where the useful answer is
// that nothing is waiting on YOU -- not that the board is empty.
type ScopeOption = {
    scope: TaskScope;
    label: (t: Translate) => string;
    empty: (t: Translate) => string;
};

const SCOPE_OPTIONS: ScopeOption[] = [
    {
        scope: SCOPE_ASSIGNED_TO_ME,
        label: t => t('board.scopes.assignedToMe', 'Assigned to me'),
        empty: t => t('board.empty.assignedToMe', 'No tasks are assigned to you.')
    },
    {
        scope: SCOPE_CLAIMABLE,
        label: t => t('board.scopes.claimable', 'Available to my group(s)'),
        empty: t => t('board.empty.claimable', 'No tasks are currently available to your group(s).')
    },
    {
        scope: SCOPE_ALL,
        label: t => t('board.scopes.all', 'All tasks'),
        empty: t => t('board.empty.all', 'No tasks to show.')
    }
];

// The tab / tabpanel pair the scope selector forms, so the two can reference each other by id
// without either place inventing the string (see the Tab markup at the bottom of this file).
const SCOPE_TAB_ID = (scope: TaskScope) => `task-board-scope-${scope}`;
const SCOPE_PANEL_ID = 'task-board-panel';

// Which outcome is the "decline" one, for ORDERING only (it goes first, matching the requested
// layout, regardless of the order possibleOutcomes happens to declare them in). Matched against
// the outcome's NAME, never its label: the label is localized server-side (see
// GqlTaskBoard#getPossibleOutcomeDetails), so an English pattern would only recognize it in
// English, while the name is a workflow-definition constant that never changes with the locale.
const REJECT_OUTCOME_PATTERN = /reject|refuse|deny|decline/i;

type MenuAction = {
    // Own identity, rather than reusing the mutation name as the React key: two actions in the
    // same row can now share a mutation (every outcome of a workflow task runs completeTask).
    key: string;
    label: string;
    mutation: string;
    variables: {id: string} & Record<string, unknown>;
    // Set only on the one-click fast path (#67), where the button does more than its outcome label
    // says. Rendered as the button's tooltip.
    hint?: string;
};

// What one click on a row action asks the board to run. The optional comment is written first, in
// its own mutation, and only when the reviewer actually typed one -- the same two-step the legacy
// board did (its sendNewStatus() submitted the taskData form, then posted the state change).
type TaskActionRequest = {
    mutation: string;
    variables: Record<string, unknown>;
    taskDataComment?: {id: string; comment: string};
};

type TaskActionsProps = {
    task: TaskBoardNode;
    currentUserKey: string;
    canReviewAll: boolean;
    isBusy: boolean;
    onAction: (request: TaskActionRequest) => void;
};

// Same state/ownership rules as before this component's redesign -- just rendered as visible,
// always-on-screen buttons now instead of a 3-dot menu. TaskBoardMutationExtensions
// independently re-checks every one of these server-side and is the real security boundary; a
// wrong guess here just surfaces as an error banner.
function TaskActions({task, currentUserKey, canReviewAll, isBusy, onAction}: Readonly<TaskActionsProps>) {
    const {t} = useTasksTranslation();
    // The stored comment is the starting value of the box, and the yardstick for "did the reviewer
    // change anything": the workflow engine pre-fills it with the process summary, so it is
    // normally non-empty and must not be re-saved untouched on every decision.
    const storedComment = task.simpleWorkflowTaskData?.comment ?? '';
    const [comment, setComment] = useState(storedComment);
    const [isCommentOpen, setCommentOpen] = useState(false);
    const isMine = task.owner === currentUserKey;
    const canAct = isMine || canReviewAll;
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

    // Whether this row qualifies for the one-click fast path (#67): an active task, not held by
    // anyone else, that this viewer may take, and that has an actual decision to record.
    //
    // The eligibility half is isAssignableToMe || canReviewAll, NOT viewerRole: viewerRole is
    // deliberately independent of canReviewAll (see GqlTaskBoard#getViewerRole), so a reviewer
    // looking at a task they are not a candidate for reads "none" there while still being fully
    // entitled to decide it -- gating on the role alone would hide the fast path from exactly the
    // users it exists for.
    //
    // The "not held by anyone else" half mirrors reviewTask's own concurrency guard client-side:
    // canAct is true for a reviewer on ANY task, including one another user has already claimed,
    // and reviewTask refuses to steal those. Without this the board would offer a reviewer a button
    // that can only ever come back as an error.
    const canReviewInOneClick = task.state === 'active'
        && (isUnassigned || isMine)
        && (task.isAssignableToMe || canReviewAll)
        && task.possibleOutcomeDetails.length > 0;

    // Reject before accept, matching the requested layout order, regardless of the order the
    // workflow happens to declare its outcomes in -- see REJECT_OUTCOME_PATTERN for why this
    // reads the outcome's name and the button reads its label.
    const decisionsFor = (mutation: string, hint?: string): MenuAction[] => [...task.possibleOutcomeDetails]
        .sort((a, b) => Number(!REJECT_OUTCOME_PATTERN.test(a.name)) - Number(!REJECT_OUTCOME_PATTERN.test(b.name)))
        .map(outcome => ({
            key: outcome.name,
            label: outcome.displayLabel,
            mutation,
            variables: {id: task.id, outcome: outcome.name},
            hint
        }));

    if (task.state === 'active' && isUnassigned) {
        primaryActions.push({key: 'assign', label: t('common.actions.assignToMe', 'Assign to me'), mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}});
    } else if (canAct && task.state === 'active') {
        // Assigned, not started yet.
        primaryActions.push(
            {key: 'unassign', label: t('common.actions.unassign', 'Unassign'), mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            {key: 'start', label: t('common.actions.start', 'Start'), mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}}
        );
    } else if (canAct && task.state === 'started') {
        primaryActions.push(
            {key: 'unassign', label: t('common.actions.unassign', 'Unassign'), mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            {key: 'suspend', label: t('common.actions.suspend', 'Suspend'), mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}}
        );
        showPreview = true;
        // The task is already claimed and started here, so there is nothing for the fast path to
        // collapse: this is the plain completion.
        decisionActions.push(...decisionsFor(COMPLETE_TASK_MUTATION));

        if (decisionActions.length === 0) {
            // A task with no declared outcomes is a manual one (a plain jnt:task, or a workflow
            // task whose step declares none): there is no decision to record, just "this is done".
            // Legacy offered it as a "completed" checkbox; completeTask can't serve it (it demands
            // a declared outcome), so this is the same generic state transition the task detail
            // view's own Complete button makes -- authorized server-side by updateTaskState's
            // owner-or-reviewer check, exactly like every other action here.
            decisionActions.push({
                key: 'complete',
                label: t('common.actions.complete', 'Complete'),
                mutation: UPDATE_TASK_STATE_MUTATION,
                variables: {id: task.id, state: 'finished'}
            });
        }
    } else if (canAct && task.state === 'suspended') {
        primaryActions.push({key: 'resume', label: t('common.actions.resume', 'Resume'), mutation: RESUME_TASK_MUTATION, variables: {id: task.id}});
    }

    // Layered ON TOP of the active branches above rather than replacing either of them: the
    // granular ladder stays exactly as it was (Assign to me on an unassigned task, Unassign/Start
    // on one already claimed), so a reviewer who wants to claim now and decide later still can.
    // This only adds the decision that used to require walking the whole ladder first.
    if (canReviewInOneClick) {
        // Review-before-decide, previously reachable only after Assign + Start: the target content
        // is exactly what the reviewer needs to look at BEFORE deciding, so making the decision one
        // click away while leaving the preview three clicks away would collapse the wrong half.
        showPreview = true;
        decisionActions.push(...decisionsFor(REVIEW_TASK_MUTATION, t('board.actions.oneClickHint', 'Assigns this task to you and records your decision in one step')));
    }

    if (primaryActions.length === 0 && decisionActions.length === 0 && !showPreview) {
        return <Typography variant="caption" weight="light">{t('common.noActions', 'No actions available')}</Typography>;
    }

    const taskData = task.simpleWorkflowTaskData;
    const commentPlaceholder = t('board.comment.placeholder', 'Comment (optional)');
    // Only sent when it actually differs from what's stored -- an untouched (or never-opened) box
    // must not overwrite the node with the value it already holds.
    const commentUpdate = () => (taskData && comment !== storedComment ? {id: taskData.id, comment} : undefined);
    const runDecision = (action: MenuAction) => onAction({
        mutation: action.mutation,
        variables: action.variables,
        taskDataComment: commentUpdate()
    });

    return (
        <div className="task-board__actions">
            <div className="task-board__actions-row">
                {primaryActions.map(action => (
                    <Button
                        key={action.key}
                        label={action.label}
                        size="small"
                        isDisabled={isBusy}
                        onClick={() => onAction({mutation: action.mutation, variables: action.variables})}
                    />
                ))}
                {showPreview && targetUrl && (
                    <Button
                        label={t('common.actions.preview', 'Preview')}
                        size="small"
                        variant="ghost"
                        isDisabled={isBusy}
                        onClick={() => window.open(targetUrl, '_blank', 'noopener,noreferrer')}
                    />
                )}
            </div>
            {taskData && decisionActions.length > 0 && (
                <div className="task-board__actions-row">
                    {isCommentOpen ? (
                        <Textarea
                            className="task-board__comment"
                            value={comment}
                            rows={3}
                            isDisabled={isBusy}
                            placeholder={commentPlaceholder}
                            // The placeholder is the only naming this box has on screen (it is
                            // revealed in place of its own button, leaving no visible label beside
                            // it), so it is repeated as the accessible name -- which survives the
                            // box being filled in, at which point a placeholder stops being read.
                            aria-label={commentPlaceholder}
                            onChange={event => setComment(event.target.value)}
                        />
                    ) : (
                        <Button
                            label={t('board.actions.addComment', 'Add a comment')}
                            size="small"
                            variant="ghost"
                            isDisabled={isBusy}
                            onClick={() => setCommentOpen(true)}
                        />
                    )}
                </div>
            )}
            {decisionActions.length > 0 && (
                <div className="task-board__actions-row task-board__actions-row--decisions">
                    {decisionActions.map(action => (
                        <Button
                            key={action.key}
                            label={action.label}
                            title={action.hint}
                            size="small"
                            color="accent"
                            isDisabled={isBusy}
                            onClick={() => runDecision(action)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

type DueCellProps = {
    dueDate: string | null;
    state: string | null;
    icsUrl: string | null;
    // Only used to name the iCal link for assistive technology -- see its aria-label below.
    taskTitle: string | null;
    locale: string;
};

// The Due column's cell (#66): the date, an "Overdue" chip once it has passed on a task that is
// still open, and the iCalendar export the legacy board offered whenever a due date was set.
//
// The export link lives HERE rather than among the row's actions: it exists if and only if the
// task has a due date, which is exactly what this cell is about, and the Actions column is
// already the busiest one on the board. It is also not an action on the task -- nothing about the
// task changes -- so putting it beside Assign/Start/Suspend would misrepresent it.
//
// Renders nothing at all when there is no due date: an empty cell says "no deadline" more
// directly than a placeholder dash, and most workflow tasks have none.
function DueCell({dueDate, state, icsUrl, taskTitle, locale}: Readonly<DueCellProps>) {
    const {t} = useTasksTranslation();
    const formatted = formatDate(locale, 'short', dueDate);
    if (!formatted) {
        // No due date, or one that can't be parsed -- the same two cases dueStatus() calls "none".
        return null;
    }

    const status = dueStatus(dueDate, state);

    return (
        <div className="task-board__due-cell" title={formatDate(locale, 'dateTime', dueDate) ?? undefined}>
            <Typography variant="body">{formatted}</Typography>
            {/* The overdue signal is this WORD, on a chip that is additionally red -- the colour
                repeats it, it never carries it alone (same rule the Waiting chip follows). */}
            {status === 'overdue' && <Chip label={t('board.due.overdue', 'Overdue')} color="danger"/>}
            {icsUrl && (
                <a
                    className="task-board__ics-link"
                    href={icsUrl}
                    // "iCal" is as short as the 140px column allows, with the sentence-long version
                    // as the tooltip. The accessible name additionally NAMES THE TASK: out of
                    // context a screen reader otherwise announces a page full of identically
                    // labelled "iCal" links with nothing to tell them apart.
                    title={t('board.due.icsHint', 'Download this task as a calendar entry (.ics)')}
                    aria-label={taskTitle
                        ? t('board.due.icsLabel', 'Download "{{title}}" as a calendar entry (.ics)', {title: taskTitle})
                        : t('board.due.icsHint', 'Download this task as a calendar entry (.ics)')}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {t('board.due.ics', 'iCal')}
                </a>
            )}
        </div>
    );
}

type TaskCellProps = {
    task: TaskRow;
    showCandidates: boolean;
    locale: string;
};

// The Task column's cell. Everything the card layout showed above the badges lives here as
// secondary lines rather than being dropped: the workflow summary (or, for a plain jnt:task, its
// own description) and who created it when. Chosen over an expandable row because the summary is
// a single line the reviewer scans while triaging -- hiding it behind a per-row toggle would make
// the common case (read it) cost a click.
function TaskCell({task, showCandidates, locale}: Readonly<TaskCellProps>) {
    const {t} = useTasksTranslation();
    const targetTitle = task.targetNode?.property?.value;
    // "2026-07-20T11:39:20.123Z" -> "July 20, 2026" / "20 juillet 2026". Formatted client-side
    // rather than baking a locale into the server's ISO-8601 getCreatedDate(), which is what lets
    // it follow the VIEWER's locale instead of the writer's.
    const createdDate = formatDate(locale, 'long', task.createdDate);
    // The workflow-engine-derived summary (TaskBoardQueryExtensions#getWorkflowSummary) is only
    // available for a jnt:workflowTask whose process is still live; a plain jnt:task, or one
    // whose summary couldn't be resolved, falls back to its own free-text description instead.
    const summaryLine = task.workflowSummary ?? task.description;

    return (
        <div className="task-board__task-cell">
            <div className="task-board__task-title">
                <Typography component="span" weight="semiBold" variant="body">
                    {task.title ?? t('common.untitledTask', 'Untitled task')}
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
                    {t('board.meta.createdBy', 'Created by: {{creator}}, on {{date}}', {
                        creator: task.creator ?? t('common.unknown', 'Unknown'),
                        date: createdDate
                    })}
                </Typography>
            )}
            {showCandidates && task.candidateDisplayNames.length > 0 && (
                <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                    {t('board.meta.availableTo', 'Available to: {{names}}', {
                        names: task.candidateDisplayNames.join(', ')
                    })}
                </Typography>
            )}
        </div>
    );
}

export default function TaskBoard({initialConnection, initialScope, graphqlEndpoint, currentUserKey, canReviewAll, language}: Readonly<TaskBoardProps>) {
    // `language` doubles as the date-formatting locale on the SSR-island path: it is the page's own
    // UI locale (RenderContext#getUILocale), and there is no i18next instance out there to read one
    // from. Inside the app shell the shell's own i18next language wins over it -- see
    // resolveLocale() in ../lib/i18n.ts.
    const {t, tPlural, locale} = useTasksTranslation(language);
    const [currentPage, setCurrentPage] = useState(1);
    const [connection, setConnection] = useState(initialConnection);
    const [isLoading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
    const [itemsPerPage, setItemsPerPage] = useState(DEFAULT_PAGE_SIZE);
    const [scope, setScope] = useState<TaskScope>(initialScope);
    // Off by default: the board is a worklist, and terminal tasks are only ever looked up
    // deliberately. The initial page this component was handed was fetched with it off too.
    const [showFinished, setShowFinished] = useState(false);
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
                filterState: showFinished ? ALL_STATES : NOT_FINISHED_STATES,
                scope,
                language: language ?? null
            });
            setConnection(data.taskBoard);
            setCurrentPage(page);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('common.error.load', 'Unable to load tasks.'));
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint, itemsPerPage, search, sortColumn, sortDirection, scope, showFinished, language, t]);

    // itemsPerPage/search/sort/scope/showFinished all change what the *first* page even means, so
    // none of them can be applied by just re-fetching the current page -- every cached cursor is
    // invalidated and this always jumps back to page 1. Skipped on mount: initialConnection already
    // is page 1 of initialScope at the (unchanged) defaults.
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }

        cursorsByPage.current = new Map([[1, undefined]]);
        loadPage(1);
        // Deliberately reacts only to the six inputs that redefine page 1: loadPage already
        // closes over all of them (declared above) plus graphqlEndpoint/currentPage, which this
        // effect doesn't care about.
    }, [itemsPerPage, search, sortColumn, sortDirection, scope, showFinished]);

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

    const handleAction = useCallback(async ({mutation, variables, taskDataComment}: TaskActionRequest) => {
        setBusyTaskId(String(variables.id));
        setError(null);
        try {
            if (taskDataComment) {
                // Before the decision, never after: completing a workflow task hands control back
                // to the workflow engine, which may move the task (and its taskData child) out of
                // reach -- so a comment saved afterwards could have nowhere left to land. Its
                // failure aborts the decision too, rather than silently completing without it.
                await callGraphQL(graphqlEndpoint, UPDATE_TASK_DATA_TITLE_MUTATION, {
                    id: taskDataComment.id,
                    title: taskDataComment.comment
                });
            }

            await callGraphQL(graphqlEndpoint, mutation, variables);
            await loadPage(currentPage);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('common.error.action', 'Unable to complete this action.'));
        } finally {
            setBusyTaskId(null);
        }
    }, [graphqlEndpoint, currentPage, loadPage, t]);

    const rows: TaskRow[] = useMemo(() => connection.edges.map(edge => ({
        ...edge.node,
        waitingDays: waitingDaysSince(edge.node.createdDate),
        actions: null
    })), [connection]);

    const columns: Array<DataTableColumn<TaskRow>> = useMemo(() => [
        {
            key: 'title',
            label: t('board.columns.task', 'Task'),
            isSortable: true,
            // Only shown in the claimable scope: everywhere else the row is either already
            // someone's or listed alongside tasks that aren't offered to anyone in particular,
            // and a "who else could take this" line would just be noise.
            render: ({data}) => <TaskCell task={data} showCandidates={scope === SCOPE_CLAIMABLE} locale={locale}/>
        },
        {
            key: 'dueDate',
            label: t('board.columns.due', 'Due'),
            // Wider than the other fixed columns: the cell stacks a date, an "Overdue" chip and
            // the iCal link, and 120px would break "Aug 15, 2026" across two lines.
            width: '140px',
            // Sorted server-side on the raw dueDate property, which is on its allow-list and so
            // stays on the query-level fast path (#64) -- see COLUMN_SORT_ARGUMENT.
            isSortable: true,
            render: ({data}) => (
                <DueCell
                    dueDate={data.dueDate}
                    state={data.state}
                    icsUrl={data.icsUrl}
                    taskTitle={data.title}
                    locale={locale}
                />
            )
        },
        {
            key: 'priority',
            label: t('board.columns.priority', 'Priority'),
            width: '120px',
            // Deliberately NOT sortable -- see COLUMN_SORT_ARGUMENT for why (the server has no
            // allow-list entry for it, and would silently fall back to its default ordering).
            render: ({data}) => (data.priority ? (
                <Typography variant="body" weight={PRIORITY_WEIGHT[data.priority] ?? 'default'}>
                    {priorityLabel(t, data.priority)}
                </Typography>
            ) : null)
        },
        {
            key: 'waitingDays',
            label: t('board.columns.waiting', 'Waiting'),
            width: '120px',
            isSortable: true,
            render: ({data}) => (
                <Chip
                    label={waitingLabel(t, tPlural, data.waitingDays)}
                    color={waitingColor(data.waitingDays)}
                />
            )
        },
        {
            key: 'owner',
            label: t('board.columns.owner', 'Owner'),
            width: '160px',
            isSortable: true,
            render: ({data}) => (
                <Typography variant="body">
                    {data.assigneeDisplayName ?? t('common.unassigned', 'Unassigned')}
                </Typography>
            )
        },
        {
            key: 'state',
            label: t('board.columns.state', 'State'),
            width: '120px',
            isSortable: true,
            render: ({data}) => (
                <Chip label={stateLabel(t, data.state)} color={(data.state && STATE_CHIP_COLOR[data.state]) || 'default'}/>
            )
        },
        {
            key: 'actions',
            label: t('board.columns.actions', 'Actions'),
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
    ], [scope, currentUserKey, canReviewAll, busyTaskId, handleAction, t, tPlural, locale]);

    const activeScope = SCOPE_OPTIONS.find(option => option.scope === scope) ?? SCOPE_OPTIONS[SCOPE_OPTIONS.length - 1];
    const searchLabel = t('board.search.label', 'Search:');

    let boardContent;
    if (isLoading) {
        boardContent = <Loader/>;
    } else if (rows.length === 0) {
        // role="status": this replaces the table in place when a tab, the search box or the
        // "Show finished" toggle changes the listing, so a screen-reader user who never moves
        // focus here still hears that the result is empty. Polite, not assertive -- it is the
        // outcome of what they just did, not an interruption.
        boardContent = <EmptyData role="status" message={activeScope.empty(t)}/>;
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
            // No wrapper, and above all no background of its own: Moonstone's Header already paints
            // itself with the --moon-background-selector token, and ContentLayout's own <main>
            // carries --color-gray_light behind it. The hardcoded `backgroundColor: 'white'` that
            // used to wrap this was a third, un-tokenized layer on top of those two, and the only
            // literal colour left in this component -- which is exactly what broke under the dark
            // theme (white strip, dark title on it). Every colour on this board is now a token.
            header={<Header title={t('board.title', 'Tasks')}/>}
            content={(
                <div className="task-board__content">
                    <div className="task-board__scopes">
                        {/* Moonstone renders Tab as role="tablist" and each TabItem as a
                            <button role="tab" aria-selected> with arrow-key navigation between
                            siblings, so the selector is already operable from the keyboard. What it
                            does not do is name the tablist or tie the tabs to what they control --
                            both supplied here (Moonstone spreads unknown props straight onto the
                            rendered element). */}
                        <Tab aria-label={t('board.scopes.label', 'Task scope')}>
                            {SCOPE_OPTIONS.map(option => (
                                <TabItem
                                    key={option.scope}
                                    id={SCOPE_TAB_ID(option.scope)}
                                    aria-controls={SCOPE_PANEL_ID}
                                    label={option.label(t)}
                                    isSelected={scope === option.scope}
                                    onClick={() => setScope(option.scope)}
                                />
                            ))}
                        </Tab>
                        <div className="task-board__show-finished">
                            {/* Moonstone's Switch spreads its rest props onto the underlying
                                <input type="checkbox">, so this id is the input's own -- which is
                                what makes the <label for> below a real accessible name for the
                                control rather than a caption sitting next to it. */}
                            <Switch
                                id="task-board-show-finished"
                                checked={showFinished}
                                isDisabled={isLoading}
                                onChange={() => setShowFinished(current => !current)}
                            />
                            <label htmlFor="task-board-show-finished">
                                <Typography component="span" variant="body">
                                    {t('board.showFinished', 'Show finished')}
                                </Typography>
                            </label>
                        </div>
                    </div>
                    <div className="task-board__toolbar">
                        <Typography variant="caption" weight="light">
                            {tPlural('board.taskCount', connection.pageInfo.totalCount, '{{count}} task', '{{count}} tasks')}
                        </Typography>
                        <div className="task-board__search">
                            <Typography id="task-board-search-label" variant="body" weight="semiBold">{searchLabel}</Typography>
                            <Input
                                className="task-board__search-input"
                                icon={<Search/>}
                                placeholder={t('board.search.placeholder', 'Search tasks...')}
                                value={searchInput}
                                // The visible "Search:" text is a Typography span, not a <label>,
                                // so it can't be associated with for/htmlFor -- referenced by id
                                // instead, which gives the input the same accessible name without
                                // changing the layout.
                                aria-labelledby="task-board-search-label"
                                onChange={e => setSearchInput(e.target.value)}
                            />
                        </div>
                    </div>
                    {error && (
                        // role="alert" (an assertive live region): the banner appears in response to
                        // an action the user just took and states why it failed, which is the one
                        // thing on this board worth interrupting for.
                        <Banner role="alert" title={t('common.error.title', 'Something went wrong')} variant="danger">
                            {error}
                        </Banner>
                    )}
                    <div
                        id={SCOPE_PANEL_ID}
                        className="task-board__panel"
                        role="tabpanel"
                        aria-labelledby={SCOPE_TAB_ID(scope)}
                    >
                        {boardContent}
                    </div>
                </div>
            )}
        />
    );
}
