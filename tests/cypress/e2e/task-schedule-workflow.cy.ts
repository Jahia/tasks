import {createSite, deleteSite} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';

// Covers the workflowActivity query behind jnt:taskSchedule (Phase 3). This is deliberately a
// shape/no-crash smoke test, not a full workflow-engine fixture: exercising getHistoryWorkflowsByPath
// with a real in-progress process requires actually triggering a publication workflow (create a
// page, submit it, have a reviewer act on it), which is a heavier integration setup than this
// GraphQL-level check warrants. If deeper coverage is wanted later, build it as its own suite atop
// jahia-cypress-testing's PublicationAndWorkflowHelper, using a workflow-enabled site.
describe('Task schedule (workflowActivity query)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
    });

    after(() => {
        deleteSite(TEST_SITE_KEY);
    });

    it('returns an empty activity shape for a path with no workflow processes', () => {
        cy.apollo({
            queryFile: 'graphql/workflowActivity.query.graphql',
            variables: {path: `/sites/${TEST_SITE_KEY}`}
        }).then(({data}) => {
            expect(data.workflowActivity.activeTasks).to.deep.equal([]);
            expect(data.workflowActivity.history).to.deep.equal([]);
        });
    });
});
