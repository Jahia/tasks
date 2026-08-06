import {createSite, deleteSite, createUser, deleteUser, addNode, deleteNode, grantRoles} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';

// Covers the jnt:task detail view's updateTaskState mutation (Phase 1) and the jnt:simpleWorkflow
// taskData inline-edit mutation. Row-action mutations shared with the task board / task list
// (assign/unassign/suspend/complete) are already covered by task-board.cy.ts.
const REVIEWER = 'tasks-e2e-detail-reviewer';
const REVIEWER_PASSWORD = 'password123';
const TASKS_CONTAINER = `/sites/${TEST_SITE_KEY}/contents/e2e-task-detail`;

type AddNodeResponse = {data: {jcr: {addNode: {uuid: string}}}};

// Yields the created node's JCR uuid -- these mutations resolve "id" via
// session.getNodeByIdentifier(id) server-side, which (per JCR spec) requires a real identifier,
// not a path. addNode's response shape (data.jcr.addNode.uuid) is confirmed from @jahia/cypress's
// own addNode.graphql fixture.
function addTask(name: string, properties: Array<{name: string; value: string; language?: string}>) {
    return addNode({
        parentPathOrId: TASKS_CONTAINER,
        primaryNodeType: 'jnt:task',
        name,
        properties: [{name: 'jcr:title', value: name, language: 'en'}, ...properties]
    }).then((response: AddNodeResponse) => response.data.jcr.addNode.uuid);
}

describe('Task detail (jnt:task updateTaskState / jnt:simpleWorkflow updateTaskDataTitle)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
        createUser(REVIEWER, REVIEWER_PASSWORD);
        // editor-in-chief grants the "publish" permission TaskAuthorizationService#canReviewAllTasks
        // checks, letting this persona act on any task regardless of ownership.
        grantRoles('/', ['editor-in-chief'], REVIEWER, 'USER');

        addNode({parentPathOrId: `/sites/${TEST_SITE_KEY}/contents`, primaryNodeType: 'jnt:tasks', name: 'e2e-task-detail'});
    });

    after(() => {
        deleteUser(REVIEWER);
        deleteSite(TEST_SITE_KEY);
    });

    beforeEach(() => {
        cy.apolloClient({username: REVIEWER, password: REVIEWER_PASSWORD});
    });

    describe('updateTaskState', () => {
        it('rejects a state outside the allowed set', () => {
            const name = 'detail-invalid-state';
            addTask(name, [{name: 'state', value: 'active'}]).then(id => {
                cy.apollo({
                    mutationFile: 'graphql/updateTaskState.mutation.graphql',
                    variables: {id, state: 'not-a-real-state'}
                }).then(response => {
                    expect(response.graphQLErrors).to.have.length.greaterThan(0);
                });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('moves an active task to suspended, then cancelled', () => {
            const name = 'detail-active-task';
            addTask(name, [{name: 'state', value: 'active'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/updateTaskState.mutation.graphql', variables: {id, state: 'suspended'}})
                    .then(({data}) => {
                        expect(data.updateTaskState.state).to.equal('suspended');
                    });

                cy.apollo({queryFile: 'graphql/task.query.graphql', variables: {id}})
                    .then(({data}) => {
                        expect(data.task.state).to.equal('suspended');
                    });

                cy.apollo({mutationFile: 'graphql/updateTaskState.mutation.graphql', variables: {id, state: 'cancelled'}})
                    .then(({data}) => {
                        expect(data.updateTaskState.state).to.equal('cancelled');
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('moves a suspended task back to active ("Continue")', () => {
            const name = 'detail-suspended-task';
            addTask(name, [{name: 'state', value: 'suspended'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/updateTaskState.mutation.graphql', variables: {id, state: 'active'}})
                    .then(({data}) => {
                        expect(data.updateTaskState.state).to.equal('active');
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });
    });

    describe('updateTaskDataTitle (jnt:simpleWorkflow inline edit)', () => {
        it('updates the title of a taskData child node', () => {
            const name = 'detail-workflow-task';
            addTask(name, [{name: 'state', value: 'started'}]).then(taskId => {
                addNode({
                    parentPathOrId: taskId,
                    primaryNodeType: 'jnt:simpleWorkflow',
                    name: 'taskData',
                    properties: [{name: 'jcr:title', value: 'Original title', language: 'en'}]
                }).then((response: AddNodeResponse) => {
                    const taskDataId = response.data.jcr.addNode.uuid;

                    cy.apollo({
                        mutationFile: 'graphql/updateTaskDataTitle.mutation.graphql',
                        variables: {id: taskDataId, title: 'Updated title'}
                    }).then(({data}) => {
                        expect(data.updateTaskDataTitle.uuid).to.equal(taskDataId);
                    });

                    cy.apollo({queryFile: 'graphql/nodeTitle.query.graphql', variables: {id: taskDataId}})
                        .then(({data}) => {
                            expect(data.jcr.nodeById.property.value).to.equal('Updated title');
                        });
                });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });
    });
});
