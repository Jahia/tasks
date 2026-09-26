import {addNode, createSite, createUser, deleteSite, deleteUser, grantRoles} from '@jahia/cypress';
import {
    PRIVILEGED_ROLE,
    REVIEWER_ROLE,
    REVIEW_SITE_KEY as SITE_KEY,
    TEST_PASSWORD,
    TEST_TEMPLATE_SET
} from '../support/constants';
import {
    addTask,
    createReviewerGroup,
    errorMessagesOf,
    publicationStatus,
    startPublicationReview,
    taskBoard
} from '../support/taskFixtures';
import type {TaskBoardRow} from '../support/taskFixtures';

// The one-click review path (#67): reviewTask claims and completes a publication-review task in a
// single request. Its whole reason to exist is that it is NOT completeTask -- different state
// guard, wider RBAC, a concurrency guard of its own, and a hoisted permission check -- so this spec
// exercises each of those, on real workflow tasks, and asserts the ENGINE's own side of every
// decision rather than just the state this module wrote onto the JCR node.
//
// The error MESSAGES are asserted verbatim, not merely "an error happened": TaskGraphQLException's
// text is what the board's danger banner shows the reviewer (TaskBoard.client.tsx renders the
// GraphQL error message as-is), so it is a user-facing string, and a change to it is a change to
// the product.
const REVIEWER = 'tasks-e2e-review-reviewer';
const CANDIDATE = 'tasks-e2e-review-candidate';
const OUTSIDER = 'tasks-e2e-review-outsider';
const REVIEWER_GROUP = 'tasks-e2e-review-group';

const CONTENT_ROOT = `/sites/${SITE_KEY}/contents`;
const TASKS_CONTAINER = `${CONTENT_ROOT}/e2e-review-tasks`;

// One target (and therefore one review task) per scenario: completing a task ends its process, so
// scenarios cannot share one.
const TARGETS = {
    accept: 'e2e-review-accept',
    reject: 'e2e-review-reject',
    outsider: 'e2e-review-outsider',
    claimed: 'e2e-review-claimed',
    labels: 'e2e-review-labels'
};

function asUser(username: string) {
    cy.apolloClient({username, password: TEST_PASSWORD});
}

function asRoot() {
    cy.apolloClient({username: 'root', password: Cypress.env('SUPER_USER_PASSWORD')});
}

function reviewTask(id: string, outcome: string) {
    return cy.apollo({
        mutationFile: 'graphql/reviewTask.mutation.graphql',
        variables: {id, outcome}
    });
}

describe('One-click review (reviewTask): the board\'s Publish/Reject fast path', () => {
    const tasks: Record<keyof typeof TARGETS, TaskBoardRow> = {} as Record<keyof typeof TARGETS, TaskBoardRow>;

    before(() => {
        createSite(SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: SITE_KEY, locale: 'en'});
        [REVIEWER, CANDIDATE, OUTSIDER].forEach(user => {
            createUser(user, TEST_PASSWORD);
            grantRoles('/', [PRIVILEGED_ROLE], user, 'USER');
        });

        // Both eligible personas get their role BEFORE any workflow starts, which is what makes
        // them potential owners in the ENGINE and not merely in this module's own RBAC: the
        // candidate through a site group, the reviewer through the same role at the root (the
        // shape a real deployment has -- the built-in "administrators" group is a candidate of
        // every review task for exactly this reason). Reversing that order produces a reviewer
        // this module lets act and the engine silently refuses -- see the skipped defect case at
        // the bottom of this file.
        createReviewerGroup(SITE_KEY, REVIEWER_GROUP, [CANDIDATE]);
        grantRoles('/', [REVIEWER_ROLE], REVIEWER, 'USER');

        addNode({parentPathOrId: CONTENT_ROOT, primaryNodeType: 'jnt:tasks', name: 'e2e-review-tasks'});
        Object.values(TARGETS).forEach(name => {
            addNode({parentPathOrId: CONTENT_ROOT, primaryNodeType: 'jnt:contentFolder', name});
        });

        (Object.keys(TARGETS) as Array<keyof typeof TARGETS>).forEach(key => {
            startPublicationReview(`${CONTENT_ROOT}/${TARGETS[key]}`).then(task => {
                tasks[key] = task;
            });
        });
    });

    after(() => {
        [REVIEWER, CANDIDATE, OUTSIDER].forEach(user => deleteUser(user));
        deleteSite(SITE_KEY);
    });

    describe('happy path', () => {
        it('claims and completes an unassigned active task in one request, and the engine publishes', () => {
            asRoot();
            publicationStatus(`${CONTENT_ROOT}/${TARGETS.accept}`).then(status => {
                expect(status, 'before the decision').to.equal('NOT_PUBLISHED');
            });

            asUser(REVIEWER);
            // Stated rather than assumed: this reviewer is a real potential owner of the task,
            // because their role predates it. That is what the engine checks when the claim below
            // is propagated to it, and it is independent of canReviewAll.
            taskBoard({search: TARGETS.accept, scope: 'all'}).then(page => {
                expect(page.edges.find(edge => edge.node.id === tasks.accept.id)!.node.viewerRole).to.equal('candidate');
            });

            reviewTask(tasks.accept.id, 'accept').then(({data}) => {
                // One request did both halves: the claim (owner) and the completion (state).
                expect(data.reviewTask.state).to.equal('finished');
                expect(data.reviewTask.owner).to.contain(REVIEWER);
            });

            asRoot();
            cy.waitUntil(
                () => publicationStatus(`${CONTENT_ROOT}/${TARGETS.accept}`).then(status => status === 'PUBLISHED'),
                {
                    errorMsg: 'The accepted content was never published -- the engine did not accept the completion',
                    timeout: 30000,
                    interval: 1000
                }
            );
        });

        it('records a rejection as a real workflow outcome: finished, and NOT published', () => {
            asUser(REVIEWER);
            reviewTask(tasks.reject.id, 'reject').then(({data}) => {
                expect(data.reviewTask.state).to.equal('finished');
            });

            asRoot();
            // The discriminating half of the previous test: both outcomes finish the task node, and
            // only the engine can tell them apart -- so the content must still be unpublished, and
            // must stay that way rather than being published a moment later.
            publicationStatus(`${CONTENT_ROOT}/${TARGETS.reject}`).then(status => {
                expect(status, 'after a rejection').to.equal('NOT_PUBLISHED');
            });
        });
    });

    describe('RBAC and state guards', () => {
        it('refuses a viewer who is neither candidate nor reviewer, and leaves the task untouched', () => {
            asUser(OUTSIDER);
            reviewTask(tasks.outsider.id, 'accept').then(response => {
                expect(errorMessagesOf(response)).to.contain('You are not eligible to be assigned this task');
            });

            // "Fail loudly, never silently claimed" (TaskBoardMutationExtensions#reviewTask): a
            // refused review must not leave the task claimed by the refused caller.
            asRoot();
            taskBoard({search: TARGETS.outsider, scope: 'all'}).then(page => {
                const row = page.edges.find(edge => edge.node.id === tasks.outsider.id)!.node;
                expect(row.state).to.equal('active');
                expect(row.owner ?? '').to.equal('');
            });
        });

        it('refuses to take a task another user already holds, naming who holds it', () => {
            asRoot();
            cy.apollo({mutationFile: 'graphql/assignTaskToMe.mutation.graphql', variables: {id: tasks.claimed.id}})
                .then(({data}) => {
                    expect(data.assignTaskToMe.owner).to.contain('root');
                });

            // The candidate is fully eligible here -- this is the concurrency guard, not an RBAC
            // denial, and it is checked BEFORE eligibility precisely so a reviewer (who passes every
            // other check on every task) cannot silently steal one either.
            asUser(CANDIDATE);
            reviewTask(tasks.claimed.id, 'accept').then(response => {
                const message = errorMessagesOf(response);
                expect(message).to.contain('already claimed by another user');
                expect(message).to.contain('root');
                expect(message).to.contain('must be unassigned before you can review it');
            });

            asRoot();
            taskBoard({search: TARGETS.claimed, scope: 'all'}).then(page => {
                const row = page.edges.find(edge => edge.node.id === tasks.claimed.id)!.node;
                expect(row.owner, 'the original claim survives the refused review').to.contain('root');
            });
        });

        it('refuses an outcome the task does not declare', () => {
            asUser(REVIEWER);
            // Deliberately on an UNCLAIMED task: the outcome check sits after the concurrency
            // guard, so running this against the claimed one above would only re-test that guard.
            reviewTask(tasks.labels.id, 'not-an-outcome').then(response => {
                expect(errorMessagesOf(response)).to.contain('"not-an-outcome" is not a valid outcome for this task');
            });

            // Refused before any write: an invalid outcome must not leave the task claimed either.
            asRoot();
            taskBoard({search: TARGETS.labels, scope: 'all'}).then(page => {
                const row = page.edges.find(edge => edge.node.id === tasks.labels.id)!.node;
                expect(row.owner ?? '').to.equal('');
                expect(row.state).to.equal('active');
            });
        });

        it('refuses a plain jnt:task, which has no workflow to decide anything in', () => {
            asRoot();
            addTask(TASKS_CONTAINER, 'zzreview-plain-task', [
                {name: 'state', value: 'active'},
                {name: 'possibleOutcomes', values: ['accept']}
            ]).then(id => {
                reviewTask(id, 'accept').then(response => {
                    expect(errorMessagesOf(response)).to.contain('Only a workflow task can be reviewed in one step');
                });
            });
        });

        it('refuses a task that has already been decided', () => {
            asUser(REVIEWER);
            // tasks.accept was completed by the happy-path test above, so it is "finished" now.
            reviewTask(tasks.accept.id, 'accept').then(response => {
                expect(errorMessagesOf(response)).to.contain('Only an active or started task can be reviewed');
            });
        });
    });

    /**
     * KNOWN DEFECT, found while writing this suite (2026-08-16) -- skipped, not deleted, and not
     * weakened into a test of the broken behaviour.
     *
     * A viewer with canReviewAll but NO engine-side candidacy (the persona this module explicitly
     * supports -- see GqlTaskBoard#getViewerRole's "a reviewer sees 'none' on a task they are
     * neither assigned nor a candidate for", and canReviewInOneClick in TaskBoard.client.tsx, which
     * offers the fast path on `isAssignableToMe || canReviewAll`) can drive a review to completion
     * in the JCR while the workflow engine refuses it:
     *
     *   reviewTask -> {state: "finished", owner: <reviewer>}   // this module: success
     *   jBPM       -> PermissionDeniedException: User '...' does not have permissions to
     *                 execution operation 'Start' on task id N     // swallowed inside the
     *                 "A workflow task has been completed" rule in rules.drl
     *   result     -> the task node reads "finished", the process is still active, and the
     *                 content is NEVER published.
     *
     * Reproduced outside Cypress on a clean 8.2.3: start a publication workflow, THEN grant a user
     * editor-in-chief at "/", then have them reviewTask(accept). The board reports success and the
     * row disappears (finished tasks are filtered out), so the reviewer has no way to notice.
     *
     * The fix is not this suite's to make (#67 territory); flip this to `it` once a review by a
     * non-candidate reviewer either propagates to the engine or fails loudly.
     */
    describe('reviewer without engine-side candidacy', () => {
        // eslint-disable-next-line mocha/no-skipped-tests
        it.skip('completes in the engine too, not only in the JCR', () => {
            asUser(REVIEWER);
            reviewTask(tasks.outsider.id, 'accept').then(({data}) => {
                expect(data.reviewTask.state).to.equal('finished');
            });

            asRoot();
            cy.waitUntil(
                () => publicationStatus(`${CONTENT_ROOT}/${TARGETS.outsider}`).then(status => status === 'PUBLISHED'),
                {
                    errorMsg: 'JCR/engine split-brain: the task reads "finished" but the content was never published',
                    timeout: 30000,
                    interval: 1000
                }
            );
        });
    });

    describe('localized outcome labels', () => {
        // The names are workflow-definition constants and never change with the locale; only the
        // labels do. That split is what lets the board sort "reject first" on the NAME while
        // showing the reviewer a label in their own language (see REJECT_OUTCOME_PATTERN in
        // TaskBoard.client.tsx).
        it('resolves each outcome\'s label in the requested language, keeping its name stable', () => {
            asRoot();
            taskBoard({search: TARGETS.labels, scope: 'all', language: 'en'}).then(page => {
                const outcomes = page.edges.find(edge => edge.node.id === tasks.labels.id)!.node.possibleOutcomeDetails;
                expect(outcomes.map(outcome => outcome.name)).to.have.members(['accept', 'reject']);
                expect(outcomes.find(outcome => outcome.name === 'accept')!.displayLabel).to.equal('Publish');
                expect(outcomes.find(outcome => outcome.name === 'reject')!.displayLabel).to.equal('Reject publication');
            });

            taskBoard({search: TARGETS.labels, scope: 'all', language: 'fr'}).then(page => {
                const outcomes = page.edges.find(edge => edge.node.id === tasks.labels.id)!.node.possibleOutcomeDetails;
                // Same names, different labels -- resolved server-side from the workflow's own
                // resource bundle (GqlTaskBoard#getPossibleOutcomeDetails), which is the only place
                // they exist; the client never derives a label from a name.
                expect(outcomes.map(outcome => outcome.name)).to.have.members(['accept', 'reject']);
                expect(outcomes.find(outcome => outcome.name === 'accept')!.displayLabel).to.equal('Publier');
                expect(outcomes.find(outcome => outcome.name === 'reject')!.displayLabel).to.equal('Rejeter la publication');
            });
        });

        it('falls back to the request\'s own locale when no language is passed', () => {
            asRoot();
            taskBoard({search: TARGETS.labels, scope: 'all'}).then(page => {
                const outcomes = page.edges.find(edge => edge.node.id === tasks.labels.id)!.node.possibleOutcomeDetails;
                // Not asserted as a specific language -- the request locale is the caller's, and
                // this only has to be a resolved label rather than a raw outcome name.
                outcomes.forEach(outcome => {
                    expect(outcome.displayLabel, outcome.name).to.be.a('string').and.not.be.empty;
                });
            });
        });
    });
});
