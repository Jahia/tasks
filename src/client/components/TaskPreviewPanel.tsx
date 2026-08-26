import {useEffect, useRef, useState} from 'react';
import {Button, Close, Loader, Paper, Typography} from '@jahia/moonstone';
import {useTasksTranslation} from '../lib/i18n';
// The board's stylesheet, not one of this panel's own: the panel is a part of the board (its rules
// have always lived in that file, beside the row-action styles that reveal the button opening it)
// and it shares `meta` with the board's captions. Importing the same module from both is how a CSS
// module is shared -- Vite emits one stylesheet and both get the same name map. Until #69 this
// component needed no import at all, because the file was a plain global stylesheet TaskBoard
// pulled in for its side effect.
import styles from './TaskBoard.client.module.css';

/**
 * The task board's "Preview" side panel (#61), showing jContent's OWN content side panel
 * (jcontent#2700) rather than a rebuilt copy of it.
 *
 * <h3>What changed, and why the rebuild is gone</h3>
 * #61 replicated the SHAPE of jContent's panel -- a tab strip over Preview / Details / Usages /
 * History -- on plain Moonstone, with queries of this module's own, because that component was not
 * reachable: jcontent federated exactly three modules ('./init', './JContent/actions' and '.'), its
 * SidePanel was in none of them, and its tabs read their data from a React context only jContent's
 * own routes provided.
 *
 * jContent now exposes the panel itself as a fourth federated module, './ContentSidePanel'
 * (jcontent#2700), which fabricates everything the tabs read -- the SidePanelContext, the Content
 * Editor config context, and, when the host tree lacks them, an Apollo client, a redux store and a
 * notification provider. So the replica is deleted and the real thing is mounted in its place: one
 * panel implementation for the whole product, which cannot drift from what a reviewer sees when
 * they open the same content in jContent, and no second set of queries to keep true.
 *
 * <h3>Shell vs. body</h3>
 * The SHELL stays this module's: the Paper, its fixed position and z-index contract with the row
 * action menus (below Moonstone's Menu, so a kebab still opens on top of an open panel -- see the
 * CSS), the header naming both the content and the task it is being reviewed for, the close button
 * and the document-level Escape, and the single instance that SWAPS its target rather than stacking
 * a second panel. jContent's panel deliberately ships none of those outside its own layout (its
 * close and full-screen controls are route-bound and are hidden when the callbacks are absent), so
 * nothing here is a duplicate of something it provides.
 *
 * The BODY is jContent's, mounted into a div of ours.
 *
 * <h3>Standalone degradation</h3>
 * jContent is a separate module and can simply be absent -- including on this suite's own bare e2e
 * instance, and on any older release, whose remoteEntry has no './ContentSidePanel' entry at all
 * (`container.get()` then REJECTS rather than returning undefined). Either way the panel falls back
 * to the plain preview iframe it showed before #61, with a caption saying what is missing and why.
 * The board stays useful on an installation that has no jContent, which is the whole reason this
 * module does not simply link out to it.
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
    // The rendered page, used by the fallback iframe only (jContent's panel renders its own
    // preview from the path below).
    url: string;
    // The target node's JCR path -- what './ContentSidePanel' resolves. Its `uuid` prop would save
    // the panel one lookup, but `path` is the shape jcontent#2700 documents first and the one
    // verified against the deployed remote, and the extra query is a single node read.
    path: string;
    // The CONTENT language the panel opens in -- the task's own where it is knowable, the viewer's
    // otherwise. Resolved by the board, see resolvePreviewLanguage in ./taskPreview.shared.
    language: string;
};

type TaskPreviewPanelProps = {
    target: PreviewTarget;
    onClose: () => void;
};

// ---------------------------------------------------------------------------------------------
// The jContent remote
// ---------------------------------------------------------------------------------------------

// The federated module jContent exposes the panel as, and the props it takes (jcontent#2700).
const CONTENT_SIDE_PANEL_MODULE = './ContentSidePanel';

type ContentSidePanelProps = {
    path: string;
    language: string;
    // Which workspace the PREVIEW renders from; details/usages/history always read edit. Passed
    // explicitly even though 'edit' is the default: a reviewer is deciding about the STAGED
    // content, and live would show them what they are being asked to replace.
    workspace: 'edit' | 'live';
    initialTab: 'preview' | 'details' | 'usages' | 'history';
};

/** Mounts the panel into `element` and returns the callback that unmounts it. */
type MountContentSidePanel = (element: HTMLElement, props: ContentSidePanelProps) => () => void;

// One federation container, as the app shell publishes it. `window.appShell.remotes` is a map of
// the containers the shell has already init()'d against its own share scope at boot (appshell.js:
// `Object.values(window.appShell.remotes || {}).map(e => e.init(...))`), so `get` here is called on
// a container that is ready -- this module neither initializes it nor needs a build-time `remotes`
// entry for it.
type FederationContainer = {
    get: (module: string) => Promise<() => unknown>;
};

type ShellGlobals = {
    appShell?: {remotes?: Record<string, FederationContainer | undefined>};
};

/**
 * jContent's mount function, or null when this installation cannot supply it.
 *
 * Three distinct absences, all of them normal, all of them the same answer here:
 * jContent isn't installed (no container); it is installed but predates jcontent#2700 (the
 * container has no such module and `get` rejects); or the module loaded but isn't what we expect
 * (a future rename). Nothing is logged for the first two -- they are configurations, not faults.
 */
async function loadContentSidePanel(): Promise<MountContentSidePanel | null> {
    const container = (globalThis as unknown as ShellGlobals).appShell?.remotes?.jcontent;
    if (typeof container?.get !== 'function') {
        return null;
    }

    try {
        const factory = await container.get(CONTENT_SIDE_PANEL_MODULE);
        const module = factory() as {mountContentSidePanel?: MountContentSidePanel};
        return typeof module?.mountContentSidePanel === 'function' ? module.mountContentSidePanel : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------
// The panel body
// ---------------------------------------------------------------------------------------------

type BodyStatus = 'loading' | 'mounted' | 'standalone';

type PreviewBodyProps = {
    path: string;
    language: string;
    url: string;
    frameTitle: string;
};

/**
 * jContent's panel, mounted into a div this component owns -- or the plain iframe, when jContent
 * cannot supply one.
 *
 * <h3>Mounted, not rendered as a child</h3>
 * `mountContentSidePanel` creates its OWN React root inside the host div. That is deliberate on
 * jContent's side (the module is documented for hosts that are not part of its React tree) and is
 * what lets this module consume it without sharing jContent's dependency stack: nothing here
 * imports @apollo/client, redux or @jahia/design-system-kit, and this module's federation share
 * list (see package.json's "dependencies" note) does not grow by a single entry.
 *
 * <h3>Lifecycle</h3>
 * The whole component is KEYED by the target upstream, so a row swap unmounts this and mounts a
 * fresh one: the host div is new, its status starts at 'loading' again, and no state can leak from
 * the node previously shown into the one now shown. The effect below therefore only ever runs once
 * per instance, and its cleanup is the panel's only exit.
 *
 * Both halves of that cleanup matter:
 * <ul>
 *   <li>`cancelled` covers the load still being in flight when the panel closes -- and covers
 *       React 18's StrictMode, which mounts, unmounts and re-mounts every effect: the first run's
 *       promise resolves into a cleaned-up closure and must not mount anything (it has nothing to
 *       unmount either, which is exactly why the flag has to be checked BEFORE mounting rather
 *       than only after).</li>
 *   <li>the unmount is deferred to a microtask: React refuses to synchronously unmount one root
 *       while it is already rendering another, and this cleanup runs inside the host tree's own
 *       commit. The microtask still lands before any remount (a new instance's mount awaits at
 *       least one promise tick), so the two can never overlap on a container.</li>
 * </ul>
 */
function PreviewBody({path, language, url, frameTitle}: Readonly<PreviewBodyProps>) {
    const {t} = useTasksTranslation();
    const hostRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<BodyStatus>('loading');

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return undefined;
        }

        let cancelled = false;
        let unmount: (() => void) | null = null;

        loadContentSidePanel().then(mount => {
            if (cancelled) {
                return;
            }

            if (!mount) {
                setStatus('standalone');
                return;
            }

            unmount = mount(host, {path, language, workspace: 'edit', initialTab: 'preview'});
            setStatus('mounted');
        });

        return () => {
            cancelled = true;
            const dispose = unmount;
            unmount = null;
            if (dispose) {
                queueMicrotask(dispose);
            }
        };
    }, [path, language]);

    if (status === 'standalone') {
        return (
            <div className={styles.previewBody}>
                {/* Above the frame, not below it: the frame takes the rest of the panel, and a
                    caption under it would sit off-screen on a short viewport -- which is where a
                    sentence explaining why there are no tabs is least use. */}
                <Typography component="p" variant="caption" weight="light" className={styles.previewCaption} data-sel-role="task-board-preview-caption">
                    {t(
                        'board.preview.standalone',
                        'Only the page preview is available here: details, usages and history come from jContent, which is not installed on this server.'
                    )}
                </Typography>
                <iframe className={styles.previewFrame} src={url} title={frameTitle} data-sel-role="task-board-preview-frame"/>
            </div>
        );
    }

    return (
        <div className={styles.previewBody}>
            {status === 'loading' && (
                <div className={styles.previewLoader}>
                    <Loader/>
                </div>
            )}
            {/* Never given React children: everything inside it belongs to jContent's own root, and
                React must have no opinion about that subtree. */}
            <div ref={hostRef} className={styles.previewHost}/>
        </div>
    );
}

// ---------------------------------------------------------------------------------------------

export default function TaskPreviewPanel({target, onClose}: Readonly<TaskPreviewPanelProps>) {
    const {t} = useTasksTranslation();
    const label = t('board.preview.label', 'Content preview');
    const closeLabel = t('board.preview.close', 'Close preview');

    // Listened for on the document, not on the panel: this panel is deliberately not modal (the
    // board behind it stays scrollable and clickable, which is the point of previewing beside the
    // worklist), so by the time the reviewer wants it gone their focus is usually back in the
    // table -- or inside jContent's panel, which is a separate React root and would otherwise
    // swallow the key entirely. A row menu's own Escape handler stops the event before it reaches
    // here, so one Escape never closes both.
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    return (
        <Paper
            hasPadding={false}
            className={styles.preview}
            data-sel-role="task-board-preview"
            role="dialog"
            // Deliberately no aria-modal: nothing behind this panel is inert, and claiming
            // otherwise would tell a screen reader the rest of the board is unavailable.
            aria-label={label}
        >
            <div className={styles.previewHeader}>
                <div className={styles.previewTitles}>
                    <Typography component="h2" variant="subheading" weight="semiBold">{target.title}</Typography>
                    <Typography component="p" variant="caption" weight="light" className={styles.meta}>
                        {t('board.preview.task', 'Task: {{title}}', {title: target.taskTitle})}
                    </Typography>
                </div>
                <Button
                    // The panel opens from a menu item that unmounts with the menu, so focus would
                    // otherwise be left on a detached node: it is moved onto the one control that
                    // dismisses the thing that just appeared. Deliberately not into the panel body
                    // -- that is another React root, mounted a tick later, and there is nothing
                    // there to focus at the moment this renders.
                    autoFocus
                    icon={<Close/>}
                    variant="ghost"
                    aria-label={closeLabel}
                    title={closeLabel}
                    onClick={onClose}
                />
            </div>
            {/* Keyed by what is being shown, so picking Preview on another row (or the same node in
                another language) tears the mounted panel down and mounts a new one, rather than
                asking a live React root of jContent's to change the node under itself. */}
            <PreviewBody
                key={`${target.path}|${target.language}`}
                path={target.path}
                language={target.language}
                url={target.url}
                frameTitle={label}
            />
        </Paper>
    );
}
