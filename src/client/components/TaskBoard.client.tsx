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
    BOARD_STATES,
    CLOSED_STATE,
    CLOSED_STATE_LABEL,
    COMPLETE_TASK_MUTATION,
    DEFAULT_SCOPE,
    DEFAULT_SORT_BY,
    DEFAULT_SORT_ORDER,
    EMPTY_SCOPE_MESSAGE,
    RESUME_TASK_MUTATION,
    SUSPEND_TASK_MUTATION,
    TASK_BOARD_QUERY,
    TASK_SCOPES,
    UNASSIGN_TASK_MUTATION
} from './taskBoard.shared';
import type {TaskBoardConnection, TaskBoardNode, TaskScope, TaskTarget} from './taskBoard.shared';
import {capitalize, UPDATE_TASK_STATE_MUTATION} from './task.shared';
import './TaskBoard.client.css';

export const DEFAULT_PAGE_SIZE = 25;
const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
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
    initialConnection: TaskBoardConnection;
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
 * Where the button sends somebody, as a jContent location.
 *
 * <p>Content in a page opens the pages accordion on the page that holds it; content in a folder
 * opens the content-folders accordion on the folder that holds it. Either way jContent lists the
 * location's children, so the content is in front of the reader with its own actions on the row.
 *
 * Not Content Editor, though that is the obvious destination for a standalone item: the editor is
 * reached through a React context that only jContent's own tree provides (its exported
 * ContentEditorApiContextProvider supplies an empty object), and no URL opens it. From the
 * dashboard, landing on the item is as close as this can get.
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
    return {site, mode, url: `/jahia/jcontent/${site}/${language}/${mode}${rest ?? ''}`};
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
    // pool. suspendTask would be the natural mutation, but it accepts only a started task
    // ("Only a started task can be suspended"), so an assigned-but-not-started one goes through
    // updateTaskState, which carries the same permission check and the same single write.
    const refuse = (state: string): MenuAction => (state === 'started' ?
        {label: 'Refuse', mutation: SUSPEND_TASK_MUTATION, variables: {id: task.id}} :
        {label: 'Refuse', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'suspended'}});

    if (task.state === 'active' && isUnassigned) {
        primaryActions.push({label: 'Assign to me', mutation: ASSIGN_TASK_TO_ME_MUTATION, variables: {id: task.id}});
    } else if (canAct && task.state === 'active') {
        // Assigned, not started yet.
        primaryActions.push(
            {label: 'Start', mutation: UPDATE_TASK_STATE_MUTATION, variables: {id: task.id, state: 'started'}},
            {label: 'Unassign', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            refuse(task.state)
        );
        if (isPlainTask) {
            primaryActions.push(close);
        }
    } else if (canAct && task.state === 'started') {
        primaryActions.push(
            {label: 'Unassign', mutation: UNASSIGN_TASK_MUTATION, variables: {id: task.id}},
            refuse(task.state)
        );
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
    onAction: (mutation: string, variables: Record<string, unknown>) => void;
};

function TaskCard({task, currentUserKey, canReviewAll, isBusy, onAction}: Readonly<TaskCardProps>) {
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
        <div className={`task-board__card${isClosed ? ' task-board__card--closed' : ''}`}>
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
                                {location && (
                                    <Button
                                        size="default"
                                        variant="outlined"
                                        label="Edit"
                                        data-sel-role="target-edit"
                                        data-sel-target-in-page={String(target.inPage)}
                                        onClick={() => {
                                            preferListView(location.site, location.mode);
                                            window.location.assign(location.url);
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

export default function TaskBoard({initialConnection, graphqlEndpoint, currentUserKey, canReviewAll}: Readonly<TaskBoardProps>) {
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
    // Which of the three lists is showing (see TASK_SCOPES). Single-select: they are alternative
    // answers to "which tasks", not filters that stack.
    const [scope, setScope] = useState<TaskScope>(DEFAULT_SCOPE);
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
                filterState: BOARD_STATES,
                scope
            });
            setConnection(data.taskBoard);
            setCurrentPage(page);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to load tasks.');
        } finally {
            setLoading(false);
        }
    }, [graphqlEndpoint, itemsPerPage, search, sortBy, sortOrder, scope]);

    // itemsPerPage/search/sortBy/sortOrder/scope all change what the *first* page even means, so
    // none of them can be applied by just re-fetching the current page -- every cached cursor is
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
        // Deliberately reacts only to itemsPerPage/search/sortBy/sortOrder/scope: loadPage already
        // closes over all five (declared above) plus graphqlEndpoint/currentPage, which this
        // effect doesn't care about.
    }, [itemsPerPage, search, sortBy, sortOrder, scope]);

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

    let boardContent;
    if (isLoading) {
        boardContent = <Loader/>;
    } else if (rows.length === 0) {
        // A search that found nothing is a different situation from a list that is simply empty,
        // and saying "no task is assigned to you" while a search term is in the box would be wrong.
        boardContent = <EmptyData message={search === '' ? EMPTY_SCOPE_MESSAGE[scope] : 'No task matches this search.'}/>;
    } else {
        boardContent = (
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
                            <Typography variant="caption" weight="light">{connection.pageInfo.totalCount} task(s)</Typography>
                            {TASK_SCOPES.map(option => (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={`task-board__scope${scope === option.value ? ' task-board__scope--selected' : ''}`}
                                    // aria-pressed rather than aria-selected: these are toggle
                                    // buttons in a group, not tabs over one panel of content.
                                    aria-pressed={scope === option.value}
                                    onClick={() => setScope(option.value)}
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
                    {boardContent}
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
