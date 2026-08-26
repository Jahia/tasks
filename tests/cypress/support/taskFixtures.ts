import {addNode, createGroup, addUserToGroup, grantRoles, startWorkflow} from '@jahia/cypress';
import {PAGE_SIZE, PUBLICATION_WORKFLOW, REVIEWER_ROLE} from './constants';

// Fixtures shared by more than one spec. Kept out of cypress/support/e2e.ts (which registers
// commands and owns run-level cleanup) per the jahia-cypress-testing skill: this file is task-board
// business -- jnt:task shapes and the publication-review workflow -- and belongs to this module, not
// to a Jahia primitive that would go upstream to @jahia/cypress.

export type AddNodeResponse = {data: {jcr: {addNode: {uuid: string}}}};

export type TaskBoardEdge = {node: TaskBoardRow};

export type TaskBoardRow = {
    id: string;
    title: string | null;
    creator: string | null;
    createdDate: string | null;
    owner: string | null;
    assigneeDisplayName: string | null;
    state: string | null;
    dueDate: string | null;
    priority: string | null;
    taskType: string;
    viewerRole: string;
    isAssignableToMe: boolean;
    candidateDisplayNames: string[];
    possibleOutcomes: string[];
    possibleOutcomeDetails: Array<{name: string; displayLabel: string}>;
    // The engine's own one-line summary, stored when it created the task. Its leading language code
    // is where the board reads the language its preview panel opens in -- see
    // resolvePreviewLanguage in src/client/components/taskPreview.shared.ts.
    description: string | null;
    workflowSummary: string | null;
    simpleWorkflowTaskData: {id: string; comment: string | null} | null;
    // path is what the board's preview side panel hands jContent's own content side panel (#61,
    // jcontent#2700) -- see PreviewTarget in src/client/components/TaskPreviewPanel.tsx.
    targetNode: {url: string; path: string; property: {value: string} | null} | null;
};

export type TaskBoardPage = {
    pageInfo: {hasNextPage: boolean; endCursor: string | null; totalCount: number};
    edges: TaskBoardEdge[];
};

/**
 * Creates a jnt:task under `container` and yields its JCR uuid: every mutation in this module
 * resolves its `id` argument through session.getNodeByIdentifier(id) server-side, which (per JCR
 * spec) takes an identifier, never a path. The response shape is @jahia/cypress's own addNode
 * fixture (data.jcr.addNode.uuid).
 */
export function addTask(
    container: string,
    name: string,
    properties: Array<{name: string; value?: string; values?: string[]; language?: string}> = []
): Cypress.Chainable<string> {
    return addNode({
        parentPathOrId: container,
        primaryNodeType: 'jnt:task',
        name,
        properties: [{name: 'jcr:title', value: name, language: 'en'}, ...properties]
    }).then((response: AddNodeResponse) => response.data.jcr.addNode.uuid);
}

/** One taskBoard page, as the current apollo identity sees it. */
export function taskBoard(variables: Record<string, unknown> = {}): Cypress.Chainable<TaskBoardPage> {
    return cy.apollo({
        queryFile: 'graphql/taskBoard.query.graphql',
        fetchPolicy: 'no-cache',
        variables: {first: PAGE_SIZE, ...variables}
    }).then(({data}) => data.taskBoard as TaskBoardPage);
}

export function titlesOf(page: TaskBoardPage): Array<string | null> {
    return page.edges.map(edge => edge.node.title);
}

export function rowById(page: TaskBoardPage, id: string): TaskBoardRow | undefined {
    return page.edges.find(edge => edge.node.id === id)?.node;
}

/**
 * A group that really holds the review role on `siteKey`, which is the ONLY way to get a group
 * registered as a workflow-task candidate -- see startPublicationReview below for why.
 *
 * The group is created ON THE SITE, not globally: jcr.mutateNode.grantRoles resolves a GROUP
 * principal through the target node's own site, so granting a role on /sites/<key> to a group that
 * lives at /groups/<name> fails outright with "Invalid user" (observed live, 2026-08-16). A site
 * group at /sites/<key>/groups/<name> is also the shape the engine writes into `candidates`.
 */
export function createReviewerGroup(siteKey: string, groupName: string, memberNames: string[]): void {
    createGroup(groupName, false, siteKey);
    memberNames.forEach(member => addUserToGroup(member, groupName, siteKey));
    grantRoles(`/sites/${siteKey}`, [REVIEWER_ROLE], groupName, 'GROUP');
}

/** Where the engine writes a site group's candidacy: the group node's own JCR path. */
export function siteGroupPath(siteKey: string, groupName: string): string {
    return `/sites/${siteKey}/groups/${groupName}`;
}

/**
 * Starts the real publication workflow on `nodePath` and yields the jnt:workflowTask the engine
 * created for it.
 *
 * <p><b>Why this, and not a jnt:workflowTask with a hand-written `candidates` property.</b> Writing
 * that property through the JCR does produce a node the board's own query is happy with -- and a
 * task the workflow engine has never heard of: jBPM keeps its own potential-owner assignment, and
 * denies the resulting Start/complete, so the JCR node and the process disagree ("split-brain",
 * observed on this module before this suite existed). Candidacy therefore has to be created the way
 * production creates it: the principals are resolved BY THE ENGINE, from the review role held on
 * the content, at the moment the process starts. Which is why every caller of this helper grants
 * its group the role FIRST (createReviewerGroup) and starts the workflow SECOND -- reversing the
 * two produces a task whose candidates simply do not include the group.
 *
 * <p>The task is looked up by its target's name rather than by any id the mutation returns
 * (startWorkflow returns a bare boolean), and polled for: the engine creates the task node
 * asynchronously, after the mutation has already answered.
 */
export function startPublicationReview(nodePath: string): Cypress.Chainable<TaskBoardRow> {
    const nodeName = nodePath.slice(nodePath.lastIndexOf('/') + 1);
    startWorkflow(nodePath, PUBLICATION_WORKFLOW, 'en');

    let created: TaskBoardRow | undefined;
    cy.waitUntil(
        () => taskBoard({search: nodeName, scope: 'all'}).then(page => {
            created = page.edges.map(edge => edge.node).find(node => node.taskType === 'jnt:workflowTask');
            return Boolean(created);
        }),
        {
            errorMsg: `No jnt:workflowTask was created for ${nodePath} -- did the workflow really start?`,
            timeout: 30000,
            interval: 1000
        }
    );

    return cy.wrap(null, {log: false}).then(() => created as TaskBoardRow);
}

/**
 * The error messages a mutation came back with. The @jahia/cypress apollo command catches the
 * rejection and yields the ApolloError itself instead of failing the test, so a spec can assert on
 * the message -- which for this module is a user-facing string: TaskBoard.client.tsx renders it
 * verbatim in the board's danger banner.
 */
export function errorMessagesOf(response: unknown): string {
    const error = response as {graphQLErrors?: Array<{message: string}>; message?: string};
    const fromGraphQL = (error.graphQLErrors ?? []).map(entry => entry.message);
    return fromGraphQL.length > 0 ? fromGraphQL.join(' | ') : (error.message ?? '');
}

/**
 * The task node's RAW candidates property -- the values the engine itself wrote, as opposed to the
 * board's own resolved candidateDisplayNames. Read before asserting any candidate-visibility
 * expectation, so a failing visibility test can never be mistaken for a failing fixture.
 */
export function taskCandidates(taskId: string): Cypress.Chainable<string[]> {
    return cy.apollo({
        queryFile: 'graphql/taskCandidates.query.graphql',
        fetchPolicy: 'no-cache',
        variables: {id: taskId}
    }).then(({data}) => (data.jcr.nodeById.property?.values ?? []) as string[]);
}

/**
 * Whether `path` has actually been published -- i.e. whether the workflow ENGINE acted on the
 * decision, not merely whether this module wrote "finished" onto the task node. The two can come
 * apart (that is the whole failure mode this suite exists to rule out), and only this one is
 * evidence the engine accepted the completion.
 */
export function publicationStatus(path: string): Cypress.Chainable<string> {
    return cy.apollo({
        queryFile: 'graphql/publicationStatus.query.graphql',
        fetchPolicy: 'no-cache',
        variables: {path}
    }).then(({data}) => data.jcr.nodeByPath.aggregatedPublicationInfo.publicationStatus as string);
}
