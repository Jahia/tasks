import {createSite, deleteSite, createUser, deleteUser, addNode, deleteNode, grantRoles} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET, PAGE_SIZE} from '../support/constants';

// Every mutation re-checks RBAC server-side (TaskAuthorizationService); a "reviewer" persona
// with the "publish" permission on the JCR root can act on any task regardless of ownership,
// which lets every row action (assign/unassign/suspend/complete) be exercised from one
// identity instead of juggling per-task "candidates"/assignee setup for each scenario.
const REVIEWER = 'tasks-e2e-reviewer';
const REVIEWER_PASSWORD = 'password123';
const TASKS_CONTAINER = `/sites/${TEST_SITE_KEY}/contents/e2e-tasks`;

function addTask(name: string, properties: Array<{name: string; value: string; language?: string}>) {
    return addNode({
        parentPathOrId: TASKS_CONTAINER,
        primaryNodeType: 'jnt:task',
        name,
        properties: [{name: 'jcr:title', value: name, language: 'en'}, ...properties]
    });
}

describe('Task board (taskBoard GraphQL query/mutations behind the React view)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, locale: 'en'});
        createUser(REVIEWER, REVIEWER_PASSWORD);
        // editor-in-chief is Jahia's standard role granting "publish" -- confirm against the
        // target instance's role set if the reviewer-path assertions below start failing.
        grantRoles('/', ['editor-in-chief'], REVIEWER, 'user');

        addNode({parentPathOrId: `/sites/${TEST_SITE_KEY}/contents`, primaryNodeType: 'jnt:tasks', name: 'e2e-tasks'});
    });

    after(() => {
        deleteUser(REVIEWER);
        deleteSite(TEST_SITE_KEY);
    });

    describe('pagination', () => {
        const TOTAL_TASKS = PAGE_SIZE + 5;
        const names = Array.from({length: TOTAL_TASKS}, (_, i) => `page-task-${i}`);

        before(() => {
            names.forEach(name => addTask(name, [{name: 'state', value: 'active'}]));
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        it('returns a first page of PAGE_SIZE results and reports more are available', () => {
            cy.apollo({queryFile: 'graphql/taskBoard.query.graphql', variables: {first: PAGE_SIZE}})
                .then(({data}) => {
                    expect(data.taskBoard.edges).to.have.length(PAGE_SIZE);
                    // Repo-wide query (no site scoping yet, see TaskBoardQueryExtensions' Phase 4
                    // TODO) -- assert a floor, not an exact count, since other content may exist.
                    expect(data.taskBoard.totalCount).to.be.at.least(TOTAL_TASKS);
                    expect(data.taskBoard.pageInfo.hasNextPage).to.equal(true);
                    expect(data.taskBoard.pageInfo.endCursor).to.be.a('string');
                });
        });

        it('follows the cursor to fetch a disjoint next page', () => {
            cy.apollo({queryFile: 'graphql/taskBoard.query.graphql', variables: {first: PAGE_SIZE}})
                .then(({data: firstPage}) => {
                    const cursor = firstPage.taskBoard.pageInfo.endCursor;
                    const firstPageIds = firstPage.taskBoard.edges.map((edge: {node: {id: string}}) => edge.node.id);

                    cy.apollo({
                        queryFile: 'graphql/taskBoard.query.graphql',
                        variables: {first: PAGE_SIZE, after: cursor}
                    }).then(({data: secondPage}) => {
                        const secondPageIds = secondPage.taskBoard.edges.map((edge: {node: {id: string}}) => edge.node.id);
                        expect(secondPageIds.length).to.be.greaterThan(0);
                        secondPageIds.forEach((id: string) => expect(firstPageIds).to.not.include(id));
                    });
                });
        });
    });

    describe('row menu actions', () => {
        beforeEach(() => {
            cy.apolloClient({username: REVIEWER, password: REVIEWER_PASSWORD});
        });

        it('"Assign to me": assigns an active, unowned task to the acting user', () => {
            const name = 'action-assign';
            addTask(name, [{name: 'state', value: 'active'}]);

            cy.apollo({mutationFile: 'graphql/assignTaskToMe.mutation.graphql', variables: {id: `${TASKS_CONTAINER}/${name}`}})
                .then(({data}) => {
                    expect(data.assignTaskToMe.state).to.equal('active');
                    expect(data.assignTaskToMe.owner).to.be.a('string');
                    expect(data.assignTaskToMe.owner).to.not.equal('');
                });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Unassign / Refuse": returns an assigned task to the active, unassigned pool', () => {
            const name = 'action-unassign';
            addTask(name, [
                {name: 'state', value: 'started'},
                {name: 'assigneeUserKey', value: 'someone-else'}
            ]);

            cy.apollo({mutationFile: 'graphql/unassignTask.mutation.graphql', variables: {id: `${TASKS_CONTAINER}/${name}`}})
                .then(({data}) => {
                    expect(data.unassignTask.state).to.equal('active');
                    expect(data.unassignTask.owner).to.equal('');
                });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Suspend": moves a started task to suspended', () => {
            const name = 'action-suspend';
            addTask(name, [{name: 'state', value: 'started'}]);

            cy.apollo({mutationFile: 'graphql/suspendTask.mutation.graphql', variables: {id: `${TASKS_CONTAINER}/${name}`}})
                .then(({data}) => {
                    expect(data.suspendTask.state).to.equal('suspended');
                });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Publish" / "Reject publication": completes a started task with one of its declared outcomes', () => {
            const name = 'action-complete';
            addTask(name, [
                {name: 'state', value: 'started'},
                {name: 'possibleOutcomes', value: 'publish'},
                {name: 'possibleOutcomes', value: 'reject'}
            ]);

            cy.apollo({
                mutationFile: 'graphql/completeTask.mutation.graphql',
                variables: {id: `${TASKS_CONTAINER}/${name}`, outcome: 'reject'}
            }).then(({data}) => {
                expect(data.completeTask.state).to.equal('finished');
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });
    });
});
