import {addNode, createSite, createUser, deleteSite, deleteUser, getUserPath, grantRoles} from '@jahia/cypress';
import {
    PRIVILEGED_ROLE,
    REVIEWER_ROLE,
    TEST_PASSWORD,
    VISIBILITY_SITE_KEY as SITE_KEY,
    TEST_TEMPLATE_SET
} from '../support/constants';
import {
    addTask,
    createReviewerGroup,
    publicationStatus,
    rowById,
    siteGroupPath,
    startPublicationReview,
    taskBoard,
    taskCandidates,
    titlesOf
} from '../support/taskFixtures';
import type {TaskBoardRow} from '../support/taskFixtures';

// Who sees which task, and as what -- the visibility half of the board's contract
// (TaskBoardQueryExtensions#buildQueryPlan + GqlTaskBoard#getViewerRole), exercised against four
// personas at once so each assertion is a comparison rather than a single reading.
//
// The GROUP CANDIDATE persona is the reason this spec exists in its current form: its candidacy is
// created the way production creates it (a role granted to a site group, then a real publication
// workflow started on content of that site), not by writing a `candidates` property through the
// JCR -- see startPublicationReview in support/taskFixtures.ts for what that shortcut costs.
const CONTRIBUTOR = 'tasks-e2e-vis-contributor';
const GROUP_MEMBER = 'tasks-e2e-vis-groupmember';
const REVIEWER = 'tasks-e2e-vis-reviewer';
const BYSTANDER = 'tasks-e2e-vis-bystander';
const REVIEWER_GROUP = 'tasks-e2e-vis-reviewers';

const TASKS_CONTAINER = `/sites/${SITE_KEY}/contents/e2e-visibility-tasks`;
const REVIEW_TARGET = `/sites/${SITE_KEY}/contents/e2e-visibility-target`;

// Titles are prefixed so every assertion below can scope the (deliberately repo-wide, see
// TaskBoardQueryExtensions' Phase 4 note) query down to this spec's own rows with `search`.
const PREFIX = 'zzvis';
const CONTRIBUTOR_TASK = `${PREFIX}-owned-by-contributor`;
const CREATED_TASK = `${PREFIX}-created-by-contributor`;
const OTHER_TASK = `${PREFIX}-owned-by-nobody-relevant`;

type UserPathResponse = {data: {admin: {userAdmin: {user: {node: {path: string}}}}}};

function asUser(username: string) {
    cy.apolloClient({username, password: TEST_PASSWORD});
}

function asRoot() {
    cy.apolloClient({username: 'root', password: Cypress.env('SUPER_USER_PASSWORD')});
}

describe('Task board visibility scoping (who sees which task, and as what)', () => {
    // The workflow task the group candidate is eligible for, resolved once in before() and reused:
    // starting a publication workflow per test would create a second review task for the same
    // content and make "the" task ambiguous.
    let reviewTask: TaskBoardRow;

    before(() => {
        createSite(SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: SITE_KEY, locale: 'en'});
        [CONTRIBUTOR, GROUP_MEMBER, REVIEWER, BYSTANDER].forEach(user => {
            createUser(user, TEST_PASSWORD);
            // Without jcr:read_default nothing below can read a task node at all, whatever its
            // eligibility -- see PRIVILEGED_ROLE in constants.ts.
            grantRoles('/', [PRIVILEGED_ROLE], user, 'USER');
        });
        // The contributor persona: "editor" on this site, which is what lets them create content
        // (and therefore tasks) here at all. Deliberately a role WITHOUT publish, so it does not
        // also make them a workflow-review candidate -- asserted below rather than assumed.
        grantRoles(`/sites/${SITE_KEY}`, ['editor'], CONTRIBUTOR, 'USER');

        // The group persona: the review role held by a GROUP, on this site -- the grant that makes
        // the engine treat the group as a potential owner of the review task started below. It has
        // to be in place BEFORE the workflow starts; that ordering is the whole fixture.
        createReviewerGroup(SITE_KEY, REVIEWER_GROUP, [GROUP_MEMBER]);

        addNode({parentPathOrId: `/sites/${SITE_KEY}/contents`, primaryNodeType: 'jnt:tasks', name: 'e2e-visibility-tasks'});
        addNode({parentPathOrId: `/sites/${SITE_KEY}/contents`, primaryNodeType: 'jnt:contentFolder', name: 'e2e-visibility-target'});

        // One plain task assigned to the contributor, one assigned to nobody. Jahia shards user
        // nodes into hashed subfolders (/users/cd/hc/dg/<name>), and assigneeUserKey is matched
        // against JahiaUser#getUserKey(), which IS that path -- so it has to be resolved, never
        // guessed.
        getUserPath(CONTRIBUTOR).then(({data}: UserPathResponse) => {
            addTask(TASKS_CONTAINER, CONTRIBUTOR_TASK, [
                {name: 'state', value: 'active'},
                {name: 'assigneeUserKey', value: data.admin.userAdmin.user.node.path}
            ]);
        });
        addTask(TASKS_CONTAINER, OTHER_TASK, [{name: 'state', value: 'active'}]);

        startPublicationReview(REVIEW_TARGET).then(task => {
            reviewTask = task;
        });

        // The reviewer persona is granted its role AFTER the workflow has started, and that is not
        // incidental: the engine resolves a task's potential owners once, when it creates the task,
        // from the review role held on the content at that moment. Granting the same role before
        // the start would make this persona a real candidate of the very task it is here to
        // observe as an outsider -- which is exactly what the "reviewer sees 'none'" and "a
        // reviewer's claimable is empty" cases below would then be quietly failing to test.
        grantRoles('/', [REVIEWER_ROLE], REVIEWER, 'USER');
    });

    after(() => {
        [CONTRIBUTOR, GROUP_MEMBER, REVIEWER, BYSTANDER].forEach(user => deleteUser(user));
        deleteSite(SITE_KEY);
    });

    // Asserted before anything keys on it: if the engine did not register the group, every
    // candidate expectation below is meaningless, and this is the assertion that says so out loud.
    it('registers the site group as a real, engine-written candidate of the review task', () => {
        asRoot();
        expect(reviewTask.taskType).to.equal('jnt:workflowTask');
        taskCandidates(reviewTask.id).then(candidates => {
            expect(candidates, 'engine-written candidates').to.include(siteGroupPath(SITE_KEY, REVIEWER_GROUP));
        });
        // The task node itself lives in the initiator's own user space, which is what makes the
        // candidate's access a real ACL question rather than a side effect of where it sits.
        cy.apollo({
            queryFile: 'graphql/taskCandidates.query.graphql',
            fetchPolicy: 'no-cache',
            variables: {id: reviewTask.id}
        }).then(({data}) => {
            expect(data.jcr.nodeById.path).to.contain('/workflowTasks/');
        });
    });

    describe('the matrix', () => {
        it('a contributor sees the tasks they own or created, and not unrelated ones', () => {
            // Created by the contributor themselves -- the jcr:createdBy half of the visibility
            // clause, which is the only way a contributor sees a task nobody assigned them.
            asUser(CONTRIBUTOR);
            addTask(TASKS_CONTAINER, CREATED_TASK, [{name: 'state', value: 'active'}]);

            taskBoard({search: PREFIX, scope: 'all'}).then(page => {
                const visible = titlesOf(page);
                // Assigned to them (assigneeUserKey) and created by them (jcr:createdBy).
                expect(visible).to.include(CONTRIBUTOR_TASK);
                expect(visible).to.include(CREATED_TASK);
                // Created by root, assigned to nobody, offered to nobody: none of the three
                // branches match, so it stays invisible even though it sits in the same folder.
                expect(visible).to.not.include(OTHER_TASK);
            });

            // And "editor" really is a role without candidacy: the contributor can create the
            // content a review is about without thereby becoming eligible to review it.
            taskBoard({scope: 'all'}).then(page => {
                expect(rowById(page, reviewTask.id), 'the review task is not a contributor concern').to.be.undefined;
            });
        });

        it('a group candidate sees the review task their group is eligible for', () => {
            asUser(GROUP_MEMBER);
            taskBoard({scope: 'all'}).then(page => {
                const row = rowById(page, reviewTask.id);
                expect(row, 'the review task is visible to the group candidate').to.not.be.undefined;
                expect(row!.viewerRole).to.equal('candidate');
                expect(row!.isAssignableToMe).to.equal(true);
                expect(row!.candidateDisplayNames).to.include(REVIEWER_GROUP);
            });

            // ...and nothing else: the two plain tasks are neither theirs nor offered to them.
            taskBoard({search: PREFIX, scope: 'all'}).then(page => {
                expect(titlesOf(page)).to.have.length(0);
            });
        });

        it('a reviewer sees every task, including ones they are neither assigned nor a candidate for', () => {
            asUser(REVIEWER);
            cy.apollo({queryFile: 'graphql/viewer.query.graphql', fetchPolicy: 'no-cache'}).then(({data}) => {
                expect(data.taskBoardCanReviewAll).to.equal(true);
            });

            taskBoard({search: PREFIX, scope: 'all'}).then(page => {
                expect(titlesOf(page)).to.include(CONTRIBUTOR_TASK);
                expect(titlesOf(page)).to.include(OTHER_TASK);
            });

            taskBoard({scope: 'all'}).then(page => {
                const row = rowById(page, reviewTask.id);
                expect(row, 'the review task is visible to the reviewer').to.not.be.undefined;
                // viewerRole is deliberately independent of canReviewAll (GqlTaskBoard#getViewerRole):
                // this reviewer may act on the task while relating to it in no way at all.
                expect(row!.viewerRole).to.equal('none');
                expect(row!.isAssignableToMe).to.equal(false);
            });
        });

        it('a logged-in user with no involvement sees nothing', () => {
            asUser(BYSTANDER);
            cy.apollo({queryFile: 'graphql/viewer.query.graphql', fetchPolicy: 'no-cache'}).then(({data}) => {
                expect(data.taskBoardCanReviewAll).to.equal(false);
            });
            taskBoard({scope: 'all'}).then(page => {
                expect(page.pageInfo.totalCount).to.equal(0);
                expect(page.edges).to.have.length(0);
            });
        });

        it('guest sees no tasks at all', () => {
            // Sent as a raw, credential-less request rather than through cy.apolloClient: that
            // helper falls back to root's Basic auth whenever no username is given, so there is no
            // way to BE the guest through it.
            //
            // Two legitimate outcomes, both of which are "guest sees nothing": the module's own
            // guest branch returns an empty page (TaskBoardQueryExtensions#taskBoard), while the
            // platform's GraphQL security filter may refuse the field before that code is reached
            // at all (it does on a stock 8.2.3 -- "Permission denied"). Which one applies is a
            // deployment's own configuration, so the assertion is on the outcome both share.
            cy.clearCookies();
            cy.fixture('graphql/taskBoard.query.graphql').then(query => {
                cy.request({
                    method: 'POST',
                    url: '/modules/graphql',
                    body: {query, variables: {first: 10, scope: 'all'}},
                    failOnStatusCode: false
                }).then(response => {
                    const page = response.body?.data?.taskBoard;
                    if (page) {
                        expect(page.edges, 'guest page').to.have.length(0);
                    } else {
                        expect(response.body?.errors, 'guest is refused outright').to.have.length.greaterThan(0);
                    }
                });
            });
            asRoot();
        });
    });

    describe('the scope argument', () => {
        // These assert on THIS spec's own review task rather than on the size of each page: the
        // board query is repo-wide (see TaskBoardQueryExtensions' Phase 4 note) and a
        // jnt:workflowTask outlives the site it was started from -- it lives in the initiator's
        // user space -- so a previous run's leftovers are rows a correct implementation is supposed
        // to return. Counting them would make this spec fail for being run twice.
        it('"claimable" keeps only unassigned tasks the viewer is a candidate for', () => {
            asUser(GROUP_MEMBER);
            taskBoard({scope: 'claimable'}).then(page => {
                expect(page.edges.map(edge => edge.node.id)).to.include(reviewTask.id);
                page.edges.forEach(({node}) => {
                    expect(node.viewerRole, `${node.title} in claimable`).to.equal('candidate');
                    expect(node.owner ?? '', `${node.title} owner`).to.equal('');
                });
            });
        });

        it('"assignedToMe" does not include a task merely offered to the viewer', () => {
            asUser(GROUP_MEMBER);
            taskBoard({scope: 'assignedToMe'}).then(page => {
                // Being offered a task is not holding it -- the whole point of the two scopes.
                expect(page.edges.map(edge => edge.node.id)).to.not.include(reviewTask.id);
                page.edges.forEach(({node}) => {
                    expect(node.viewerRole, `${node.title} in assignedToMe`).to.equal('assignee');
                });
            });
        });

        it('a reviewer with no candidacy of their own gets no claimable task', () => {
            asUser(REVIEWER);
            taskBoard({scope: 'claimable'}).then(page => {
                // Being able to act on every task is not the same as being eligible to take one:
                // this reviewer's role was granted after the task was created, so the engine never
                // listed them among its potential owners.
                expect(page.edges).to.have.length(0);
            });
        });

        it('"all" is the widest view each viewer is entitled to, never a wider one', () => {
            asUser(REVIEWER);
            taskBoard({search: PREFIX, scope: 'all'}).then(reviewerPage => {
                asUser(BYSTANDER);
                taskBoard({search: PREFIX, scope: 'all'}).then(bystanderPage => {
                    expect(reviewerPage.pageInfo.totalCount).to.be.greaterThan(0);
                    expect(bystanderPage.pageInfo.totalCount).to.equal(0);
                });
            });
        });
    });

    describe('viewerRole transitions', () => {
        it('goes candidate -> assignee on assign, and back to candidate on unassign', () => {
            asUser(GROUP_MEMBER);
            taskBoard({scope: 'all'}).then(page => {
                expect(rowById(page, reviewTask.id)!.viewerRole).to.equal('candidate');
            });

            cy.apollo({mutationFile: 'graphql/assignTaskToMe.mutation.graphql', variables: {id: reviewTask.id}})
                .then(({data}) => {
                    expect(data.assignTaskToMe.owner).to.not.be.empty;
                });

            taskBoard({scope: 'all'}).then(page => {
                const row = rowById(page, reviewTask.id)!;
                expect(row.viewerRole).to.equal('assignee');
                // Claiming moves it between the two scopes without changing its state: it is now
                // held, so it is no longer claimable.
                expect(row.state).to.equal('active');
            });
            taskBoard({scope: 'assignedToMe'}).then(page => {
                expect(page.edges.map(edge => edge.node.id)).to.include(reviewTask.id);
            });
            taskBoard({scope: 'claimable'}).then(page => {
                expect(page.edges.map(edge => edge.node.id)).to.not.include(reviewTask.id);
            });

            cy.apollo({mutationFile: 'graphql/unassignTask.mutation.graphql', variables: {id: reviewTask.id}});

            taskBoard({scope: 'all'}).then(page => {
                // Back to candidate, not to "none": the group's candidacy never went anywhere.
                expect(rowById(page, reviewTask.id)!.viewerRole).to.equal('candidate');
            });
            taskBoard({scope: 'claimable'}).then(page => {
                expect(page.edges.map(edge => edge.node.id)).to.include(reviewTask.id);
            });
        });
    });

    // Last, because it ends the process: the run-through that proves the engine accepted a
    // completion made by a group candidate, rather than this module merely writing "finished" onto
    // a node the workflow has never heard of.
    describe('a group candidate can really complete the task (no JCR/engine split-brain)', () => {
        it('publishes the content under review when the candidate accepts it', () => {
            asRoot();
            publicationStatus(REVIEW_TARGET).then(status => {
                expect(status, 'before the decision').to.equal('NOT_PUBLISHED');
            });

            asUser(GROUP_MEMBER);
            cy.apollo({
                mutationFile: 'graphql/reviewTask.mutation.graphql',
                variables: {id: reviewTask.id, outcome: 'accept'}
            }).then(({data}) => {
                expect(data.reviewTask.state).to.equal('finished');
                expect(data.reviewTask.owner).to.contain(GROUP_MEMBER);
            });

            asRoot();
            // The engine's own side of the decision. Had the candidacy been faked through the JCR,
            // jBPM would have denied the completion and this would still read NOT_PUBLISHED while
            // the task node claimed to be finished.
            cy.waitUntil(
                () => publicationStatus(REVIEW_TARGET).then(status => status === 'PUBLISHED'),
                {
                    errorMsg: 'The reviewed content was never published -- the engine did not accept the completion',
                    timeout: 30000,
                    interval: 1000
                }
            );
        });
    });
});
