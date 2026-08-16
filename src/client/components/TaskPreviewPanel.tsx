import type {ReactElement, ReactNode} from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Banner, Button, Chip, Clock, Close, ContentReference, EmptyData, Information, Loader, Paper, Tab, TabItem, Typography, Visibility} from '@jahia/moonstone';
import {callGraphQL} from '../lib/graphqlClient';
import {formatDate, useTasksTranslation} from '../lib/i18n';
import type {Translate} from '../lib/i18n';
import type {ChipColor} from './taskBoard.shared';
import {
    PREVIEW_DETAILS_QUERY,
    PREVIEW_DETAILS_QUERY_WITHOUT_PUBLICATION,
    PREVIEW_HISTORY_QUERY,
    PREVIEW_HISTORY_QUERY_WITHOUT_CONTENT_HISTORY,
    PREVIEW_USAGES_QUERY
} from './taskPreview.shared';
import type {
    PreviewContentHistoryEntry,
    PreviewDetailsNode,
    PreviewDetailsResult,
    PreviewHistoryResult,
    PreviewUsageNode,
    PreviewUsagesResult,
    PreviewWorkflowEntry,
    PreviewWorkflowProcess
} from './taskPreview.shared';

/**
 * The task board's "Preview" side panel (#61).
 *
 * <h3>Why this is rebuilt rather than reused from jContent</h3>
 * The product owner asked for "the component with details, preview, usages, history" -- jContent's
 * content side panel. That component exists (JContent/SidePanel/SidePanel.jsx, with its tabs
 * registered as actions in registerSidePanelTabs.js), and it is NOT reachable from here:
 *
 * <ul>
 *   <li>jcontent federates exactly three modules -- './init', './JContent/actions' and '.' (its
 *       webpack.config.js `exposes`; confirmed against the remoteEntry.js actually deployed on the
 *       bench, whose module map holds those same three keys and nothing else). The panel is in
 *       none of them: '.' is src/javascript/shared/index.js, a list of ~30 named exports that
 *       covers the content tree, the content table's cells and the content-editor contexts, and
 *       does not include SidePanel, ContentDetails, ContentUsages or ContentHistory.</li>
 *   <li>The tabs ARE registry-registered, but into jcontent's OWN registry target
 *       ('sidePanelTabsActions'), which is a surface for ADDING a tab to jcontent's panel -- not
 *       for rendering that panel somewhere else. SidePanel reads every tab's data from
 *       useSidePanelContext(), a React context only jcontent's own routes provide.</li>
 *   <li>Even the reachable half would not load: '.' pulls apollo/client, material-ui/core,
 *       @jahia/design-system-kit and react-router out of the federation share scope, none of which
 *       this module shares (its share list is react / react-dom / @jahia/ui-extender -- see the
 *       "dependencies" note in package.json, which must not grow).</li>
 * </ul>
 *
 * So the UX SHAPE is replicated on plain Moonstone -- a drawer with a tab strip and a close button,
 * one tab per aspect -- while the data comes from queries of our own. Two of those read the same
 * provider fields jContent's tabs read (`usages` with the workflowTask filter, `aggregatedPublication
 * Info`, `history`), so the two panels agree about the content even though they share no code.
 *
 * <h3>Shell</h3>
 * Unchanged from the iframe-only panel this replaces: same Paper, same fixed position and z-index
 * (below Moonstone's Menu, so a row's action menu still opens on top of it -- see the CSS), same
 * document-level Escape, same single instance swapping its target. Moonstone 2.20.3's own Drawer is
 * still not what this needs: layout-only, no positioning, no dismissal, and it does not forward
 * Paper's hasPadding.
 */

// What the board hands the panel: everything it needs to identify what is being previewed,
// resolved once by the row that opened it. The panel never looks the task up again, which is what
// lets it keep showing what it was opened on while the board reloads underneath it.
export type PreviewTarget = {
    // The target page's own title -- what the panel is actually showing.
    title: string;
    // The task the preview was opened from, kept beside the page title so the panel still says
    // which piece of work this content is being looked at for.
    taskTitle: string;
    url: string;
    // The three tabs beyond the iframe all query the target NODE rather than the task: uuid for
    // the two jcr lookups, path for workflowActivity, language for every localized field (and for
    // the Details tab's own "Language" row).
    uuid: string;
    path: string;
    language: string;
};

type TaskPreviewPanelProps = {
    target: PreviewTarget;
    // The board's own endpoint, passed down rather than carried on the target: it is a property of
    // where this board is mounted, identical for every row it can preview.
    graphqlEndpoint: string;
    onClose: () => void;
};

const TAB_PREVIEW = 'preview';
const TAB_DETAILS = 'details';
const TAB_USAGES = 'usages';
const TAB_HISTORY = 'history';

type PanelTab = typeof TAB_PREVIEW | typeof TAB_DETAILS | typeof TAB_USAGES | typeof TAB_HISTORY;

const PANEL_TABS: PanelTab[] = [TAB_PREVIEW, TAB_DETAILS, TAB_USAGES, TAB_HISTORY];

// The tab / tabpanel id pair, so the two can point at each other without either place inventing
// the string -- same shape the board's scope tabs use.
const TAB_ID = (tab: PanelTab) => `task-board-preview-tab-${tab}`;
const PANEL_ID = (tab: PanelTab) => `task-board-preview-panel-${tab}`;

const TAB_LABEL: Record<PanelTab, (t: Translate) => string> = {
    [TAB_PREVIEW]: t => t('common.actions.preview', 'Preview'),
    [TAB_DETAILS]: t => t('board.preview.tabs.details', 'Details'),
    [TAB_USAGES]: t => t('board.preview.tabs.usages', 'Usages'),
    [TAB_HISTORY]: t => t('board.preview.tabs.history', 'History')
};

// ReactElement rather than ReactNode: TabItem's own `icon` prop is typed as an element, and a
// ReactNode (which admits null and plain strings) is not assignable to it.
const TAB_ICON: Record<PanelTab, ReactElement> = {
    [TAB_PREVIEW]: <Visibility/>,
    [TAB_DETAILS]: <Information/>,
    [TAB_USAGES]: <ContentReference/>,
    // Moonstone 2.20.3 ships no History icon (jContent's own tab uses one from a later release);
    // Clock is the nearest thing it does export, and the tab is labelled anyway.
    [TAB_HISTORY]: <Clock/>
};

// The provider's PublicationStatus enum, localized. Every value it declares is listed rather than
// the two or three a page usually shows: an unlisted one would surface as a raw SCREAMING_CASE
// token, and which values occur is a property of the content, not of this panel.
const PUBLICATION_STATUS_LABEL: Record<string, (t: Translate) => string> = {
    PUBLISHED: t => t('board.preview.publication.published', 'Published'),
    MODIFIED: t => t('board.preview.publication.modified', 'Modified'),
    NOT_PUBLISHED: t => t('board.preview.publication.notPublished', 'Not published'),
    UNPUBLISHED: t => t('board.preview.publication.unpublished', 'Unpublished'),
    MANDATORY_LANGUAGE_UNPUBLISHABLE: t => t('board.preview.publication.mandatoryLanguageUnpublishable', 'Blocked by a mandatory language'),
    MANDATORY_LANGUAGE_VALID: t => t('board.preview.publication.mandatoryLanguageValid', 'Mandatory languages complete'),
    LIVE_MODIFIED: t => t('board.preview.publication.liveModified', 'Modified in live'),
    LIVE_ONLY: t => t('board.preview.publication.liveOnly', 'Live only'),
    CONFLICT: t => t('board.preview.publication.conflict', 'Conflict'),
    DELETED: t => t('board.preview.publication.deleted', 'Deleted'),
    MARKED_FOR_DELETION: t => t('board.preview.publication.markedForDeletion', 'Marked for deletion')
};

// Colour repeats what the label already says; it never carries the status on its own -- the same
// rule the board's Waiting and Overdue chips follow.
const PUBLICATION_STATUS_COLOR: Record<string, ChipColor> = {
    PUBLISHED: 'success',
    MODIFIED: 'warning',
    NOT_PUBLISHED: 'default',
    UNPUBLISHED: 'default',
    MANDATORY_LANGUAGE_UNPUBLISHABLE: 'danger',
    MANDATORY_LANGUAGE_VALID: 'success',
    LIVE_MODIFIED: 'warning',
    LIVE_ONLY: 'accent',
    CONFLICT: 'danger',
    DELETED: 'danger',
    MARKED_FOR_DELETION: 'danger'
};

// The content-history feed's own action vocabulary (GqlContentHistoryEntry#action), localized.
// Anything else is rendered verbatim -- it is the provider's word, and inventing an English
// sentence for a value we don't know would be worse than showing it.
const HISTORY_ACTION_LABEL: Record<string, (t: Translate) => string> = {
    created: t => t('board.preview.history.actions.created', 'Created'),
    added: t => t('board.preview.history.actions.added', 'Added'),
    updated: t => t('board.preview.history.actions.updated', 'Updated'),
    removed: t => t('board.preview.history.actions.removed', 'Removed'),
    published: t => t('board.preview.history.actions.published', 'Published'),
    unpublished: t => t('board.preview.history.actions.unpublished', 'Unpublished')
};

// ---------------------------------------------------------------------------------------------
// Lazy per-tab loading
// ---------------------------------------------------------------------------------------------

type TabResource<T> =
    | {status: 'idle'}
    | {status: 'loading'}
    | {status: 'ready'; data: T}
    | {status: 'error'; message: string};

/**
 * Fetches a tab's data the first time that tab is activated, and remembers it per node for as long
 * as the panel stays open.
 *
 * The cache is a ref keyed by the previewed node, not by the tab: this panel is a single instance
 * that SWAPS its target (picking Preview on another row re-renders it rather than mounting a second
 * one), so React state survives the swap and coming back to a node already looked at must not
 * re-query it. Closing the panel unmounts this, which is what bounds the cache.
 *
 * `load` is deliberately not an effect dependency -- it closes over the target and would be a new
 * function on every render, re-running the fetch forever. The ref holds the latest one; `cacheKey`
 * is what actually decides when to fetch again.
 */
function useTabResource<T>(isActive: boolean, cacheKey: string, load: () => Promise<T>): TabResource<T> {
    const [resource, setResource] = useState<TabResource<T>>({status: 'idle'});
    const cache = useRef<Map<string, T>>(new Map());
    const loadRef = useRef(load);
    loadRef.current = load;

    useEffect(() => {
        if (!isActive) {
            return undefined;
        }

        const cached = cache.current.get(cacheKey);
        if (cached !== undefined) {
            setResource({status: 'ready', data: cached});
            return undefined;
        }

        // Not cancelled on unmount only: switching target while a request is in flight must not let
        // the old answer land in the new node's panel.
        let isStale = false;
        setResource({status: 'loading'});
        loadRef.current()
            .then(data => {
                if (isStale) {
                    return;
                }

                cache.current.set(cacheKey, data);
                setResource({status: 'ready', data});
            })
            .catch((error: unknown) => {
                if (isStale) {
                    return;
                }

                setResource({status: 'error', message: error instanceof Error ? error.message : String(error)});
            });

        return () => {
            isStale = true;
        };
    }, [isActive, cacheKey]);

    return resource;
}

/**
 * Runs `primary`, and on ANY failure runs `fallback` instead.
 *
 * Used for the two blocks of this panel's queries that name fields the DXM provider supplies as
 * extensions rather than as part of the JCR schema (aggregatedPublicationInfo, and the content
 * history feed). GraphQL rejects an unknown field at VALIDATION time, i.e. the whole document
 * fails and no data at all comes back -- so "degrade gracefully" cannot be a null check on the
 * result, it has to be a second, narrower request.
 */
async function withFallbackQuery<T>(
    endpoint: string,
    primary: string,
    fallback: string,
    variables: Record<string, unknown>
): Promise<T> {
    try {
        return await callGraphQL<T>(endpoint, primary, variables);
    } catch {
        return callGraphQL<T>(endpoint, fallback, variables);
    }
}

// ---------------------------------------------------------------------------------------------
// Shared presentation
// ---------------------------------------------------------------------------------------------

type TabBodyProps<T> = {
    resource: TabResource<T>;
    // Rendered for the two non-ready states so every tab fails and empties the same way.
    errorTitle: string;
    children: (data: T) => ReactNode;
};

function TabBody<T>({resource, errorTitle, children}: Readonly<TabBodyProps<T>>) {
    if (resource.status === 'error') {
        return (
            // role="alert": this replaces the tab's content in response to the reviewer opening it,
            // and states why there is nothing to show.
            <Banner role="alert" title={errorTitle} variant="danger">
                {resource.message}
            </Banner>
        );
    }

    if (resource.status !== 'ready') {
        return <Loader/>;
    }

    return <>{children(resource.data)}</>;
}

type DetailRowProps = {
    label: string;
    children: ReactNode;
};

// One labelled row of the Details tab. A <dt>/<dd> pair rather than two spans: this really is a
// description list, and the pairing is then carried by the markup instead of only by the layout.
function DetailRow({label, children}: Readonly<DetailRowProps>) {
    return (
        <>
            <Typography component="dt" variant="caption" weight="light" className="task-board__preview-label">
                {label}
            </Typography>
            <dd className="task-board__preview-value">{children}</dd>
        </>
    );
}

function TextRow({label, value}: Readonly<{label: string; value: string | null | undefined}>) {
    if (!value) {
        return null;
    }

    return (
        <DetailRow label={label}>
            <Typography component="span" variant="body">{value}</Typography>
        </DetailRow>
    );
}

// ---------------------------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------------------------

function DetailsTab({node, locale, language}: Readonly<{node: PreviewDetailsNode | null; locale: string; language: string}>) {
    const {t} = useTasksTranslation();

    if (!node) {
        return <EmptyData role="status" message={t('board.preview.details.unavailable', 'This content is no longer available.')}/>;
    }

    const publication = node.aggregatedPublicationInfo;
    const publicationLabel = publication
        ? (PUBLICATION_STATUS_LABEL[publication.publicationStatus]?.(t) ?? publication.publicationStatus)
        : null;

    return (
        <dl className="task-board__preview-details">
            <TextRow label={t('board.preview.details.name', 'Name')} value={node.displayName}/>
            <TextRow
                label={t('board.preview.details.type', 'Content type')}
                value={node.primaryNodeType?.displayName ?? node.primaryNodeType?.name}
            />
            <TextRow label={t('board.preview.details.path', 'Path')} value={node.path}/>
            <TextRow label={t('board.preview.details.uuid', 'UUID')} value={node.uuid}/>
            <TextRow label={t('board.preview.details.language', 'Language')} value={language}/>
            <TextRow
                label={t('board.preview.details.created', 'Created')}
                value={formatDate(locale, 'dateTime', node.created?.value ?? null)}
            />
            <TextRow label={t('board.preview.details.createdBy', 'Created by')} value={node.createdBy?.value}/>
            <TextRow
                label={t('board.preview.details.lastModified', 'Last modified')}
                value={formatDate(locale, 'dateTime', node.lastModified?.value ?? null)}
            />
            <TextRow label={t('board.preview.details.lastModifiedBy', 'Last modified by')} value={node.lastModifiedBy?.value}/>
            {publicationLabel && (
                <DetailRow label={t('board.preview.details.publication', 'Publication status')}>
                    <Chip
                        label={publicationLabel}
                        color={PUBLICATION_STATUS_COLOR[publication?.publicationStatus ?? ''] ?? 'default'}
                    />
                    {publication?.workInProgress && (
                        <Chip label={t('board.preview.details.workInProgress', 'Work in progress')} color="warning"/>
                    )}
                    {publication?.locked && (
                        <Chip label={t('board.preview.details.locked', 'Locked')} color="light"/>
                    )}
                </DetailRow>
            )}
        </dl>
    );
}

// ---------------------------------------------------------------------------------------------
// Usages
// ---------------------------------------------------------------------------------------------

function UsagesTab({usages, totalCount}: Readonly<{usages: PreviewUsageNode[]; totalCount: number}>) {
    const {t, tPlural} = useTasksTranslation();

    if (usages.length === 0) {
        return (
            <EmptyData
                role="status"
                message={t('board.preview.usages.empty', 'No other content references this one.')}
            />
        );
    }

    return (
        <div className="task-board__preview-list">
            <Typography variant="caption" weight="light" className="task-board__preview-count">
                {tPlural('board.preview.usages.count', totalCount, '{{count}} reference', '{{count}} references')}
            </Typography>
            <ul className="task-board__preview-items">
                {usages.map(usage => (
                    <li key={usage.uuid} className="task-board__preview-item">
                        {/* Opened in a new tab rather than into the iframe beside it: this is
                            navigation AWAY from the content under review, and swapping the preview
                            frame out for it would lose the very thing the reviewer is deciding on. */}
                        {usage.renderUrl ? (
                            <a
                                className="task-board__preview-link"
                                href={usage.renderUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {usage.displayName ?? usage.path}
                            </a>
                        ) : (
                            <Typography component="span" variant="body" weight="semiBold">
                                {usage.displayName ?? usage.path}
                            </Typography>
                        )}
                        <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                            {usage.path}
                        </Typography>
                        {usage.primaryNodeType && (
                            <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                                {usage.primaryNodeType.displayName ?? usage.primaryNodeType.name}
                            </Typography>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

function HistorySection({title, children}: Readonly<{title: string; children: ReactNode}>) {
    return (
        <section className="task-board__preview-section">
            <Typography component="h3" variant="subheading" weight="semiBold">{title}</Typography>
            {children}
        </section>
    );
}

function WorkflowHistory({history, locale}: Readonly<{history: PreviewHistoryResult['workflowActivity']; locale: string}>) {
    const {t} = useTasksTranslation();
    const {processes, activeTasks, history: completed} = history;

    if (processes.length === 0 && activeTasks.length === 0 && completed.length === 0) {
        return (
            <EmptyData
                role="status"
                message={t('board.preview.history.noWorkflow', 'No workflow has run on this content.')}
            />
        );
    }

    const processLine = (process: PreviewWorkflowProcess) => t(
        'board.preview.history.started',
        '{{workflow}} started by {{user}} on {{date}}',
        {
            workflow: process.name ?? t('board.preview.history.workflow', 'Workflow'),
            user: process.startUser ?? t('common.unknown', 'Unknown'),
            date: formatDate(locale, 'dateTime', process.startTime) ?? t('common.unknown', 'Unknown')
        }
    );

    // The step is what a completed entry is ABOUT; the outcome is only meaningful when the engine
    // actually recorded one (jBPM's own history writes the literal string "outcome" as a
    // placeholder -- see GqlWorkflowActivityTask#getName), so it is appended, never substituted.
    const entryLine = (entry: PreviewWorkflowEntry, date: string | null) => {
        const step = entry.name ?? entry.label ?? t('board.preview.history.step', 'Step');
        const parts = [step];
        if (entry.user) {
            parts.push(t('board.preview.history.by', 'by {{user}}', {user: entry.user}));
        }

        const formatted = formatDate(locale, 'dateTime', date);
        if (formatted) {
            parts.push(t('board.preview.history.on', 'on {{date}}', {date: formatted}));
        }

        return parts.join(' ');
    };

    return (
        <ul className="task-board__preview-items">
            {processes.map(process => (
                <li key={`process-${process.startTime}-${process.name}`} className="task-board__preview-item">
                    <Typography component="span" variant="body">{processLine(process)}</Typography>
                    <Chip
                        label={process.isCompleted
                            ? t('board.preview.history.completed', 'Completed')
                            : t('board.preview.history.running', 'Running')}
                        color={process.isCompleted ? 'success' : 'accent'}
                    />
                </li>
            ))}
            {activeTasks.map(entry => (
                <li key={`active-${entry.name}-${entry.dueDate}`} className="task-board__preview-item">
                    <Typography component="span" variant="body">{entryLine(entry, entry.dueDate ?? null)}</Typography>
                </li>
            ))}
            {completed.map(entry => (
                <li key={`done-${entry.name}-${entry.endTime}`} className="task-board__preview-item">
                    <Typography component="span" variant="body">{entryLine(entry, entry.endTime ?? null)}</Typography>
                </li>
            ))}
        </ul>
    );
}

function ContentHistory({entries, locale}: Readonly<{entries: PreviewContentHistoryEntry[]; locale: string}>) {
    const {t} = useTasksTranslation();

    if (entries.length === 0) {
        return <EmptyData role="status" message={t('board.preview.history.noChanges', 'No recorded changes.')}/>;
    }

    return (
        <ul className="task-board__preview-items">
            {entries.map(entry => {
                const action = entry.action ?? '';
                const actionLabel = HISTORY_ACTION_LABEL[action]?.(t) ?? action;
                return (
                    <li key={entry.id} className="task-board__preview-item">
                        <Typography component="span" variant="body">
                            {entry.propertyNameDisplay ? `${actionLabel} - ${entry.propertyNameDisplay}` : actionLabel}
                        </Typography>
                        <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                            {t('board.preview.history.change', '{{user}}, {{date}}', {
                                user: entry.user?.displayName ?? entry.userKey ?? t('common.unknown', 'Unknown'),
                                date: formatDate(locale, 'dateTime', entry.date) ?? t('common.unknown', 'Unknown')
                            })}
                        </Typography>
                    </li>
                );
            })}
        </ul>
    );
}

function HistoryTab({data, locale}: Readonly<{data: PreviewHistoryResult; locale: string}>) {
    const {t} = useTasksTranslation();
    const contentHistory = data.jcr?.nodeById?.history;

    return (
        <div className="task-board__preview-sections">
            <HistorySection title={t('board.preview.history.workflowTitle', 'Workflow')}>
                <WorkflowHistory history={data.workflowActivity} locale={locale}/>
            </HistorySection>
            {/* Absent, not empty, when the provider has no content-history feed at all -- the
                request that would have carried it is retried without this block (see
                withFallbackQuery), and a section that could not be asked about is not shown. */}
            {contentHistory && (
                <HistorySection title={t('board.preview.history.contentTitle', 'Content changes')}>
                    <ContentHistory entries={contentHistory.entries} locale={locale}/>
                </HistorySection>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------------------------

export default function TaskPreviewPanel({target, graphqlEndpoint, onClose}: Readonly<TaskPreviewPanelProps>) {
    const {t, locale} = useTasksTranslation();
    const [activeTab, setActiveTab] = useState<PanelTab>(TAB_PREVIEW);
    const label = t('board.preview.label', 'Content preview');
    const closeLabel = t('board.preview.close', 'Close preview');
    const errorTitle = t('common.error.title', 'Something went wrong');

    // Listened for on the document, not on the panel: this panel is deliberately not modal (the
    // board behind it stays scrollable and clickable, which is the point of previewing beside the
    // worklist), so by the time the reviewer wants it gone their focus is usually back in the
    // table. A row menu's own Escape handler stops the event before it reaches here, so one
    // Escape never closes both.
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const endpoint = graphqlEndpoint;
    const {uuid, path, language} = target;

    const loadDetails = useCallback(() => withFallbackQuery<PreviewDetailsResult>(
        endpoint,
        PREVIEW_DETAILS_QUERY,
        PREVIEW_DETAILS_QUERY_WITHOUT_PUBLICATION,
        {uuid, language}
    ), [endpoint, uuid, language]);

    const loadUsages = useCallback(() => callGraphQL<PreviewUsagesResult>(
        endpoint,
        PREVIEW_USAGES_QUERY,
        {uuid, language}
    ), [endpoint, uuid, language]);

    const loadHistory = useCallback(() => withFallbackQuery<PreviewHistoryResult>(
        endpoint,
        PREVIEW_HISTORY_QUERY,
        PREVIEW_HISTORY_QUERY_WITHOUT_CONTENT_HISTORY,
        {path, uuid, language}
    ), [endpoint, path, uuid, language]);

    // Keyed by the node AND the language: the same node in another language is a different set of
    // translated properties, modification dates and publication statuses.
    const cacheKey = `${uuid}|${language}`;
    const details = useTabResource(activeTab === TAB_DETAILS, cacheKey, loadDetails);
    const usages = useTabResource(activeTab === TAB_USAGES, cacheKey, loadUsages);
    const history = useTabResource(activeTab === TAB_HISTORY, cacheKey, loadHistory);

    return (
        <Paper
            hasPadding={false}
            className="task-board__preview"
            role="dialog"
            // Deliberately no aria-modal: nothing behind this panel is inert, and claiming
            // otherwise would tell a screen reader the rest of the board is unavailable.
            aria-label={label}
        >
            <div className="task-board__preview-header">
                <div className="task-board__preview-titles">
                    <Typography component="h2" variant="subheading" weight="semiBold">{target.title}</Typography>
                    <Typography component="p" variant="caption" weight="light" className="task-board__meta">
                        {t('board.preview.task', 'Task: {{title}}', {title: target.taskTitle})}
                    </Typography>
                </div>
                <Button
                    // The panel opens from a menu item that unmounts with the menu, so focus would
                    // otherwise be left on a detached node: it is moved onto the one control that
                    // dismisses the thing that just appeared. Deliberately not the tab strip --
                    // Moonstone's Tab is arrow-key navigable from wherever it is entered, and
                    // landing on "Close" keeps the panel dismissable without a single Tab press.
                    autoFocus
                    icon={<Close/>}
                    variant="ghost"
                    aria-label={closeLabel}
                    title={closeLabel}
                    onClick={onClose}
                />
            </div>
            {/* Moonstone renders Tab as role="tablist" and each TabItem as a <button role="tab"
                aria-selected> with arrow-key navigation between siblings -- the same component the
                board's scope selector uses. What it does not do is name the tablist or tie each tab
                to the panel it controls; both are supplied here (Moonstone spreads unknown props
                straight onto the rendered element). */}
            <Tab className="task-board__preview-tabs" aria-label={t('board.preview.tabs.label', 'Preview sections')}>
                {PANEL_TABS.map(tab => (
                    <TabItem
                        key={tab}
                        id={TAB_ID(tab)}
                        aria-controls={PANEL_ID(tab)}
                        icon={TAB_ICON[tab]}
                        label={TAB_LABEL[tab](t)}
                        isSelected={activeTab === tab}
                        onClick={() => setActiveTab(tab)}
                    />
                ))}
            </Tab>
            {/* All four panels stay MOUNTED and are hidden with the `hidden` attribute rather than
                unmounted, for one reason that matters: the iframe. Unmounting it on every tab
                switch would re-request (and re-render) the page each time the reviewer came back to
                it, losing its scroll position and any state the page itself holds. The three data
                tabs are cheap to keep mounted, and their loading is driven by `isActive` rather
                than by mounting, so nothing is fetched before its tab is opened. */}
            <div
                id={PANEL_ID(TAB_PREVIEW)}
                className="task-board__preview-tabpanel task-board__preview-tabpanel--frame"
                role="tabpanel"
                aria-labelledby={TAB_ID(TAB_PREVIEW)}
                hidden={activeTab !== TAB_PREVIEW}
            >
                {/* Keyed by URL so swapping to another row's preview mounts a fresh frame instead
                    of navigating this one -- which would otherwise build up a back-history inside
                    the panel that nothing exposes a way to walk. */}
                <iframe
                    key={target.url}
                    className="task-board__preview-frame"
                    src={target.url}
                    title={label}
                />
            </div>
            <div
                id={PANEL_ID(TAB_DETAILS)}
                className="task-board__preview-tabpanel"
                role="tabpanel"
                aria-labelledby={TAB_ID(TAB_DETAILS)}
                hidden={activeTab !== TAB_DETAILS}
            >
                <TabBody resource={details} errorTitle={errorTitle}>
                    {data => <DetailsTab node={data.jcr?.nodeById ?? null} locale={locale} language={language}/>}
                </TabBody>
            </div>
            <div
                id={PANEL_ID(TAB_USAGES)}
                className="task-board__preview-tabpanel"
                role="tabpanel"
                aria-labelledby={TAB_ID(TAB_USAGES)}
                hidden={activeTab !== TAB_USAGES}
            >
                <TabBody resource={usages} errorTitle={errorTitle}>
                    {data => (
                        <UsagesTab
                            usages={(data.jcr?.nodeById?.usages.nodes ?? []).map(entry => entry.node)}
                            totalCount={data.jcr?.nodeById?.usages.pageInfo.totalCount ?? 0}
                        />
                    )}
                </TabBody>
            </div>
            <div
                id={PANEL_ID(TAB_HISTORY)}
                className="task-board__preview-tabpanel"
                role="tabpanel"
                aria-labelledby={TAB_ID(TAB_HISTORY)}
                hidden={activeTab !== TAB_HISTORY}
            >
                <TabBody resource={history} errorTitle={errorTitle}>
                    {data => <HistoryTab data={data} locale={locale}/>}
                </TabBody>
            </div>
        </Paper>
    );
}
