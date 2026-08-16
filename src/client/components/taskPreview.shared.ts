/**
 * The queries and result types behind the task board's preview side panel (#61) -- one per tab
 * beyond the iframe: Details, Usages and History.
 *
 * Same contract as taskBoard.shared.ts, and here for the same two reasons: nothing in this file
 * imports Moonstone (or anything else at runtime), so it stays importable from both of this
 * module's bundles; and keeping the query strings out of the component leaves that file about
 * rendering.
 *
 * <h3>Everything here reads the DXM provider's own schema, not this module's</h3>
 * The Details and Usages tabs go through core's `jcr { nodeById }`, which is what jContent's own
 * side panel reads too (its ContentDetails/ContentUsages tabs -- see the investigation note in
 * TaskPreviewPanel.tsx). Only the History tab uses this module's own `workflowActivity` query.
 * Each field below was verified against a live 8.2.3 provider (introspection + a real query on the
 * bench, 2026-08-16) rather than taken from the schema jContent tracks, which is a different
 * build's and has neither `history` nor `renderUrl`'s arguments.
 */

// ---------------------------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------------------------

// Language-independent on purpose for the creation fields (jcr:created/jcr:createdBy are shared
// properties, not translated ones) and language-scoped for the modification ones, which are
// written per translation node -- the same split jcontent's usages query makes.
const NODE_DETAILS_SELECTION = /* GraphQL */ `
    uuid
    path
    displayName(language: $language)
    primaryNodeType {
        name
        displayName(language: $language)
    }
    created: property(name: "jcr:created") {
        value
    }
    createdBy: property(name: "jcr:createdBy") {
        value
    }
    lastModified: property(name: "jcr:lastModified", language: $language) {
        value
    }
    lastModifiedBy: property(name: "jcr:lastModifiedBy", language: $language) {
        value
    }
`;

// Split out so the panel can drop it and retry: aggregatedPublicationInfo is a DXM-provider field,
// not a JCR one, and an installation whose provider predates it would fail the WHOLE query on a
// validation error rather than just omitting this block. Everything else in the Details tab is
// worth showing even there.
const PUBLICATION_SELECTION = /* GraphQL */ `
    aggregatedPublicationInfo(language: $language) {
        publicationStatus
        existsInLive
        locked
        workInProgress
    }
`;

function detailsQuery(withPublicationInfo: boolean): string {
    return /* GraphQL */ `
        query TaskPreviewDetails($uuid: String!, $language: String!) {
            jcr(workspace: EDIT) {
                nodeById(uuid: $uuid) {
                    ${NODE_DETAILS_SELECTION}
                    ${withPublicationInfo ? PUBLICATION_SELECTION : ''}
                }
            }
        }
    `;
}

export const PREVIEW_DETAILS_QUERY = detailsQuery(true);
export const PREVIEW_DETAILS_QUERY_WITHOUT_PUBLICATION = detailsQuery(false);

export type PreviewPropertyValue = {value: string | null} | null;

export type PreviewPublicationInfo = {
    // One of the PublicationStatus enum's values (PUBLISHED, MODIFIED, NOT_PUBLISHED, ...). Kept a
    // plain string rather than a union, for the same reason viewerRole is one in taskBoard.shared:
    // a value added by a later provider must render as itself, not fail to type-check.
    publicationStatus: string;
    existsInLive: boolean | null;
    locked: boolean | null;
    workInProgress: boolean | null;
};

export type PreviewDetailsNode = {
    uuid: string;
    path: string;
    displayName: string | null;
    primaryNodeType: {name: string; displayName: string | null} | null;
    created: PreviewPropertyValue;
    createdBy: PreviewPropertyValue;
    lastModified: PreviewPropertyValue;
    lastModifiedBy: PreviewPropertyValue;
    // Absent (not null) when the panel had to fall back to the reduced query above.
    aggregatedPublicationInfo?: PreviewPublicationInfo | null;
};

export type PreviewDetailsResult = {
    jcr: {nodeById: PreviewDetailsNode | null} | null;
};

// ---------------------------------------------------------------------------------------------
// Usages
// ---------------------------------------------------------------------------------------------

/**
 * The nodes that REFERENCE the previewed content -- `usages`, the provider's weak-reference index,
 * which groups the referring properties by referring node (`references` is the same data ungrouped,
 * one row per property, so the same node appears once per language it links from).
 *
 * <p>The workflow tasks are filtered out server-side, exactly as jContent's own usages query does
 * it: `isNodeType(..., multi: NONE)` is "is none of these types", so `notATask` is true for
 * everything that ISN'T a jnt:workflowTask, and the field filter keeps only those. Without it the
 * first row of this tab would be the very task the panel was opened from (its `targetNode`
 * property is a reference like any other), which tells the reviewer nothing.
 *
 * <p>`renderUrl` rather than `url`: a plain GraphQL POST opens a session with no locale, and core's
 * URL builder then writes a literal "null" where the language segment goes (the same trap
 * GqlTaskBoard#getTargetNode documents and works around server-side). renderUrl takes the language
 * explicitly. `findDisplayable: true` walks up to the nearest renderable page, so a row that is a
 * content item inside a page links to that page rather than to a URL that renders a fragment.
 */
// One screenful and then some: this tab is a summary a reviewer glances at before deciding, not a
// usages report (jContent has one of those). totalCount comes back unfiltered by the limit, so the
// panel can still say when there are more.
export const USAGES_LIMIT = 100;

export const PREVIEW_USAGES_QUERY = /* GraphQL */ `
    query TaskPreviewUsages($uuid: String!, $language: String!) {
        jcr(workspace: EDIT) {
            nodeById(uuid: $uuid) {
                uuid
                usages(limit: ${USAGES_LIMIT}, fieldFilter: {filters: {fieldName: "node.notATask", value: "true"}}) {
                    pageInfo {
                        totalCount
                    }
                    nodes {
                        node {
                            uuid
                            path
                            notATask: isNodeType(type: {types: ["jnt:workflowTask"], multi: NONE})
                            displayName(language: $language)
                            renderUrl(workspace: EDIT, language: $language, findDisplayable: true)
                            primaryNodeType {
                                name
                                displayName(language: $language)
                            }
                        }
                    }
                }
            }
        }
    }
`;

export type PreviewUsageNode = {
    uuid: string;
    path: string;
    displayName: string | null;
    renderUrl: string | null;
    primaryNodeType: {name: string; displayName: string | null} | null;
};

export type PreviewUsagesResult = {
    jcr: {
        nodeById: {
            usages: {
                pageInfo: {totalCount: number};
                nodes: Array<{node: PreviewUsageNode}>;
            };
        } | null;
    } | null;
};

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

// This module's own query (WorkflowActivityQueryExtensions), asked about the previewed node
// ITSELF -- see the includeSelf argument's description there for why that flag exists.
//
// `processes` is what makes this tab say anything at all about a request that was just raised:
// activeTasks only carries steps with a due date and history only carries steps that have ended,
// so a running 1-step publication appears in neither.
const WORKFLOW_ACTIVITY_SELECTION = /* GraphQL */ `
    workflowActivity(path: $path, includeSelf: true) {
        processes {
            name
            startUser
            startTime
            endTime
            isCompleted
        }
        activeTasks {
            label
            name
            user
            dueDate
        }
        history {
            label
            name
            user
            endTime
        }
    }
`;

// The provider's content-history feed (GqlContentHistory), the same one jContent's History tab
// renders. Split out and droppable for the same reason the publication block above is: it is a
// provider extension rather than part of the JCR schema proper -- present on 8.2.3, but a query
// that names an undefined field fails ENTIRELY, and the workflow half of this tab is the half
// this module actually owns.
const CONTENT_HISTORY_SELECTION = /* GraphQL */ `
    jcr(workspace: EDIT) {
        nodeById(uuid: $uuid) {
            uuid
            history {
                count(withLanguageNodes: true)
                entries(withLanguageNodes: true, offset: 0, limit: 10) {
                    id
                    date
                    action
                    language
                    propertyNameDisplay(language: $language)
                    userKey
                    user {
                        displayName
                    }
                }
            }
        }
    }
`;

function historyQuery(withContentHistory: boolean): string {
    // The variable LIST shrinks with the selection, it isn't shared between the two forms:
    // NoUnusedVariables is a standard GraphQL validation rule (graphql-java enforces it), so a
    // fallback document that still declared $uuid/$language after dropping the only block that
    // reads them would fail validation exactly as the query it is the fallback FOR did -- turning
    // a graceful degradation into a second error. Passing more variable VALUES than a document
    // declares is fine, and is what lets both forms be called with one variables object.
    const variables = withContentHistory
        ? '$path: String!, $uuid: String!, $language: String!'
        : '$path: String!';

    return /* GraphQL */ `
        query TaskPreviewHistory(${variables}) {
            ${WORKFLOW_ACTIVITY_SELECTION}
            ${withContentHistory ? CONTENT_HISTORY_SELECTION : ''}
        }
    `;
}

export const PREVIEW_HISTORY_QUERY = historyQuery(true);
export const PREVIEW_HISTORY_QUERY_WITHOUT_CONTENT_HISTORY = historyQuery(false);

export type PreviewWorkflowProcess = {
    name: string | null;
    startUser: string | null;
    startTime: string | null;
    endTime: string | null;
    isCompleted: boolean;
};

export type PreviewWorkflowEntry = {
    label: string | null;
    name: string | null;
    user: string | null;
    dueDate?: string | null;
    endTime?: string | null;
};

export type PreviewContentHistoryEntry = {
    id: string;
    date: string | null;
    action: string | null;
    language: string | null;
    propertyNameDisplay: string | null;
    userKey: string | null;
    user: {displayName: string | null} | null;
};

export type PreviewHistoryResult = {
    workflowActivity: {
        processes: PreviewWorkflowProcess[];
        activeTasks: PreviewWorkflowEntry[];
        history: PreviewWorkflowEntry[];
    };
    // Absent when the panel had to fall back to the workflow-only query above.
    jcr?: {
        nodeById: {
            history: {count: number; entries: PreviewContentHistoryEntry[]} | null;
        } | null;
    } | null;
};

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * The content language a rendered Jahia URL is for: the segment after the workspace in
 * "/cms/render/<workspace>/<language>/<path>.html". This is what the preview iframe is actually
 * showing, which is the honest answer to the Details tab's "Language" row -- as opposed to the
 * viewer's UI language, which is only usually the same thing.
 *
 * Returns null for anything that isn't a render URL (a vanity URL, a file, an already-absolute
 * link), so callers fall back to the UI locale rather than to a wrong language.
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
 * A BCP-47-ish UI locale ("fr", "fr-FR", "fr_FR") reduced to the bare language code the DXM
 * provider's `language:` arguments expect. Jahia stores translations per LANGUAGE (and, where a
 * site declares them, per language-plus-region as its own language code), so passing the full tag
 * through would ask for a translation node that usually doesn't exist.
 */
export function toContentLanguage(locale: string): string {
    const separator = locale.search(/[-_]/);
    return separator === -1 ? locale : locale.slice(0, separator);
}
