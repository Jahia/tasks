/**
 * Which CONTENT LANGUAGE the board's preview side panel opens in.
 *
 * Same contract as taskBoard.shared.ts, and here for the same two reasons: nothing in this file
 * imports Moonstone (or anything else at runtime), so it stays importable from both of this
 * module's bundles; and keeping this decision out of the component leaves that file about
 * rendering. Being import-free is also what lets the chain below be exercised directly --
 * tests/cypress/e2e/task-preview-language.cy.ts, the same way the waiting-duration functions are.
 *
 * <h3>Why this is a decision at all</h3>
 * jContent's content side panel takes ONE language and shows that translation of the node
 * throughout -- the rendered preview, the localized properties on Details, the modification entries
 * on History. A publication review, meanwhile, is raised FOR a language: "publish the Spanish
 * version of /sites/luxe/home/sell" is a different request from the French one, and the reviewer
 * opening this panel is deciding about that one. Opening it in the viewer's UI language would show
 * them a translation nobody asked them to approve.
 *
 * (Everything else this file used to hold -- the Details/Usages/History queries and their result
 * types -- went away with the tabs that read them: the panel now mounts jContent's own, which
 * fetches its own data. See the header of ./TaskPreviewPanel.)
 */

// The node type the workflow engine creates for a workflow step, as GqlTaskBoard#getTaskType
// reports it (the primary node type name). A plain jnt:task is a to-do somebody wrote by hand and
// has no workflow, hence no language of its own.
const WORKFLOW_TASK_TYPE = 'jnt:workflowTask';

/**
 * The workflow's own locale, off the task's stored `description`.
 *
 * <p>jnt:workflowTask carries NO locale property -- verified by listing every property of every
 * such node on a live 8.2.3 (2026-08-16): the type stores taskId/provider/state/targetNode/
 * candidates/taskName/taskBundle and nothing about language. What it does carry is the summary the
 * engine wrote when it created the task, which BEGINS with that workflow's language code:
 *
 * <pre>fr - One step publication started by root on 8/15/26 - 2 content items involved</pre>
 *
 * <p>and which is genuinely the workflow's and not the reader's -- three tasks fetched in one
 * request came back "fr", "en" and "es". This module already treats that string as a known shape:
 * GqlTaskBoard#getWorkflowSummary rebuilds it field for field, in the REQUEST's locale, which is
 * exactly why the summary cannot be used here and the stored description can.
 *
 * <p>Null rather than a guess whenever anything about the value is unlike that shape, and never
 * even looked at for a plain jnt:task -- whose description is free text a user typed, and could
 * begin with any two words at all.
 */
const WORKFLOW_DESCRIPTION_LANGUAGE = /^([a-z]{2,3}) - /;

export function workflowLanguage(taskType: string | null, description: string | null): string | null {
    if (taskType !== WORKFLOW_TASK_TYPE || !description) {
        return null;
    }

    const matched = WORKFLOW_DESCRIPTION_LANGUAGE.exec(description);
    return matched ? matched[1] : null;
}

/**
 * The content language a rendered Jahia URL is for: the segment after the workspace in
 * "/cms/render/<workspace>/<language>/<path>.html".
 *
 * Returns null for anything that isn't a render URL (a vanity URL, a file, an already-absolute
 * link), so callers fall back rather than to a wrong language.
 */
const RENDER_URL_LANGUAGE = /\/cms\/(?:render|edit|frame)\/[^/]+\/([a-zA-Z]{2,3}(?:[_-][a-zA-Z]{2,4})?)\//;

export function languageOfRenderUrl(url: string | null | undefined): string | null {
    if (!url) {
        return null;
    }

    const matched = RENDER_URL_LANGUAGE.exec(url);
    return matched ? matched[1] : null;
}

/**
 * A BCP-47-ish UI locale ("fr", "fr-FR", "fr_FR") reduced to the bare language code Jahia's
 * `language:` arguments expect. Jahia stores translations per LANGUAGE (and, where a site declares
 * them, per language-plus-region as its own language code), so passing the full tag through would
 * ask for a translation node that usually doesn't exist.
 */
export function toContentLanguage(locale: string): string {
    const separator = locale.search(/[-_]/);
    return separator === -1 ? locale : locale.slice(0, separator);
}

/**
 * The language the preview panel opens in, most authoritative first:
 *
 * <ol>
 *   <li>the workflow's own language, where this row is a workflow task that recorded one -- the
 *       language the review was actually raised for (see workflowLanguage above);</li>
 *   <li>the language segment of the target's rendered URL. Built server-side through a session
 *       that has a locale (GqlTaskBoard#getTargetNode), i.e. the REQUEST's -- so this is not the
 *       task's language, it is the viewer's, arrived at by a route that is right whenever core's
 *       URL builder is;</li>
 *   <li>the viewer's UI language, reduced to a bare language code -- the answer for a plain
 *       jnt:task, which is about content but was never raised for a translation.</li>
 * </ol>
 *
 * There is deliberately no validation against the site's declared languages: that would be another
 * round trip, and jContent's panel already degrades on its own to a node with no such translation
 * (an empty preview, empty localized properties) rather than failing.
 */
export type PreviewLanguageSource = {
    taskType: string | null;
    description: string | null;
    url: string;
};

export function resolvePreviewLanguage(source: PreviewLanguageSource, uiLocale: string): string {
    return workflowLanguage(source.taskType, source.description)
        ?? languageOfRenderUrl(source.url)
        ?? toContentLanguage(uiLocale);
}
