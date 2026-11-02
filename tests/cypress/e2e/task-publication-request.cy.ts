import {createSite, deleteSite, addNode, abortAllWorkflows} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';

// Covers GqlTaskBoard#getRequestItems / #getRequestItemCount and GqlTaskTarget#getPreviewUrl --
// the fields that let a card show every item of a publication request rather than the single one
// the task node records.
//
// The request deliberately mixes a PAGE with content in a CONTENT FOLDER, because previewUrl
// answers differently for the two and both answers matter: a page previews as itself, while
// content no page contains has nothing to render and answers null. A request of three pages would
// pass while leaving the null branch untested.
const CONTENT_PARENT = `/sites/${TEST_SITE_KEY}/contents/e2e-publication-request`;
const HOME_PATH = `/sites/${TEST_SITE_KEY}/home`;
const CONTENT_ITEMS = ['first-item', 'second-item'];
const REQUEST_SIZE = CONTENT_ITEMS.length + 1;

type RequestItem = {
    uuid: string;
    displayName: string;
    typeName: string;
    inPage: boolean;
    locationPath: string;
    previewUrl: string | null;
};

type BoardNode = {
    id: string;
    taskType: string | null;
    title: string | null;
    workflowSummary: string | null;
    requestItemCount: number | null;
    requestItems: RequestItem[];
    targets: Array<{uuid: string; displayName: string}>;
};

// Takes the assertion as a callback rather than returning the task: cy.apollo's then() is typed
// to a void-returning callback, so a helper that answered the task itself would not compile.
const withWorkflowTask = (limit: number | null, assertOn: (task: BoardNode) => void) => {
    cy.apollo({
        queryFile: 'graphql/taskBoardRequestItems.query.graphql',
        variables: {first: 50, limit}
    }).then(({data}) => {
        const tasks = (data.taskBoard.edges as Array<{node: BoardNode}>)
            .map(edge => edge.node)
            .filter(node => node.taskType === 'jnt:workflowTask');
        expect(tasks, 'exactly one workflow task on the board').to.have.length(1);
        assertOn(tasks[0]);
    });
};

describe('Publication request items on a workflow task', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
        addNode({
            parentPathOrId: `/sites/${TEST_SITE_KEY}/contents`,
            primaryNodeType: 'jnt:contentFolder',
            name: 'e2e-publication-request'
        });
        CONTENT_ITEMS.forEach(name => {
            addNode({parentPathOrId: CONTENT_PARENT, primaryNodeType: 'jnt:text', name});
        });

        const paths = [HOME_PATH, ...CONTENT_ITEMS.map(name => `${CONTENT_PARENT}/${name}`)];
        cy.executeGroovy('groovy/startPublicationRequest.groovy', {PATHS: paths.join(',')});

        // The JCR task is written by the jBPM task-lifecycle listener as the process starts, so it
        // is normally there by the time startProcess returns -- but that is the engine's timing,
        // not something this suite controls, so the board is polled rather than assumed.
        cy.waitUntil(
            () => cy.apollo({
                queryFile: 'graphql/taskBoardRequestItems.query.graphql',
                variables: {first: 50, limit: null}
            }).then(({data}) => (data.taskBoard.edges as Array<{node: BoardNode}>)
                .some(edge => edge.node.taskType === 'jnt:workflowTask')),
            {timeout: 30000, interval: 1000, errorMsg: 'No jnt:workflowTask appeared on the board'}
        );
    });

    after(() => {
        // Before deleting the site: an open process holding references into a deleted tree is a
        // mess for whatever suite runs next on this instance.
        abortAllWorkflows();
        deleteSite(TEST_SITE_KEY);
    });

    it('counts every item of the request, not just the one the task references', () => {
        withWorkflowTask(null, task => {
            expect(task.requestItemCount).to.equal(REQUEST_SIZE);
        });
    });

    it('lists every item of the request', () => {
        withWorkflowTask(null, task => {
            expect(task.requestItems).to.have.length(REQUEST_SIZE);
            const locations = task.requestItems.map(item => item.locationPath);
            expect(locations).to.include(HOME_PATH);
            expect(locations.filter(path => path === CONTENT_PARENT)).to.have.length(CONTENT_ITEMS.length);
        });
    });

    it('caps the list at the requested limit while the count stays whole', () => {
        withWorkflowTask(2, task => {
            expect(task.requestItems).to.have.length(2);
            // The count is the engine's, so capping what is RESOLVED must not change it -- that is
            // what lets a card say "showing 2 of 3" rather than silently claiming the request is
            // two items long.
            expect(task.requestItemCount).to.equal(REQUEST_SIZE);
        });
    });

    it('still reports only one target, which is the core limitation this works around', () => {
        // Asserted deliberately rather than ignored: targets reads the task's own targetNode
        // property, and core records only the first node of the request there
        // (Jahia/jahia-private#6037). When that is fixed this assertion fails, which is the
        // intended signal to drop the live-process workaround.
        withWorkflowTask(null, task => {
            expect(task.targets).to.have.length(1);
        });
    });

    it('resolves a preview URL for the page and none for content outside one', () => {
        withWorkflowTask(null, task => {
            const page = task.requestItems.find(item => item.locationPath === HOME_PATH);
            // Thrown rather than asserted: an expect() does not narrow the type for the
            // dereferences below, and a missing page here means the fixture built the wrong
            // request, which is worth failing on loudly.
            if (!page) {
                throw new Error(`No request item is located at ${HOME_PATH}`);
            }

            expect(page.previewUrl).to.be.a('string');
            // The session this is resolved through must carry a locale, or core's URL builder
            // writes a literal "null" where the language segment belongs.
            expect(page.previewUrl).to.not.contain('/null/');
            expect(page.previewUrl).to.contain('/en/');

            const inFolder = task.requestItems.filter(item => item.locationPath === CONTENT_PARENT);
            expect(inFolder).to.have.length(CONTENT_ITEMS.length);
            inFolder.forEach(item => {
                expect(item.inPage, `${item.displayName} is not in a page`).to.equal(false);
                expect(item.previewUrl, `${item.displayName} has nothing to render`).to.be.null;
            });
        });
    });

    it('summarises the workflow with the same count the list has', () => {
        withWorkflowTask(null, task => {
            expect(task.workflowSummary).to.be.a('string');
            expect(task.workflowSummary).to.contain(`${REQUEST_SIZE} content items involved`);
        });
    });
});
