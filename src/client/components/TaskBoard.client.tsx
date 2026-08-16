import type {MutableRefObject, ReactElement} from 'react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AddComment, Banner, Button, Chip, DataTable, EmptyData, Header, Input, Loader, Menu, MenuItem, MoreVert, OpenInNew, Search, Separator, Switch, Tab, TabItem, Textarea, Typography, Visibility} from '@jahia/moonstone';
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
import type {Translate} from '../lib/i18n';
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
    UNASSIGN_TASK_MUTATION,
    waitingColor,
    waitingDaysSince,
    waitingLabel
} from './taskBoard.shared';
import type {ChipColor, TaskBoardConnection, TaskBoardNode, TaskScope} from './taskBoard.shared';
import {priorityLabel, stateLabel, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import {UPDATE_TASK_DATA_TITLE_MUTATION} from './simpleWorkflow.shared';
import TaskPreviewPanel from './TaskPreviewPanel';
import type {PreviewTarget} from './TaskPreviewPanel';
import {languageOfRenderUrl, toContentLanguage} from './taskPreview.shared';
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

// active: ready to be picked up. started: in progress. suspended: parked. finished: done.
const STATE_CHIP_COLOR: Record<string, ChipColor> = {
    active: 'accent',
    started: 'warning',
    suspended: 'light',
    finished: 'success'
};

// The waiting-duration trio (waitingDaysSince/waitingLabel/waitingColor, plus their thresholds)
// lives in taskBoard.shared.ts, beside dueStatus: both are pure functions of a stored value and an
// instant, and keeping them out of this Moonstone-importing module is what lets them be exercised
// directly (tests/cypress/e2e/task-duration.cy.ts, #63). Only their RENDERING is here.

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

// What a row's "Preview" action asks the board to show in its side panel is PreviewTarget, defined
// beside the panel that consumes it (./TaskPreviewPanel) rather than here: since #61 it carries the
// previewed node's uuid/path/language too, which only that component's tabs read.
//
// A ROW supplies everything but the language, which is not a property of the row at all: it is the
// language the preview is being looked at in, resolved once by the board (see handlePreview).
type PreviewRequest = Omit<PreviewTarget, 'language'>;

type TaskRowActionsProps = {
    task: TaskBoardNode;
    currentUserKey: string;
    canReviewAll: boolean;
    isBusy: boolean;
    isCommentOpen: boolean;
    commentDrafts: MutableRefObject<Map<string, string>>;
    onAction: (request: TaskActionRequest) => void;
    onOpenComment: (taskId: string) => void;
    onPreview: (target: PreviewRequest) => void;
};

// Same state/ownership rules as before, and the same server-side truth: what changed here is only
// how those actions are PRESENTED. This follows jcontent's row pattern -- every per-row action of
// its content table lives behind one <MoreVert/> button (JContent.actions.jsx registers them all
// under a single 'contentItemActionsMenu'), and the cell holding it is revealed on row hover
// (ContentTable.scss: `tr:hover .cellActions`). Rebuilt on plain Moonstone Menu/MenuItem rather
// than reused: jcontent is an application, not a library this module could import from, and its
// menu goes through its own action registry and redux store.
//
// TaskBoardMutationExtensions independently re-checks every one of these server-side and is the
// real security boundary; a wrong guess here just surfaces as an error banner.
function TaskRowActions({task, currentUserKey, canReviewAll, isBusy, isCommentOpen, commentDrafts, onAction, onOpenComment, onPreview}: Readonly<TaskRowActionsProps>) {
    const {t} = useTasksTranslation();
    const [isMenuOpen, setMenuOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);
    // The stored comment is the starting value of the box, and the yardstick for "did the reviewer
    // change anything": the workflow engine pre-fills it with the process summary, so it is
    // normally non-empty and must not be re-saved untouched on every decision.
    const storedComment = task.simpleWorkflowTaskData?.comment ?? '';
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
    // Kept visually separated (below a Separator in the menu) from primaryActions: these are
    // workflow publication decisions, not routine task-management actions.
    const decisionActions: MenuAction[] = [];

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
        decisionActions.push(...decisionsFor(REVIEW_TASK_MUTATION, t('board.actions.oneClickHint', 'Assigns this task to you and records your decision in one step')));
    }

    const taskData = task.simpleWorkflowTaskData;
    // Only sent when it actually differs from what's stored -- an untouched (or never-opened) box
    // must not overwrite the node with the value it already holds. Read out of the board's draft
    // map at CLICK time rather than from a render-time snapshot: the box itself lives in another
    // cell of the same row (see TaskCommentEditor) and its keystrokes deliberately do not
    // re-render this menu. `undefined` means "never typed in", which is not the same as "typed the
    // stored value back in" -- both end up sending nothing, but only the first is the common case.
    const commentUpdate = () => {
        if (!taskData) {
            return undefined;
        }

        const draft = commentDrafts.current.get(task.id);
        return draft !== undefined && draft !== storedComment ? {id: taskData.id, comment: draft} : undefined;
    };

    const runDecision = (action: MenuAction) => onAction({
        mutation: action.mutation,
        variables: action.variables,
        taskDataComment: commentUpdate()
    });

    // Every menu item closes the menu before doing anything: the action either re-fetches the page
    // underneath it (which would leave a menu floating over rows that no longer match it) or opens
    // something else that now owns the reviewer's attention.
    const closeThen = (run: () => void) => () => {
        setMenuOpen(false);
        run();
    };

    // Menu requires each top-level child to be a single MenuItem element -- its internal
    // auto-search-threshold check does `children[0].props[...]`, which throws if children[0] is
    // itself an array (the same trap TaskListItem.client.tsx documents at length). One flat array
    // built up front, rather than a ternary/&& mix of JSX expressions as Menu's children, keeps
    // every child a plain element.
    //
    // Keys are namespaced per group: an outcome's name is workflow-defined and could in principle
    // collide with one of the fixed primary-action keys, and the two groups are siblings now.
    const menuItems: ReactElement[] = [];

    primaryActions.forEach(action => {
        menuItems.push(
            <MenuItem
                key={`primary-${action.key}`}
                label={action.label}
                isDisabled={isBusy}
                onClick={closeThen(() => onAction({mutation: action.mutation, variables: action.variables}))}
            />
        );
    });

    // Same condition the "Add a comment" button had: only a task carrying a jnt:simpleWorkflow
    // child has anywhere to store a comment, and only a decision gives it a purpose. Dropped once
    // the editor is open, since the item's whole job is to reveal it.
    if (taskData && decisionActions.length > 0 && !isCommentOpen) {
        menuItems.push(
            <MenuItem
                key="comment"
                label={t('board.actions.addComment', 'Add a comment')}
                iconStart={<AddComment/>}
                isDisabled={isBusy}
                onClick={closeThen(() => onOpenComment(task.id))}
            />
        );
    }

    // Both preview actions are offered on any row whose target still resolves to a renderable URL,
    // rather than only in the states that used to carry the single Preview button (started, or
    // one-click-eligible). Preview is a read-only look at the content and is exactly what a
    // reviewer needs BEFORE deciding anything, so gating it on a state they first have to claim
    // their way into put it behind the very clicks it exists to save.
    if (targetUrl && task.targetNode) {
        const targetNode = task.targetNode;
        const targetTitle = targetNode.property?.value;
        const taskTitle = task.title ?? t('common.untitledTask', 'Untitled task');
        menuItems.push(
            <MenuItem
                key="preview"
                label={t('common.actions.preview', 'Preview')}
                iconStart={<Visibility/>}
                onClick={closeThen(() => onPreview({
                    title: targetTitle ?? taskTitle,
                    taskTitle,
                    url: targetUrl,
                    uuid: targetNode.uuid,
                    path: targetNode.path
                }))}
            />,
            <MenuItem
                key="preview-new-tab"
                label={t('board.actions.previewInNewTab', 'Preview in a new tab')}
                iconStart={<OpenInNew/>}
                onClick={closeThen(() => window.open(targetUrl, '_blank', 'noopener,noreferrer'))}
            />
        );
    }

    if (decisionActions.length > 0) {
        if (menuItems.length > 0) {
            menuItems.push(<Separator key="decisions-separator" variant="horizontal" spacing="small"/>);
        }

        decisionActions.forEach(action => {
            menuItems.push(
                <MenuItem
                    key={`decision-${action.key}`}
                    label={action.label}
                    // The one-click fast path's explanatory hint (#67), which used to be the
                    // button's tooltip and is now the menu item's -- MenuItem spreads unknown
                    // props onto its <li>.
                    title={action.hint}
                    isDisabled={isBusy}
                    onClick={closeThen(() => runDecision(action))}
                />
            );
        });
    }

    const hasActions = menuItems.length > 0;
    // A row with nothing to offer still gets a (disabled) kebab rather than an empty cell, so the
    // Actions column stays visually regular and the answer to "why is there no menu here?" is on
    // the control itself instead of being absent.
    const menuLabel = hasActions
        ? t('board.actions.showMenu', 'Show task actions')
        : t('common.noActions', 'No actions available');

    return (
        <div
            ref={anchorRef}
            className={`task-board__row-actions${isMenuOpen ? ' task-board__row-actions--open' : ''}`}
            // Escape closes the menu: Moonstone's Menu dismisses itself on its own click-away
            // overlay only, and never on a key. The handler sits on this wrapper because the menu
            // is rendered as a DOM child of it (it is merely position:fixed), so a keydown on the
            // button or on any menu item bubbles through here. Stopped from going further, so one
            // Escape doesn't also close the preview panel listening on the document.
            onKeyDown={event => {
                if (event.key === 'Escape' && isMenuOpen) {
                    event.stopPropagation();
                    setMenuOpen(false);
                }
            }}
        >
            <Button
                icon={<MoreVert/>}
                variant="ghost"
                isDisabled={isBusy || !hasActions}
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
                // The button has no label of its own (it is an icon), so both the accessible name
                // and the pointer tooltip have to be supplied.
                aria-label={menuLabel}
                title={menuLabel}
                onClick={() => setMenuOpen(open => !open)}
            />
            {/* Mounted only while open, unlike the always-rendered Menu in TaskListItem: Moonstone
                hides a closed menu with opacity+pointer-events, which leaves its items in the tab
                order -- one page of this board would otherwise bury 25 invisible menus' worth of
                tab stops between the table and the pagination. */}
            {isMenuOpen && (
                <Menu
                    isDisplayed
                    // Never: seven items is reachable in one look, and Moonstone would otherwise
                    // auto-add a search box past its own 7-child threshold.
                    hasSearch={false}
                    anchorEl={anchorRef as MutableRefObject<HTMLDivElement>}
                    anchorElOrigin={{vertical: 'bottom', horizontal: 'right'}}
                    transformElOrigin={{vertical: 'top', horizontal: 'right'}}
                    onClose={() => setMenuOpen(false)}
                >
                    {menuItems}
                </Menu>
            )}
        </div>
    );
}

type TaskCommentEditorProps = {
    taskId: string;
    initialValue: string;
    drafts: MutableRefObject<Map<string, string>>;
    isDisabled: boolean;
};

// The optional decision comment, opened from the row's own action menu and rendered inline in the
// Task cell -- not in the Actions cell it used to share with the buttons, which is now 72px wide
// and cannot hold a text box at all.
//
// The text is local state here and MIRRORED into the board-level `drafts` map, which is a ref
// rather than state on purpose: the value is read exactly once, by the decision the row's menu
// runs (see commentUpdate above), and nothing else on the board depends on it. Holding it in board
// state instead would re-render every row of the table on every keystroke.
function TaskCommentEditor({taskId, initialValue, drafts, isDisabled}: Readonly<TaskCommentEditorProps>) {
    const {t} = useTasksTranslation();
    // Seeded from the draft map first, so a re-render of the table (every action triggers one)
    // brings back what the reviewer had already typed rather than the stored value.
    const [value, setValue] = useState(() => drafts.current.get(taskId) ?? initialValue);
    const placeholder = t('board.comment.placeholder', 'Comment (optional)');

    return (
        <Textarea
            // Opened by an explicit menu choice, so the cursor belongs in it: without this the
            // reviewer's next keystroke goes nowhere, the menu having just closed.
            autoFocus
            className="task-board__comment"
            value={value}
            rows={3}
            isDisabled={isDisabled}
            placeholder={placeholder}
            // The placeholder is the only naming this box has on screen (it is revealed on its own,
            // with no visible label beside it), so it is repeated as the accessible name -- which
            // survives the box being filled in, at which point a placeholder stops being read.
            aria-label={placeholder}
            onChange={event => {
                setValue(event.target.value);
                drafts.current.set(taskId, event.target.value);
            }}
        />
    );
}

type DueCellProps = {
    dueDate: string | null;
    state: string | null;
    locale: string;
};

// The Due column's cell (#66): the date, and an "Overdue" chip once it has passed on a task that
// is still open.
//
// The .ics export link #66 also put here was dropped again by the product owner (#65): the board
// is a worklist, not a calendar feed. The .ics VIEW itself (jnt_task/ics/task.jsp, plus the
// org.jahia.taglibs imports its taglib needs -- see pom.xml) stays, since it is a shipped view of
// the module and was broken independently of this board.
//
// Renders nothing at all when there is no due date: an empty cell says "no deadline" more
// directly than a placeholder dash, and most workflow tasks have none.
function DueCell({dueDate, state, locale}: Readonly<DueCellProps>) {
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
        </div>
    );
}

type TaskCellProps = {
    task: TaskRow;
    showCandidates: boolean;
    locale: string;
    isCommentOpen: boolean;
    isBusy: boolean;
    commentDrafts: MutableRefObject<Map<string, string>>;
};

// The Task column's cell. Everything the card layout showed above the badges lives here as
// secondary lines rather than being dropped: the workflow summary (or, for a plain jnt:task, its
// own description) and who created it when. Chosen over an expandable row because the summary is
// a single line the reviewer scans while triaging -- hiding it behind a per-row toggle would make
// the common case (read it) cost a click.
function TaskCell({task, showCandidates, locale, isCommentOpen, isBusy, commentDrafts}: Readonly<TaskCellProps>) {
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
            {/* Opened from the row's action menu, two columns to the right -- see
                TaskCommentEditor for why the box ended up in this cell rather than that one. */}
            {isCommentOpen && (
                <TaskCommentEditor
                    taskId={task.id}
                    initialValue={task.simpleWorkflowTaskData?.comment ?? ''}
                    drafts={commentDrafts}
                    isDisabled={isBusy}
                />
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
    // The row whose inline comment editor is open, if any -- one at a time, since it is opened from
    // that row's own action menu. Owned by the board rather than by the row's actions because the
    // two halves now sit in different DataTable columns: the menu item that opens it is in the
    // Actions cell, the box itself is in the Task cell (see TaskCommentEditor).
    const [openCommentTaskId, setOpenCommentTaskId] = useState<string | null>(null);
    // Draft comment text per task id. A ref, not state: the box holds its own value locally, and
    // the only other reader is the decision a row's menu runs, which reads it at click time -- so
    // nothing here has to re-render when a key is pressed.
    const commentDrafts = useRef<Map<string, string>>(new Map());
    // The single preview panel this board owns: picking "Preview" on another row swaps what it
    // shows rather than stacking a second panel on top.
    const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
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
            // The row's comment editor has done its job once the action it was written for landed:
            // its text has either just been saved (taskDataComment above) or was never touched.
            // Dropped here rather than left open, so the reloaded row doesn't come back carrying a
            // draft that is now either redundant or about a decision already recorded.
            const actedTaskId = String(variables.id);
            commentDrafts.current.delete(actedTaskId);
            setOpenCommentTaskId(current => (current === actedTaskId ? null : current));
            await loadPage(currentPage);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('common.error.action', 'Unable to complete this action.'));
        } finally {
            setBusyTaskId(null);
        }
    }, [graphqlEndpoint, currentPage, loadPage, t]);

    const handleOpenComment = useCallback((taskId: string) => setOpenCommentTaskId(taskId), []);
    // The panel's three data tabs all query per LANGUAGE, and the honest answer to "which one" is
    // the language the iframe beside them is rendering: the target URL's own language segment,
    // which the server built (GqlTaskBoard#getTargetNode resolves it through a session that has a
    // locale, precisely so this segment is right). The viewer's UI locale is the fallback, reduced
    // to a bare language code -- Jahia stores translations per language, so "fr-FR" would ask for
    // a translation node that a site declaring plain "fr" does not have.
    const handlePreview = useCallback((target: PreviewRequest) => setPreviewTarget({
        ...target,
        language: languageOfRenderUrl(target.url) ?? toContentLanguage(language ?? locale)
    }), [language, locale]);
    const handleClosePreview = useCallback(() => setPreviewTarget(null), []);

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
            render: ({data}) => (
                <TaskCell
                    task={data}
                    showCandidates={scope === SCOPE_CLAIMABLE}
                    locale={locale}
                    isCommentOpen={openCommentTaskId === data.id}
                    isBusy={busyTaskId === data.id}
                    commentDrafts={commentDrafts}
                />
            )
        },
        {
            key: 'dueDate',
            label: t('board.columns.due', 'Due'),
            // Wider than the other fixed columns: the cell stacks a date and an "Overdue" chip,
            // and 120px would break "Aug 15, 2026" across two lines.
            width: '140px',
            // Sorted server-side on the raw dueDate property, which is on its allow-list and so
            // stays on the query-level fast path (#64) -- see COLUMN_SORT_ARGUMENT.
            isSortable: true,
            render: ({data}) => (
                <DueCell
                    dueDate={data.dueDate}
                    state={data.state}
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
            // Down from 280px: every action moved into the kebab's menu, so this column only has to
            // hold one icon button -- wide enough for that plus the column header's own "Actions"
            // label, which is what stops this being narrower still. Any change to this number has
            // to be carried into the table's min-width in TaskBoard.client.css, which is the sum of
            // the fixed columns.
            width: '80px',
            render: ({data}) => (
                <TaskRowActions
                    task={data}
                    currentUserKey={currentUserKey}
                    canReviewAll={canReviewAll}
                    isBusy={busyTaskId === data.id}
                    isCommentOpen={openCommentTaskId === data.id}
                    commentDrafts={commentDrafts}
                    onAction={handleAction}
                    onOpenComment={handleOpenComment}
                    onPreview={handlePreview}
                />
            )
        }
    ], [scope, currentUserKey, canReviewAll, busyTaskId, openCommentTaskId, handleAction, handleOpenComment, handlePreview, t, tPlural, locale]);

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
                <>
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
                    {/* Outside .task-board__content on purpose: that element is the board's own scroll
                        container (overflow on both axes), and this panel is pinned to the viewport
                        rather than to the table it floats over. */}
                    {previewTarget && (
                        <TaskPreviewPanel
                            target={previewTarget}
                            graphqlEndpoint={graphqlEndpoint}
                            onClose={handleClosePreview}
                        />
                    )}
                </>
            )}
        />
    );
}
