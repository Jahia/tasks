/**
 * How a task is shown and what can be done to it, independent of how the tasks are laid out.
 *
 * Extracted from TaskBoard.client.tsx when the list view arrived: the board and the list are two
 * arrangements of the same tasks, and both have to label a state the same way, colour a due date
 * the same way and offer the same actions. Keeping these here, rather than exporting them from the
 * board, is what lets the board import the list without the two importing each other.
 */

import {Button, Typography} from '@jahia/moonstone';
import {
    ASSIGN_TASK_TO_ME_MUTATION,
    CLOSED_STATE,
    CLOSED_STATE_LABEL,
    COMPLETE_TASK_MUTATION,
    RESUME_TASK_MUTATION,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import type {TaskBoardNode, TaskTarget} from './taskBoard.shared';
import {capitalize, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import './TaskBoard.client.css';

export type ChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'reassuring' | 'light';

// active: ready to be picked up. started: in progress. suspended: parked. finished: done.
export const STATE_CHIP_COLOR: Record<string, ChipColor> = {
    active: 'accent',
    started: 'warning',
    suspended: 'light',
    // Deliberately not 'success': a closed task sits at the bottom of the board among other closed
    // ones, and a green badge on every one of them would pull the eye away from the live work
    // above. The label carries the meaning; the colour only has to stay out of the way.
    finished: 'light'
};

// What a state is called on the card. Only one state needs an entry -- see CLOSED_STATE_LABEL.
export function stateLabel(state: string | null): string {
    return state === CLOSED_STATE ? CLOSED_STATE_LABEL : capitalize(state);
}

// One button per outcome the task actually declares (workflow-specific --
// see TaskBoardMutationExtensions#completeTask). Common synonyms get the
// checklist's fixed labels; anything else falls back to its own raw label.
export function outcomeLabel(outcome: string): string {
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
export function descriptionWithoutPaths(text: string | null): string | null {
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
export function jcontentLanguage(): string {
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
export function locationUrl(target: TaskTarget, language: string): {url: string; site: string; mode: string} | null {
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
export function preferListView(site: string, mode: string): void {
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
export type DueTone = 'late' | 'soon' | 'ok';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function dueTone(iso: string | null, now: number = Date.now()): DueTone | null {
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
export function formatDueDate(iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : CREATED_DATE_FORMAT.format(date);
}

export function formatCreatedDate(iso: string | null): string | null {
    if (!iso) {
        return null;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return `${CREATED_DATE_FORMAT.format(date)}, ${CREATED_TIME_FORMAT.format(date)}`;
}

/**
 * How long a task has been waiting, in whole days since it was created.
 *
 * Derived here rather than read from the server, which stores no such property -- the list's
 * Waiting column sorts on jcr:created for exactly that reason (see LIST_COLUMN_SORT_ARGUMENT).
 * A task created today is 0 days, not 1: it has not yet waited a day.
 */
export function waitingDays(createdDate: string | null, now: number = Date.now()): number {
    if (!createdDate) {
        return 0;
    }

    const created = new Date(createdDate).getTime();
    if (Number.isNaN(created)) {
        return 0;
    }

    return Math.max(0, Math.floor((now - created) / (24 * 60 * 60 * 1000)));
}

type MenuAction = {
    label: string;
    mutation: string;
    variables: {id: string} & Record<string, unknown>;
};

export type TaskActionsProps = {
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
export function TaskActions({task, currentUserKey, canReviewAll, isBusy, onAction}: Readonly<TaskActionsProps>) {
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
