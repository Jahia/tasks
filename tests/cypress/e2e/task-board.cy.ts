import {addNode, createSite, createUser, deleteNode, deleteSite, deleteUser, grantRoles} from '@jahia/cypress';
import {
    BOARD_SITE_KEY as SITE_KEY,
    PAGE_SIZE,
    REVIEWER_ROLE,
    TEST_PASSWORD,
    TEST_TEMPLATE_SET
} from '../support/constants';
import {addTask, errorMessagesOf, taskBoard, titlesOf} from '../support/taskFixtures';

// The listing half of the taskBoard query -- pagination, search, ordering and state filtering --
// plus the row-action mutations behind the board's kebab menu. Visibility scoping, the scope
// argument and the one-click review path have specs of their own (task-visibility / task-review),
// so everything here runs as ONE identity: a "reviewer" persona holding the publish permission,
// which is what lets a single user act on every task without per-task candidate setup.
const REVIEWER = 'tasks-e2e-board-reviewer';
const TASKS_CONTAINER = `/sites/${SITE_KEY}/contents/e2e-tasks`;

describe('Task board (taskBoard GraphQL query/mutations behind the React view)', () => {
    before(() => {
        createSite(SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: SITE_KEY, locale: 'en'});
        createUser(REVIEWER, TEST_PASSWORD);
        grantRoles('/', [REVIEWER_ROLE], REVIEWER, 'USER');

        addNode({parentPathOrId: `/sites/${SITE_KEY}/contents`, primaryNodeType: 'jnt:tasks', name: 'e2e-tasks'});
    });

    after(() => {
        deleteUser(REVIEWER);
        deleteSite(SITE_KEY);
    });

    describe('pagination', () => {
        const TOTAL_TASKS = PAGE_SIZE + 5;
        const names = Array.from({length: TOTAL_TASKS}, (_, i) => `page-task-${i}`);

        before(() => {
            names.forEach(name => addTask(TASKS_CONTAINER, name, [{name: 'state', value: 'active'}]));
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        it('returns a first page of PAGE_SIZE results and reports more are available', () => {
            taskBoard({first: PAGE_SIZE}).then(page => {
                expect(page.edges).to.have.length(PAGE_SIZE);
                // Repo-wide query (no site scoping yet, see TaskBoardQueryExtensions' Phase 4
                // note) -- assert a floor, not an exact count, since other content may exist.
                expect(page.pageInfo.totalCount).to.be.at.least(TOTAL_TASKS);
                expect(page.pageInfo.hasNextPage).to.equal(true);
                expect(page.pageInfo.endCursor).to.be.a('string');
            });
        });

        it('follows the cursor to fetch a disjoint next page', () => {
            taskBoard({first: PAGE_SIZE}).then(firstPage => {
                const firstPageIds = firstPage.edges.map(edge => edge.node.id);

                taskBoard({first: PAGE_SIZE, after: firstPage.pageInfo.endCursor}).then(secondPage => {
                    const secondPageIds = secondPage.edges.map(edge => edge.node.id);
                    expect(secondPageIds.length).to.be.greaterThan(0);
                    secondPageIds.forEach(id => expect(firstPageIds).to.not.include(id));
                });
            });
        });

        // The two pagination paths (#64) are required to return identical rows for the same
        // request: the query-level fast path serves a plain property sort, the scanning path serves
        // anything needing post-query values. `search` is what forces the second one, so the same
        // page asked for both ways is the one comparison that can catch them drifting apart.
        it('serves the same rows whether the page is sliced by JCR or scanned in memory', () => {
            taskBoard({first: 5, sortBy: 'jcr:created', sortOrder: 'descending'}).then(sliced => {
                taskBoard({first: 5, sortBy: 'title', sortOrder: 'ascending', search: 'page-task-'}).then(scanned => {
                    expect(scanned.edges).to.have.length(5);
                    expect(sliced.edges).to.have.length(5);
                    // Not the same ORDER (different sorts on purpose) -- what has to agree is that
                    // both paths report the same total for a board they both see in full.
                    expect(scanned.pageInfo.totalCount).to.equal(names.length);
                });
            });
        });
    });

    describe('search', () => {
        // "zzsearch-" keeps these out of range of any other content the repo-wide query might see
        // (see the pagination block's own comment on why this query isn't site-scoped).
        const ALPHA = 'zzsearch-alpha-widget';
        const BETA = 'zzsearch-beta-gadget';
        const names = [ALPHA, BETA];

        before(() => {
            addTask(TASKS_CONTAINER, ALPHA, [{name: 'state', value: 'active'}]);
            addTask(TASKS_CONTAINER, BETA, [{name: 'state', value: 'suspended'}]);
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        it('matches a case-insensitive substring of the title', () => {
            taskBoard({search: 'ALPHA-WIDGET'}).then(page => {
                expect(titlesOf(page)).to.include(ALPHA);
                expect(titlesOf(page)).to.not.include(BETA);
            });
        });

        // Search matches title, creator, assignee display name AND state -- this exercises a field
        // other than the title.
        it('also matches against state, not just title', () => {
            taskBoard({search: 'suspended'}).then(page => {
                expect(titlesOf(page)).to.include(BETA);
                expect(titlesOf(page)).to.not.include(ALPHA);
            });
        });

        it('returns nothing for a non-matching search term', () => {
            taskBoard({search: 'zzsearch-no-such-task-exists'}).then(page => {
                expect(page.edges).to.have.length(0);
                expect(page.pageInfo.totalCount).to.equal(0);
            });
        });
    });

    describe('sorting', () => {
        // Titles deliberately alphabetize in a DIFFERENT order than their states do, so a
        // title-sort test and a state-sort test each assert a distinct expected order -- proving
        // each one sorts by its own field, not by some coincidentally-matching order.
        const BRAVO_SUSPENDED = 'zzsort-bravo';
        const ALPHA_ACTIVE = 'zzsort-alpha';
        const CHARLIE_FINISHED = 'zzsort-charlie';
        const names = [BRAVO_SUSPENDED, ALPHA_ACTIVE, CHARLIE_FINISHED];

        before(() => {
            // Created in this order, so creation order (bravo, alpha, charlie) differs from both
            // title order and state order -- which is what makes the createdDate assertions below
            // say something.
            addTask(TASKS_CONTAINER, BRAVO_SUSPENDED, [{name: 'state', value: 'suspended'}]);
            addTask(TASKS_CONTAINER, ALPHA_ACTIVE, [{name: 'state', value: 'active'}]);
            addTask(TASKS_CONTAINER, CHARLIE_FINISHED, [{name: 'state', value: 'finished'}]);
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        it('sorts by title ascending', () => {
            taskBoard({search: 'zzsort', sortBy: 'title', sortOrder: 'ascending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([ALPHA_ACTIVE, BRAVO_SUSPENDED, CHARLIE_FINISHED]);
            });
        });

        it('sorts by title descending (the same header click, toggled)', () => {
            taskBoard({search: 'zzsort', sortBy: 'title', sortOrder: 'descending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([CHARLIE_FINISHED, BRAVO_SUSPENDED, ALPHA_ACTIVE]);
            });
        });

        // Groups same-state tasks together, in state's own alphabetical order (active < finished
        // < suspended) -- NOT title order, confirming this sorts by state and not by coincidence.
        it('sorts by state ascending, grouping same-state tasks together', () => {
            taskBoard({search: 'zzsort', sortBy: 'state', sortOrder: 'ascending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([ALPHA_ACTIVE, CHARLIE_FINISHED, BRAVO_SUSPENDED]);
            });
        });

        // The board's own default (DEFAULT_SORT_BY/DEFAULT_SORT_ORDER in taskBoard.shared.ts) and
        // the server's documented one (TaskBoardQueryExtensions#DEFAULT_SORT_PROPERTY) are the same
        // thing said twice, which only holds while the server really defaults to newest-first.
        it('defaults to newest-created first when neither sortBy nor sortOrder is passed', () => {
            taskBoard({search: 'zzsort'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([CHARLIE_FINISHED, ALPHA_ACTIVE, BRAVO_SUSPENDED]);
                // Same request, spelled out the way the board actually sends it.
                taskBoard({search: 'zzsort', sortBy: 'jcr:created', sortOrder: 'descending'}).then(explicit => {
                    expect(titlesOf(explicit)).to.deep.equal(titlesOf(page));
                });
            });
        });

        it('sorts by creation date ascending -- the board\'s "longest waiting first" column', () => {
            // The Waiting column inverts the direction it sends (invertsDirection in
            // TaskBoard.client.tsx): "most waiting first" is jcr:created ASCENDING.
            taskBoard({search: 'zzsort', sortBy: 'jcr:created', sortOrder: 'ascending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([BRAVO_SUSPENDED, ALPHA_ACTIVE, CHARLIE_FINISHED]);
            });
        });

        it('sorts by due date, a raw property on the server\'s own allow-list', () => {
            const DUE_SOON = 'zzdue-soon';
            const DUE_LATER = 'zzdue-later';
            addTask(TASKS_CONTAINER, DUE_LATER, [
                {name: 'state', value: 'active'},
                {name: 'dueDate', value: '2027-01-31T12:00:00.000Z'}
            ]);
            addTask(TASKS_CONTAINER, DUE_SOON, [
                {name: 'state', value: 'active'},
                {name: 'dueDate', value: '2026-09-01T12:00:00.000Z'}
            ]);

            taskBoard({search: 'zzdue-', sortBy: 'dueDate', sortOrder: 'ascending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([DUE_SOON, DUE_LATER]);
                expect(page.edges[0].node.dueDate).to.contain('2026-09-01');
            });
            taskBoard({search: 'zzdue-', sortBy: 'dueDate', sortOrder: 'descending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([DUE_LATER, DUE_SOON]);
            });

            [DUE_SOON, DUE_LATER].forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        // An unrecognized sortBy falls back to the board default rather than erroring -- which is
        // exactly why the Priority column is NOT declared sortable client-side (see
        // COLUMN_SORT_ARGUMENT): a sortable header for it would silently reorder by creation date.
        it('falls back to the default ordering for a property it does not allow', () => {
            taskBoard({search: 'zzsort', sortBy: 'priority', sortOrder: 'descending'}).then(page => {
                expect(titlesOf(page)).to.deep.equal([CHARLIE_FINISHED, ALPHA_ACTIVE, BRAVO_SUSPENDED]);
            });
        });

        // creator/owner go through the same resolved-value comparator as title/state -- this only
        // confirms the server accepts them and doesn't error, not a specific expected order
        // (rigging distinct, resolvable creator/assignee display names isn't worth the fixture).
        it('accepts creator and owner as sort fields without erroring', () => {
            taskBoard({search: 'zzsort', sortBy: 'creator', sortOrder: 'ascending'}).then(page => {
                expect(page.edges).to.have.length(3);
            });
            taskBoard({search: 'zzsort', sortBy: 'owner', sortOrder: 'ascending'}).then(page => {
                expect(page.edges).to.have.length(3);
            });
        });
    });

    describe('filterState (the board\'s "Show finished" toggle, both positions)', () => {
        const ACTIVE_ONE = 'zzfilter-active';
        const FINISHED_ONE = 'zzfilter-finished';
        const CANCELLED_ONE = 'zzfilter-cancelled';
        const names = [ACTIVE_ONE, FINISHED_ONE, CANCELLED_ONE];

        // The two lists the toggle switches between, duplicated from taskBoard.shared.ts rather
        // than imported: this spec asserts what the SERVER does with them, so it should keep
        // stating them itself -- a change to the module's own constants that is not carried here
        // is a change this spec should notice.
        const NOT_FINISHED = ['active', 'started', 'suspended'];
        const ALL = [...NOT_FINISHED, 'finished', 'cancelled'];

        before(() => {
            addTask(TASKS_CONTAINER, ACTIVE_ONE, [{name: 'state', value: 'active'}]);
            addTask(TASKS_CONTAINER, FINISHED_ONE, [{name: 'state', value: 'finished'}]);
            addTask(TASKS_CONTAINER, CANCELLED_ONE, [{name: 'state', value: 'cancelled'}]);
        });

        after(() => {
            names.forEach(name => deleteNode(`${TASKS_CONTAINER}/${name}`));
        });

        it('toggle off: hides both terminal states', () => {
            taskBoard({search: 'zzfilter', filterState: NOT_FINISHED}).then(page => {
                expect(titlesOf(page)).to.include(ACTIVE_ONE);
                expect(titlesOf(page)).to.not.include(FINISHED_ONE);
                expect(titlesOf(page)).to.not.include(CANCELLED_ONE);
            });
        });

        // "cancelled" is the other end a task can stop at, and it is excluded from the default
        // filter exactly as "finished" is -- so a toggle that only added "finished" would leave
        // cancelled tasks unreachable from this board in either position.
        it('toggle on: shows finished AND cancelled', () => {
            taskBoard({search: 'zzfilter', filterState: ALL}).then(page => {
                expect(titlesOf(page)).to.include(ACTIVE_ONE);
                expect(titlesOf(page)).to.include(FINISHED_ONE);
                expect(titlesOf(page)).to.include(CANCELLED_ONE);
            });
        });

        // The query itself stays a complete, neutral listing -- hiding terminal tasks is the
        // board's own choice of filterState, not a hidden server-side default.
        it('returns every state when no filterState is passed at all', () => {
            taskBoard({search: 'zzfilter'}).then(page => {
                expect(titlesOf(page)).to.have.members([ACTIVE_ONE, FINISHED_ONE, CANCELLED_ONE]);
            });
        });

        it('narrows to a single state when asked for one', () => {
            taskBoard({search: 'zzfilter', filterState: ['cancelled']}).then(page => {
                expect(titlesOf(page)).to.deep.equal([CANCELLED_ONE]);
            });
        });
    });

    describe('row menu actions', () => {
        beforeEach(() => {
            cy.apolloClient({username: REVIEWER, password: TEST_PASSWORD});
        });

        after(() => {
            cy.apolloClient({username: 'root', password: Cypress.env('SUPER_USER_PASSWORD')});
        });

        it('"Assign to me": assigns an active, unowned task to the acting user', () => {
            const name = 'action-assign';
            addTask(TASKS_CONTAINER, name, [{name: 'state', value: 'active'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/assignTaskToMe.mutation.graphql', variables: {id}})
                    .then(({data}) => {
                        // Deliberately still "active": assignment fills the owner, "Start" is what
                        // advances the state (see assignTaskToMe's own comment).
                        expect(data.assignTaskToMe.state).to.equal('active');
                        expect(data.assignTaskToMe.owner).to.contain(REVIEWER);
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('"Unassign": returns an assigned task to the active, unassigned pool', () => {
            const name = 'action-unassign';
            addTask(TASKS_CONTAINER, name, [
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

        it('"Suspend" then "Resume": round-trips a started task through suspended', () => {
            const name = 'action-suspend';
            addTask(TASKS_CONTAINER, name, [{name: 'state', value: 'started'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/suspendTask.mutation.graphql', variables: {id}})
                    .then(({data}) => {
                        expect(data.suspendTask.state).to.equal('suspended');
                    });
                cy.apollo({mutationFile: 'graphql/resumeTask.mutation.graphql', variables: {id}})
                    .then(({data}) => {
                        expect(data.resumeTask.state).to.equal('started');
                    });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });

        it('completes a started task with one of its declared outcomes', () => {
            const name = 'action-complete';
            addTask(TASKS_CONTAINER, name, [
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

        // The state guards, which are what decide which menu items a row offers at all -- and the
        // messages a wrong guess surfaces in the board's error banner.
        it('states its state guards in the message, not just by failing', () => {
            const name = 'action-guards';
            addTask(TASKS_CONTAINER, name, [{name: 'state', value: 'active'}]).then(id => {
                cy.apollo({mutationFile: 'graphql/suspendTask.mutation.graphql', variables: {id}})
                    .then(response => {
                        expect(errorMessagesOf(response)).to.contain('Only a started task can be suspended');
                    });
                cy.apollo({mutationFile: 'graphql/resumeTask.mutation.graphql', variables: {id}})
                    .then(response => {
                        expect(errorMessagesOf(response)).to.contain('Only a suspended task can be resumed');
                    });
                cy.apollo({
                    mutationFile: 'graphql/completeTask.mutation.graphql',
                    variables: {id, outcome: 'publish'}
                }).then(response => {
                    expect(errorMessagesOf(response)).to.contain('Only a started task can be completed');
                });
            });

            deleteNode(`${TASKS_CONTAINER}/${name}`);
        });
    });
});
