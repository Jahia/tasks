import {addNode, createSite, deleteSite} from '@jahia/cypress';
import {SCHEDULE_SITE_KEY as SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';
import {publicationStatus, startPublicationReview} from '../support/taskFixtures';

// The workflowActivity query behind jnt:taskSchedule -- deliberately NOT a JCR query: it reads the
// workflow engine's own process store (WorkflowService), which is not necessarily mirrored into the
// jnt:workflowTask nodes the board lists. So this spec drives a real publication process from start
// to decision and asserts what the ENGINE then reports, which is the only thing this query can be
// wrong about. (It used to be a shape/no-crash smoke test only, on the grounds that a real process
// was too heavy a fixture; startPublicationReview in support/taskFixtures.ts is that fixture now,
// and the rest of the suite needs it anyway.)
const CONTENT_ROOT = `/sites/${SITE_KEY}/contents`;
const TARGET = 'e2e-schedule-target';

type WorkflowActivity = {
    activeTasks: Array<{label: string; dueDate: string | null}>;
    history: Array<{label: string; endTime: string | null}>;
};

function workflowActivity(path: string): Cypress.Chainable<WorkflowActivity> {
    return cy.apollo({
        queryFile: 'graphql/workflowActivity.query.graphql',
        fetchPolicy: 'no-cache',
        variables: {path}
    }).then(({data}) => data.workflowActivity as WorkflowActivity);
}

describe('Task schedule (workflowActivity query)', () => {
    before(() => {
        createSite(SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: SITE_KEY, locale: 'en'});
        addNode({parentPathOrId: CONTENT_ROOT, primaryNodeType: 'jnt:contentFolder', name: TARGET});
    });

    after(() => {
        deleteSite(SITE_KEY);
    });

    it('returns an empty activity shape for a path with no workflow processes', () => {
        workflowActivity(`/sites/${SITE_KEY}/files`).then(activity => {
            expect(activity.activeTasks).to.deep.equal([]);
            expect(activity.history).to.deep.equal([]);
        });
    });

    it('reports the engine\'s own history once a real process has been decided', () => {
        startPublicationReview(`${CONTENT_ROOT}/${TARGET}`).then(task => {
            // The query matches DESCENDANTS of the path it is given (it appends "/%", mirroring
            // WorkflowForPathTag), so it is asked about the CONTAINER, never about the node the
            // process runs on -- getting that wrong returns a plausible, permanently empty answer.
            workflowActivity(CONTENT_ROOT).then(whileRunning => {
                // Empty even though the process IS running: this query only surfaces tasks that
                // declare a DUE DATE, and 1-step publication's review task declares none. Asserted
                // rather than left implicit, because "empty" here is a property of the workflow
                // definition and not evidence that nothing is running.
                expect(whileRunning.activeTasks).to.deep.equal([]);
                expect(whileRunning.history).to.deep.equal([]);
            });

            cy.apollo({
                mutationFile: 'graphql/reviewTask.mutation.graphql',
                variables: {id: task.id, outcome: 'accept'}
            }).then(({data}) => {
                expect(data.reviewTask.state).to.equal('finished');
            });

            // root belongs to the built-in administrators group, which every publication review
            // lists among its candidates -- so the engine accepts this completion and really
            // publishes, which is also what puts a completed task into the history below.
            cy.waitUntil(
                () => publicationStatus(`${CONTENT_ROOT}/${TARGET}`).then(status => status === 'PUBLISHED'),
                {errorMsg: 'The reviewed content was never published', timeout: 30000, interval: 1000}
            );

            cy.waitUntil(
                () => workflowActivity(CONTENT_ROOT).then(activity => activity.history.length > 0),
                {
                    errorMsg: 'The completed process never appeared in the engine\'s history',
                    timeout: 30000,
                    interval: 1000
                }
            );
            workflowActivity(CONTENT_ROOT).then(activity => {
                expect(activity.history[0].label, 'history entry label').to.be.a('string').and.not.be.empty;
                expect(activity.history[0].endTime, 'history entry end time').to.be.a('string');
            });
        });
    });
});
