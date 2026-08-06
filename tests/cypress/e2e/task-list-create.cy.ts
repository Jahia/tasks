import {createSite, deleteSite, createUser, deleteUser, addNode, deleteNode, grantRoles, getUserPath} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';

// Covers jnt:createTaskForm's createTask mutation (Phase 2) and the isAssignableToMe field that
// drives the jnt:taskList row view's "Assign to me" visibility (candidate-based, independent of
// canReviewAll). Row-action mutations themselves (assign/unassign/suspend/complete) are shared
// with the task board and already covered by task-board.cy.ts.
const CANDIDATE = 'tasks-e2e-list-candidate';
const CANDIDATE_PASSWORD = 'password123';
const BYSTANDER = 'tasks-e2e-list-bystander';
const BYSTANDER_PASSWORD = 'password123';
const CONTENT_PARENT = `/sites/${TEST_SITE_KEY}/contents/e2e-task-list`;

type AddNodeResponse = {data: {jcr: {addNode: {uuid: string}}}};

describe('Task list creation (jnt:createTaskForm createTask) and assignability (jnt:taskList)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
        createUser(CANDIDATE, CANDIDATE_PASSWORD);
        createUser(BYSTANDER, BYSTANDER_PASSWORD);
        // jnt:task/jnt:workflowTask only ever lives in the edit/default workspace (see
        // TaskBoardQueryExtensions' class comment) -- the standard "reader" role only grants
        // jcr:read_live, so a plain candidate/bystander needs the hidden "privileged" role
        // (jcr:read_default) to read the task node at all, regardless of isAssignableToMe.
        grantRoles('/', ['privileged'], CANDIDATE, 'USER');
        grantRoles('/', ['privileged'], BYSTANDER, 'USER');
        addNode({parentPathOrId: `/sites/${TEST_SITE_KEY}/contents`, primaryNodeType: 'jnt:contentFolder', name: 'e2e-task-list'});
    });

    after(() => {
        deleteUser(CANDIDATE);
        deleteUser(BYSTANDER);
        deleteSite(TEST_SITE_KEY);
    });

    describe('createTask', () => {
        it('creates a task under parentPath, auto-creating the jnt:tasks container', () => {
            cy.apollo({
                mutationFile: 'graphql/createTask.mutation.graphql',
                variables: {
                    parentPath: CONTENT_PARENT,
                    title: 'A newly created task',
                    description: 'Created via the create-task form',
                    priority: 'high'
                }
            }).then(({data}) => {
                expect(data.createTask.title).to.equal('A newly created task');
                expect(data.createTask.state).to.equal('active');
                expect(data.createTask.priority).to.equal('high');
                expect(data.createTask.description).to.equal('Created via the create-task form');

                deleteNode(data.createTask.id);
            });
        });

        it('assigns each new task a unique name when created repeatedly under the same parent', () => {
            cy.apollo({
                mutationFile: 'graphql/createTask.mutation.graphql',
                variables: {parentPath: CONTENT_PARENT, title: 'First task'}
            }).then(({data: first}) => {
                cy.apollo({
                    mutationFile: 'graphql/createTask.mutation.graphql',
                    variables: {parentPath: CONTENT_PARENT, title: 'Second task'}
                }).then(({data: second}) => {
                    expect(second.createTask.id).to.not.equal(first.createTask.id);
                    deleteNode(first.createTask.id);
                    deleteNode(second.createTask.id);
                });
            });
        });
    });

    describe('isAssignableToMe', () => {
        it('is true for an eligible candidate and false for an uninvolved user', () => {
            // Jahia shards user nodes into hashed subfolders (e.g. /users/cd/hc/dg/<username>),
            // not a flat /users/<username> -- candidates must store the real resolved path, not
            // a guessed one, or isOwnerOrCandidate's path comparison never matches.
            getUserPath(CANDIDATE).then(({data}: {data: {admin: {userAdmin: {user: {node: {path: string}}}}}}) => {
                const candidatePath = data.admin.userAdmin.user.node.path;

                addNode({
                    parentPathOrId: CONTENT_PARENT,
                    primaryNodeType: 'jnt:tasks',
                    name: 'e2e-assignability-tasks'
                }).then(() => {
                    addNode({
                        parentPathOrId: `${CONTENT_PARENT}/e2e-assignability-tasks`,
                        primaryNodeType: 'jnt:task',
                        name: 'candidate-task',
                        properties: [
                            {name: 'jcr:title', value: 'candidate-task', language: 'en'},
                            {name: 'state', value: 'active'},
                            {name: 'candidates', values: [candidatePath]}
                        ]
                    }).then((response: AddNodeResponse) => {
                        const id = response.data.jcr.addNode.uuid;

                        cy.apolloClient({username: CANDIDATE, password: CANDIDATE_PASSWORD});
                        cy.apollo({queryFile: 'graphql/task.query.graphql', variables: {id}})
                            .then(({data}) => {
                                expect(data.task.isAssignableToMe).to.equal(true);
                            });

                        cy.apolloClient({username: BYSTANDER, password: BYSTANDER_PASSWORD});
                        cy.apollo({queryFile: 'graphql/task.query.graphql', variables: {id}})
                            .then(({data}) => {
                                expect(data.task.isAssignableToMe).to.equal(false);
                            });

                        deleteNode(id);
                    });
                });
            });
        });
    });
});
