import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowDown, ArrowUp, Banner, Button, Chip, Dropdown, EmptyData, Header, Input, Loader, Search, Typography} from '@jahia/moonstone';
// Deep import, not the package's bare '@jahia/moonstone-alpha' entry point: that barrel
// (dist/components/index.js) re-exports Checkbox/DatePicker/etc. too, which drag in transitive
// deps (e.g. @react-aria/focus) this module never installs and doesn't otherwise need -- see
// the matching deep path in moonstone-alpha.d.ts.
import {ContentLayout} from '@jahia/moonstone-alpha/dist/components/ContentLayout';
import {callGraphQL} from '../lib/graphqlClient';
import {
    ASSIGN_TASK_TO_ME_MUTATION,
    BOARD_COLUMNS,
    CLOSED_STATE,
    CLOSED_STATE_LABEL,
    COMPLETE_TASK_MUTATION,
    DEFAULT_SCOPE,
    DEFAULT_SORT_BY,
    DEFAULT_SORT_ORDER,
    EMPTY_SCOPE_MESSAGE,
    RESUME_TASK_MUTATION,
    TASK_BOARD_QUERY,
    TASK_SCOPES,
    UNASSIGN_TASK_MUTATION,
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
    TaskScope,
    TaskTarget
} from './taskBoard.shared';
import {capitalize, UPDATE_TASK_STATE_MUTATION} from './task.shared';
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
type SortField = 'jcr:created' | 'title' | 'creator' | 'owner' | 'state';
type SortDirection = 'ascending' | 'descending';

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
    initialColumns: TaskBoardQueryResult;
    graphqlEndpoint: string;
    currentUserKey: string;
    canReviewAll: boolean;
};

type ChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'reassuring' | 'light';

// active: ready to be picked up. started: in progress. suspended: parked. finished: done.
const STATE_CHIP_COLOR: Record<string, ChipColor> = {
    active: 'accent',
    started: 'warning',
    suspended: 'light',
    // Deliberately not 'success': a closed task sits at the bottom of the board among other closed
    // ones, and a green badge on every one of them would pull the eye away from the live work
    // above. The label carries the meaning; the colour only has to stay out of the way.
    finished: 'light'
};

// What a state is called on the card. Only one state needs an entry -- see CLOSED_STATE_LABEL.
function stateLabel(state: string | null): string {
    return state === CLOSED_STATE ? CLOSED_STATE_LABEL : capitalize(state);
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

// "2026-07-20T11:39:20.123Z" -> "July 20, 2026, 11:39:20 AM". Formatted client-side (rather than
// baking a fixed locale into the server's ISO-8601 getCreatedDate()) so it can follow the
// viewer's own locale later; hardcoded to 'en-US' for now, matching every other hardcoded English
// label already in this component.
// Module-scope singletons: a TaskCard is created once per board row, so hoisting these out of
// formatCreatedDate avoids allocating two new Intl.DateTimeFormat instances on every render.
const CREATED_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'long', day: 'numeric'});
const CREATED_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true});

/**
 * The description as the person typed it, without the paths appended after it.
 *
 * The content-types module writes the selected records' JCR paths into the description itself
 * (taskDescription() joins the body and the paths with a blank line), because the board used to
 * show nothing else about what a task was for. It shows the targets properly now, so those lines
 * are the same information twice - in its least readable form.
 *
 * Trailing lines that begin with "/" are dropped rather than everything after the first blank
 * line: a description can legitimately have paragraphs, and only a path starts that way. A task
 * whose description was ONLY paths ends up with no description line at all, which is right.
 */
function descriptionWithoutPaths(text: string | null): string | null {
    if (!text) {
        return null;
    }

    const lines = text.split('\n');
    while (lines.length > 0) {
        const last = lines[lines.length - 1].trim();
        if (last === '' || last.startsWith('/')) {
            lines.pop();
        } else {
            break;
        }
    }

    const kept = lines.join('\n').trim();
    return kept === '' ? null : kept;
}

/**
 * The language segment a jContent URL carries.
 *
 * The board is a dashboard screen with no site or language of its own, and a task may point at
 * content on any site, so there is nothing to inherit from. It borrows the app shell's own
 * language from contextJsParameters - the same object jContent reads its defaults from - and falls
 * back to English, which is what a missing language segment would resolve to anyway.
 */
function jcontentLanguage(): string {
    const shell = globalThis as unknown as {contextJsParameters?: {lang?: string; uilang?: string}};
    return shell.contextJsParameters?.lang ?? shell.contextJsParameters?.uilang ?? 'en';
}

/**
 * One string, rison-encoded, the way jContent's URL hash wants it.
 *
 * Rison is what jContent reads its hash with (rison-node, via ContentEditorApi's
 * rison.decode_uri). Only the one shape this file produces is handled here -- a flat object of
 * string and boolean values inside a one-element list -- rather than pulling in the package for a
 * single URL that a dashboard island builds once.
 *
 * Strings are always quoted, even where rison would allow a bare identifier: a uuid beginning with
 * a digit may NOT be bare (rison's not_idstart is "-0123456789"), and quoting everything removes
 * the case analysis. Inside a quoted string rison escapes ' and ! with a leading !.
 */
const risonString = (value: string) => `'${value.replace(/(['!])/g, '!$1')}'`;

/**
 * The hash that makes jContent open Content Editor on one node as it loads.
 *
 * ContentEditorApi keeps its open editors in the URL hash and reads them back on mount, so a
 * config put there by somebody else opens the same editor - which is how this board reaches an
 * editor that is otherwise only available through a React context inside jContent's own tree.
 * The keys are the ones useEdit() builds: uuid, lang, mode ("edit", ContentEditor.constants'
 * baseEditRoute) and isFullscreen.
 *
 * Every character this produces -- ( ) : , ! ' and the uuid's own hyphens -- is in rison's uri_ok
 * set, so its encode_uri is the identity here and the string needs no further escaping.
 */
function contentEditorHash(uuid: string, language: string): string {
    const config = [
        'isFullscreen:!t',
        `lang:${risonString(language)}`,
        `mode:${risonString('edit')}`,
        `uuid:${risonString(uuid)}`
    ].join(',');
    return `#(contentEditor:!((${config})))`;
}

/**
 * Where the button sends somebody: Content Editor, open on the target itself.
 *
 * <p>The path is still the LOCATION rather than the node - the page that holds the content, or the
 * folder it sits in - so that closing the editor leaves the reader looking at the content among
 * its siblings, with its own row actions, instead of somewhere they never chose to be. The node
 * itself is named in the hash (see contentEditorHash).
 *
 * <p>This used to be the location alone, on the belief that no URL could open Content Editor. That
 * was wrong: the context is indeed unreachable from a dashboard module, but ContentEditorApi also
 * takes its editors from the hash, which anybody can write. Verified against the running site --
 * /jahia/jcontent/luxe/en/pages/home plus a hash naming the "life-style" section opened the
 * editor on that section, title field and all.
 *
 * The site comes out of the path rather than from context, because the board is a dashboard screen
 * with no site of its own and a task may point anywhere.
 */
function locationUrl(target: TaskTarget, language: string): {url: string; site: string; mode: string} | null {
    const match = /^\/sites\/([^/]+)(\/.*)?$/.exec(target.locationPath);
    if (!match) {
        return null;
    }

    const [, site, rest] = match;
    const mode = target.inPage ? 'pages' : 'content-folders';
    const location = `/jahia/jcontent/${site}/${language}/${mode}${rest ?? ''}`;
    return {site, mode, url: `${location}${contentEditorHash(target.uuid, language)}`};
}

/**
 * Asks jContent to open in its list view before sending somebody there.
 *
 * The view mode is not in the URL: jContent reads it out of localStorage as it parses the address
 * (`jcontent-previous-tableView-viewMode-<site>-<mode>`, JContent.redux.js), falling back to the
 * accordion's own default. The pages accordion defaults to the page builder, which renders the page
 * rather than listing what is in it - so a component target landed somewhere the content could not
 * be picked out at all.
 *
 * The cost is that this becomes the reader's remembered mode for that accordion, the same as if
 * they had switched to List themselves. Landing them where the content is visible is worth it, and
 * the switcher is right there to change back.
 */
function preferListView(site: string, mode: string): void {
    try {
        window.localStorage.setItem(`jcontent-previous-tableView-viewMode-${site}-${mode}`, 'flatList');
    } catch {
        // A private window or a full quota. The navigation still happens; it just arrives in
        // whatever view jContent already preferred.
    }
}

/**
 * How urgent a due date is, as one of three states the card colours.
 *
 * Late is anything in the past; soon is inside a week. Everything further out is "ok", which
 * covers both "more than a month" and the fortnight in between - the brief named only those
 * three, and a fourth colour for 8-30 days would say something nobody asked to distinguish.
 *
 * A month is taken as 30 days deliberately: this is a colour, not an anniversary, and a
 * calendar-accurate month would make the boundary move with the month the reader happens to be in.
 */
type DueTone = 'late' | 'soon' | 'ok';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function dueTone(iso: string | null, now: number = Date.now()): DueTone | null {
    if (!iso) {
        return null;
    }

    const due = new Date(iso).getTime();
    if (Number.isNaN(due)) {
        return null;
    }

    if (due < now) {
        return 'late';
    }

    return due - now < WEEK_MS ? 'soon' : 'ok';
}

/** The due date as a day, with no time of day: a due date is a deadline, not an appointment. */
function formatDueDate(iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : CREATED_DATE_FORMAT.format(date);
}

function formatCreatedDate(iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return `${CREATED_DATE_FORMAT.format(date)}, ${CREATED_TIME_FORMAT.format(date)}`;
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
    // Closed is the end of the line: nothing can be started, refused, unassigned or closed again,
    // and none of the state branches below match it. Returning early states that outright rather
    // than leaving it to fall through them, so a branch added later cannot accidentally offer an
    // action on a task that is done.
    if (task.state === CLOSED_STATE) {
        return null;
    }

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

    // Closing a plain task means writing state=finished directly. A workflow task must NEVER be
    // closed that way: completeTask writes finalOutcome in the same save because the Drools rule
    // reads it off the node as it reacts to the state change, and finishing without one would tell
    // the real workflow nothing about the decision. So Close is offered only for a jnt:task, and a
    // jnt:workflowTask is finished through its own outcome buttons below.
    //
    // Decided on the node type rather than on possibleOutcomes being empty: a workflow task whose
    // process is no longer live also reports no outcomes, and that one must stay un-closable rather
    // than quietly take the plain-task path.
    const isPlainTask = task.taskType !== 'jnt:workflowTask';
    const close: MenuAction = {
        label: 'Close',
        mutation: UPDATE_TASK_STATE_MUTATION,
        variables: {id: task.id, state: 'finished'}
    };
    // "Refuse" parks the task rather than handing it back - Unassign is what returns it to the
    // pool. Offered on an active task only (see the started branch below), so it always takes the
    // updateTaskState route: suspendTask would be the natural mutation but it accepts a started
    // task only ("Only a started task can be suspended"). updateTaskState carries the same
    // permission check and the same single write.
    const refuse: MenuAction = {
        label: 'Refuse',
        mutation: UPDATE_TASK_STATE_MUTATION,
        variables: {id: task.id, state: 'suspended'}
    };

    if (task.state === 'active' && isUnassigned) {
        primaryActions.push({label: 'Assign to me', mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}});
    } else if (canAct && task.state === 'active') {
        // Assigned, not started yet.
        primaryActions.push(
            {label: 'Start', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}},
            {label: 'Unassign', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            refuse
        );
        if (isPlainTask) {
            primaryActions.push(close);
        }
    } else if (canAct && task.state === 'started') {
        // No Unassign and no Refuse here, deliberately. Both are answers to "I am not going to do
        // this", and once the work is started that answer is out of date: what is left is to
        // finish it, or to move it back to Active first and then hand it back. Keeping them on a
        // started task also made the two hard to tell apart -- Refuse parks the task while
        // Unassign returns it to the pool, a distinction nobody has to care about before starting.
        if (isPlainTask) {
            primaryActions.push(close);
        }
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
        // Closable from here too: a refused task that turns out to be done should not have to be
        // resumed first just to be closed.
        if (isPlainTask) {
            primaryActions.push(close);
        }
    }

    if (primaryActions.length === 0 && decisionActions.length === 0 && !showPreview) {
        return <Typography variant="caption" weight="light">No actions available</Typography>;
    }

    return (
        <div className="task-board__actions">
            <div className="task-board__actions-row">
                {primaryActions.map(action => (
                    <Button
                        /* Keyed by label, not by mutation: Start, Refuse and Close all go
                           through updateTaskState, so the mutation is no longer unique in a row. */
                        key={action.label}
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

    return (
        <div
            className={`task-board__card${isClosed ? ' task-board__card--closed' : ''}${canDrag ? ' task-board__card--draggable' : ''}`}
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
                    `Assigned to: ${task.assigneeDisplayName ?? 'Unassigned'}`
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

export default function TaskBoard({initialColumns, graphqlEndpoint, currentUserKey, canReviewAll}: Readonly<TaskBoardProps>) {
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
            // All three columns in one document (see TASK_BOARD_QUERY): they share the search, the
            // sort and the scope, and fetching them together keeps them consistent with each other
            // as well as saving two round trips.
            const data = await callGraphQL<TaskBoardQueryResult>(graphqlEndpoint, TASK_BOARD_QUERY, {
                ...columnFirstsFrom(limits),
                search: search === '' ? null : search,
                sortBy,
                sortOrder,
                scope
            });
            setColumns(data);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to load tasks.');
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint, limits, search, sortBy, sortOrder, scope]);

    // Every input to the query is already in loadBoard's dependency list, so "re-fetch when
    // something changed" is exactly "re-fetch when loadBoard changed" -- there is no second list
    // here to drift out of step with that one. Skipped on mount: initialColumns IS this fetch, at
    // these same defaults (see initialBoardVariables).
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }

        loadBoard();
    }, [loadBoard]);

    const handleAction = useCallback(async (mutation: string, variables: Record<string, unknown>) => {
        setBusyTaskId(String(variables.id));
        setError(null);
        setNotice(null);
        try {
            await callGraphQL(graphqlEndpoint, mutation, variables);
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

    // Changing what the board is showing puts every column back to one page: a limit raised on the
    // old list means nothing on the new one.
    const changeScope = (next: TaskScope) => {
        setScope(next);
        setLimits(DEFAULT_LIMITS);
    };

    const changeSortBy = (next: SortField) => {
        setSortBy(next);
        setLimits(DEFAULT_LIMITS);
    };

    const toggleSortOrder = () => {
        setSortOrder(current => (current === 'ascending' ? 'descending' : 'ascending'));
        setLimits(DEFAULT_LIMITS);
    };

    const isEmpty = BOARD_COLUMNS.every(column => columns[column.key].pageInfo.totalCount === 0);
    const totalCount = BOARD_COLUMNS.reduce((sum, column) => sum + columns[column.key].pageInfo.totalCount, 0);

    let boardContent;
    if (isLoading) {
        boardContent = <Loader/>;
    } else if (isEmpty) {
        // A search that found nothing is a different situation from a list that is simply empty,
        // and saying "no task is assigned to you" while a search term is in the box would be wrong.
        boardContent = <EmptyData message={search === '' ? EMPTY_SCOPE_MESSAGE[scope] : 'No task matches this search.'}/>;
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
                    <Header title="Tasks"/>
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
