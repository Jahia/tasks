import {addNode, createSite, deleteSite} from '@jahia/cypress';
import {runScopedName, SCHEDULE_SITE_KEY as SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';
import {publicationStatus, startPublicationReview} from '../support/taskFixtures';

// The workflowActivity query behind jnt:taskSchedule -- deliberately NOT a JCR query: it reads the
// workflow engine's own process store (WorkflowService), which is not necessarily mirrored into the
// jnt:workflowTask nodes the board lists. So this spec drives a real publication process from start
// to decision and asserts what the ENGINE then reports, which is the only thing this query can be
// wrong about. (It used to be a shape/no-crash smoke test only, on the grounds that a real process
// was too heavy a fixture; startPublicationReview in support/taskFixtures.ts is that fixture now,
// and the rest of the suite needs it anyway.)
const CONTENT_ROOT = `/sites/${SITE_KEY}/contents`;
// The CONTAINER is what has to be per-run, not just the target inside it: every assertion below
// asks workflowActivity about the container, and that query is a SQL LIKE on "<container>/%" over
// the engine's own process store -- a store that survives deleteSite (see runScopedName in
// support/constants.ts). Querying a fixed container therefore returns one extra finished process
// per previous run, whatever the target inside it is named. A container nobody has used before is
// the only path for which "the engine reports nothing yet" is a statement about THIS run.
const CONTAINER_NAME = runScopedName('e2e-schedule');
const CONTAINER = `${CONTENT_ROOT}/${CONTAINER_NAME}`;
const TARGET = 'e2e-schedule-target';
const TARGET_PATH = `${CONTAINER}/${TARGET}`;

type WorkflowActivityEntry = {label: string; name: string | null; user: string | null; dueDate: string | null; endTime: string | null};

type WorkflowActivity = {
    processes: Array<{
        name: string | null;
        startUser: string | null;
        startTime: string | null;
        endTime: string | null;
        isCompleted: boolean;
    }>;
    activeTasks: WorkflowActivityEntry[];
    history: WorkflowActivityEntry[];
};

function workflowActivity(path: string, includeSelf = false): Cypress.Chainable<WorkflowActivity> {
    return cy.apollo({
        queryFile: 'graphql/workflowActivity.query.graphql',
        fetchPolicy: 'no-cache',
        variables: {path, includeSelf}
    }).then(({data}) => data.workflowActivity as WorkflowActivity);
}

describe('Task schedule (workflowActivity query)', () => {
    before(() => {
        createSite(SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: SITE_KEY, locale: 'en'});
        addNode({parentPathOrId: CONTENT_ROOT, primaryNodeType: 'jnt:contentFolder', name: CONTAINER_NAME});
        addNode({parentPathOrId: CONTAINER, primaryNodeType: 'jnt:contentFolder', name: TARGET});
    });

    after(() => {
        deleteSite(SITE_KEY);
    });

    it('returns an empty activity shape for a path with no workflow processes', () => {
        workflowActivity(`/sites/${SITE_KEY}/files`).then(activity => {
            expect(activity.processes).to.deep.equal([]);
            expect(activity.activeTasks).to.deep.equal([]);
            expect(activity.history).to.deep.equal([]);
        });
    });

    it('reports the engine\'s own history once a real process has been decided', () => {
        startPublicationReview(TARGET_PATH).then(task => {
            // The query matches DESCENDANTS of the path it is given (it appends "/%", mirroring
            // WorkflowForPathTag), so it is asked about the CONTAINER, never about the node the
            // process runs on -- getting that wrong returns a plausible, permanently empty answer.
            workflowActivity(CONTAINER).then(whileRunning => {
                // Empty even though the process IS running: these two lists only surface tasks that
                // declare a DUE DATE, and steps that have already ENDED -- 1-step publication's
                // review task is neither. Asserted rather than left implicit, because "empty" here
                // is a property of the workflow definition and not evidence that nothing is running.
                expect(whileRunning.activeTasks).to.deep.equal([]);
                expect(whileRunning.history).to.deep.equal([]);

                // `processes` is the level at which a running request IS visible, which is what the
                // board's preview panel renders as its "started by" line (#61).
                expect(whileRunning.processes, 'running processes').to.have.length(1);
                const [running] = whileRunning.processes;
                expect(running.isCompleted, 'the process is still running').to.equal(false);
                expect(running.startUser, 'start user').to.equal('root');
                expect(running.startTime, 'start time').to.be.a('string');
                expect(running.name, 'workflow definition name').to.be.a('string').and.not.be.empty;
            });

            // The panel asks about the node the process runs ON, not its container -- which the
            // default (descendants-only) form of this query cannot answer at all.
            workflowActivity(TARGET_PATH).then(withoutSelf => {
                expect(withoutSelf.processes, 'descendants of the target itself').to.deep.equal([]);
            });
            workflowActivity(TARGET_PATH, true).then(withSelf => {
                expect(withSelf.processes, 'the target node\'s own processes').to.have.length(1);
                expect(withSelf.processes[0].startUser).to.equal('root');
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
                () => publicationStatus(TARGET_PATH).then(status => status === 'PUBLISHED'),
                {errorMsg: 'The reviewed content was never published', timeout: 30000, interval: 1000}
            );

            cy.waitUntil(
                () => workflowActivity(CONTAINER).then(activity => activity.history.length > 0),
                {
                    errorMsg: 'The completed process never appeared in the engine\'s history',
                    timeout: 30000,
                    interval: 1000
                }
            );
            workflowActivity(CONTAINER).then(activity => {
                expect(activity.history[0].label, 'history entry label').to.be.a('string').and.not.be.empty;
                expect(activity.history[0].endTime, 'history entry end time').to.be.a('string');
                // The STEP, which is what the preview panel renders: the jBPM provider hardcodes a
                // completed task's outcome to the literal string "outcome" (see
                // GetHistoryWorkflowTasksCommand), so `label` alone cannot name what was completed.
                expect(activity.history[0].name, 'history entry step name').to.be.a('string').and.not.be.empty;
                expect(activity.processes[0].isCompleted, 'the decided process is completed').to.equal(true);
                expect(activity.processes[0].endTime, 'process end time').to.be.a('string');
            });
        });
    });
});
