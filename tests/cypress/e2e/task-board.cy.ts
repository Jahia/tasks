import {createSite, deleteSite, createUser, deleteUser, addNode, deleteNode, grantRoles} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET, PAGE_SIZE} from '../support/constants';

// Every mutation re-checks RBAC server-side (TaskAuthorizationService); a "reviewer" persona
// with the "publish" permission on the JCR root can act on any task regardless of ownership,
// which lets every row action (assign/unassign/suspend/complete) be exercised from one
// identity instead of juggling per-task "candidates"/assignee setup for each scenario.
const REVIEWER = 'tasks-e2e-reviewer';
const REVIEWER_PASSWORD = 'password123';
const TASKS_CONTAINER = `/sites/${TEST_SITE_KEY}/contents/e2e-tasks`;

// Yields the created node's JCR uuid -- assignTaskToMe/unassignTask/suspendTask/completeTask all
// resolve their "id" argument via session.getNodeByIdentifier(id) server-side, which (per JCR
// spec) requires a real identifier, not a path. addNode's response shape (data.jcr.addNode.uuid)
// is confirmed from @jahia/cypress's own addNode.graphql fixture.
function addTask(name: string, properties: Array<{name: string; value?: string; values?: string[]; language?: string}>) {
    return addNode({
        parentPathOrId: TASKS_CONTAINER,
        primaryNodeType: 'jnt:task',
        name,
        properties: [{name: 'jcr:title', value: name, language: 'en'}, ...properties]
    }).then((response: {data: {jcr: {addNode: {uuid: string}}}}) => response.data.jcr.addNode.uuid);
}

describe('Task board (taskBoard GraphQL query/mutations behind the React view)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
        createUser(REVIEWER, REVIEWER_PASSWORD);
        // editor-in-chief is Jahia's standard role granting "publish" -- confirm against the
        // target instance's role set if the reviewer-path assertions below start failing.
        grantRoles('/', ['editor-in-chief'], REVIEWER, 'USER');

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
                    expect(data.taskBoard.pageInfo.totalCount).to.be.at.least(TOTAL_TASKS);
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

    describe('search', () => {
        // "zzsearch-" keeps these out of range of any other content the repo-wide query might
        // see (see the pagination describe block's own comment on why this query isn't site-scoped).
        const ALPHA = 'zzsearch-alpha-widget';
        const BETA = 'zzsearch-beta-gadget';
        const names = [ALPHA, BETA];

        before(() => {
            addTask(ALPHA, [{name: 'state', value: 'active'}]);
            addTask(BETA, [{name: 'state', value: 'suspended'}]);
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        it('matches a case-insensitive substring of the title', () => {
            cy.apollo({queryFile: 'graphql/taskBoard.query.graphql', variables: {first: PAGE_SIZE, search: 'ALPHA-WIDGET'}})
                .then(({data}) => {
                    const titles = data.taskBoard.edges.map((edge: {node: {title: string}}) => edge.node.title);
                    expect(titles).to.include(ALPHA);
                    expect(titles).to.not.include(BETA);
                });
        });

        // TaskBoardQueryExtensions#taskBoard matches search against title, creator, assignee
        // display name AND state -- this exercises a field other than title.
        it('also matches against state, not just title', () => {
            cy.apollo({queryFile: 'graphql/taskBoard.query.graphql', variables: {first: PAGE_SIZE, search: 'suspended'}})
                .then(({data}) => {
                    const titles = data.taskBoard.edges.map((edge: {node: {title: string}}) => edge.node.title);
                    expect(titles).to.include(BETA);
                    expect(titles).to.not.include(ALPHA);
                });
        });

        it('returns nothing for a non-matching search term', () => {
            cy.apollo({queryFile: 'graphql/taskBoard.query.graphql', variables: {first: PAGE_SIZE, search: 'zzsearch-no-such-task-exists'}})
                .then(({data}) => {
                    expect(data.taskBoard.edges).to.have.length(0);
                    expect(data.taskBoard.pageInfo.totalCount).to.equal(0);
                });
        });
    });

    describe('sorting', () => {
        // Titles deliberately alphabetize in a DIFFERENT order than their states do, so a
        // title-sort test and a state-sort test each assert a distinct expected order -- proving
        // each one actually sorts by its own field, not by some other coincidentally-matching order.
        // "zzsort-" + the shared "search" param (already covered above) scopes the repo-wide query
        // down to just these three, the same way the search describe block does.
        const BRAVO_SUSPENDED = 'zzsort-bravo';
        const ALPHA_ACTIVE = 'zzsort-alpha';
        const CHARLIE_FINISHED = 'zzsort-charlie';
        const names = [BRAVO_SUSPENDED, ALPHA_ACTIVE, CHARLIE_FINISHED];

        before(() => {
            addTask(BRAVO_SUSPENDED, [{name: 'state', value: 'suspended'}]);
            addTask(ALPHA_ACTIVE, [{name: 'state', value: 'active'}]);
            addTask(CHARLIE_FINISHED, [{name: 'state', value: 'finished'}]);
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        function titlesOf(edges: Array<{node: {title: string}}>) {
            return edges.map(edge => edge.node.title);
        }

        it('sorts by title ascending', () => {
            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzsort', sortBy: 'title', sortOrder: 'ascending'}
            }).then(({data}) => {
                expect(titlesOf(data.taskBoard.edges)).to.deep.equal([ALPHA_ACTIVE, BRAVO_SUSPENDED, CHARLIE_FINISHED]);
            });
        });

        it('sorts by title descending (the same click toggling direction)', () => {
            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzsort', sortBy: 'title', sortOrder: 'descending'}
            }).then(({data}) => {
                expect(titlesOf(data.taskBoard.edges)).to.deep.equal([CHARLIE_FINISHED, BRAVO_SUSPENDED, ALPHA_ACTIVE]);
            });
        });

        // Groups same-state tasks together, in state's own alphabetical order (active < finished
        // < suspended) -- NOT title order, confirming this sorts by state and not by coincidence.
        it('sorts by state ascending, grouping same-state tasks together', () => {
            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzsort', sortBy: 'state', sortOrder: 'ascending'}
            }).then(({data}) => {
                expect(titlesOf(data.taskBoard.edges)).to.deep.equal([ALPHA_ACTIVE, CHARLIE_FINISHED, BRAVO_SUSPENDED]);
            });
        });

        // creator/owner go through the exact same resolved-value comparator as title/state
        // (TaskBoardQueryExtensions#resolvedValueExtractor) -- this only confirms the server
        // accepts them and doesn't error, not a specific expected order (rigging distinct,
        // resolvable creator/assignee display names deterministically isn't worth the fixture
        // complexity here).
        it('accepts creator and owner as sort fields without erroring', () => {
            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzsort', sortBy: 'creator', sortOrder: 'ascending'}
            }).then(({data}) => {
                expect(titlesOf(data.taskBoard.edges)).to.have.length(3);
            });

            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzsort', sortBy: 'owner', sortOrder: 'ascending'}
            }).then(({data}) => {
                expect(titlesOf(data.taskBoard.edges)).to.have.length(3);
            });
        });
    });

    describe('filterState (the board hides finished tasks by default)', () => {
        const ACTIVE_ONE = 'zzfilter-active';
        const FINISHED_ONE = 'zzfilter-finished';
        const names = [ACTIVE_ONE, FINISHED_ONE];

        before(() => {
            addTask(ACTIVE_ONE, [{name: 'state', value: 'active'}]);
            addTask(FINISHED_ONE, [{name: 'state', value: 'finished'}]);
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        // This is the exact value taskBoard.shared.ts's NOT_FINISHED_STATES sends on every
        // board fetch (TaskBoard.client.tsx / TasksDashboardApp.tsx / CurrentUserTasksView) --
        // duplicated here rather than imported, since this spec runs as its own Cypress project
        // with no dependency on the module's client source.
        const NOT_FINISHED = ['active', 'started', 'suspended'];

        it('excludes finished tasks when filterState is passed (the board\'s own default)', () => {
            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzfilter', filterState: NOT_FINISHED}
            }).then(({data}) => {
                const titles = data.taskBoard.edges.map((edge: {node: {title: string}}) => edge.node.title);
                expect(titles).to.include(ACTIVE_ONE);
                expect(titles).to.not.include(FINISHED_ONE);
            });
        });

        // The query itself stays a complete, neutral listing -- hiding finished tasks is the
        // board's own choice of filterState, not a hidden server-side default.
        it('still returns finished tasks when no filterState is passed at all', () => {
            cy.apollo({
                queryFile: 'graphql/taskBoard.query.graphql',
                variables: {first: PAGE_SIZE, search: 'zzfilter'}
            }).then(({data}) => {
                const titles = data.taskBoard.edges.map((edge: {node: {title: string}}) => edge.node.title);
                expect(titles).to.include(ACTIVE_ONE);
                expect(titles).to.include(FINISHED_ONE);
            });
        });
    });

    describe('row menu actions', () => {
        beforeEach(() => {
            cy.apolloClient({username: REVIEWER, password: REVIEWER_PASSWORD});
        });

        it('"Assign to me": assigns an active, unowned task to the acting user', () => {
            const name = 'action-assign';
            addTask(name, [{name: 'state', value: 'active'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/assignTaskToMe.mutation.graphql', variables: {id}})
                    .then(({data}) => {
                        expect(data.assignTaskToMe.state).to.equal('active');
                        expect(data.assignTaskToMe.owner).to.be.a('string');
                        expect(data.assignTaskToMe.owner).to.not.equal('');
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Unassign / Refuse": returns an assigned task to the active, unassigned pool', () => {
            const name = 'action-unassign';
            addTask(name, [
                {name: 'state', value: 'started'},
                {name: 'assigneeUserKey', value: 'someone-else'}
            ]).then(id => {
                cy.apollo({mutationFile: 'graphql/unassignTask.mutation.graphql', variables: {id}})
                    .then(({data}) => {
                        expect(data.unassignTask.state).to.equal('active');
                        expect(data.unassignTask.owner).to.equal('');
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Suspend": moves a started task to suspended', () => {
            const name = 'action-suspend';
            addTask(name, [{name: 'state', value: 'started'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/suspendTask.mutation.graphql', variables: {id}})
                    .then(({data}) => {
                        expect(data.suspendTask.state).to.equal('suspended');
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Publish" / "Reject publication": completes a started task with one of its declared outcomes', () => {
            const name = 'action-complete';
            addTask(name, [
                {name: 'state', value: 'started'},
                {name: 'possibleOutcomes', values: ['publish', 'reject']}
            ]).then(id => {
                cy.apollo({
                    mutationFile: 'graphql/completeTask.mutation.graphql',
                    variables: {id, outcome: 'reject'}
                }).then(({data}) => {
                    expect(data.completeTask.state).to.equal('finished');
                });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });
    });
});
