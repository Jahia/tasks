import {addNode, createSite, deleteSite} from '@jahia/cypress';
import {UI_SITE_KEY as SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';
import {addTask, startPublicationReview} from '../support/taskFixtures';

// The only spec in this suite that renders anything: it drives the actual My Tasks screen, in a
// browser, through the admin dashboard tile at /jahia/dashboard/tasks (the adminRoute key 'tasks'
// registered in src/javascript/init.tsx, which deliberately replaces jahia-dashboard's own).
//
// What it asserts is the screen as it is NOW: a Moonstone DataTable (not the card list this spec
// used to describe), whose per-row actions live behind a hover/focus-revealed kebab menu, above
// scope tabs and a "Show finished" toggle, with a preview side panel. Every selector below is
// either a real class this module owns (task-board__*) or a role/label the component sets on
// purpose -- no Moonstone-internal class names, which would break on a component upgrade that
// changes nothing this spec is about.
const CONTENT_ROOT = `/sites/${SITE_KEY}/contents`;
const TASKS_CONTAINER = `${CONTENT_ROOT}/e2e-ui-tasks`;
const REVIEW_TARGET_NAME = 'e2e-ui-review-target';

// Created oldest-first, so the board's default ordering (newest created first) is the REVERSE of
// this list -- which is what makes the ordering assertion below say something.
const OLDEST = 'zzui Renew the SSL certificate';
const MIDDLE = 'zzui Unrelated onboarding task';
const NEWEST = 'zzui Rotate the backup credentials';
const FINISHED = 'zzui Ship the release notes';

// The kebab button in a row's Actions cell. It is transparent (opacity: 0) until its row is
// hovered or focused, so every interaction with it goes through .focus() first -- which triggers
// the same `tr:focus-within` rule a keyboard user gets, rather than forcing a click on something
// no user could see.
const KEBAB = '.task-board__row-actions button';

function openBoard() {
    cy.loginAndStoreSession('root', Cypress.env('SUPER_USER_PASSWORD'), '/start');
    cy.visit('/jahia/dashboard/tasks');
    // The route mounts, then fetches its own first page; the search box only exists once the board
    // itself has rendered, so waiting for it is waiting for a real board.
    cy.get('input[placeholder="Search tasks..."]', {timeout: 60000}).should('be.visible');
}

// Narrows the board to one spec fixture. The box is debounced server-side (SEARCH_DEBOUNCE_MS),
// so callers assert on the table afterwards rather than on the typing.
function search(term: string) {
    cy.get('input[placeholder="Search tasks..."]').clear().type(term);
}

function rowFor(title: string) {
    return cy.contains('tbody tr', title);
}

// Opens one row's action menu. The "not be disabled" wait is load-bearing rather than defensive:
// every action re-fetches the page underneath the row (handleAction -> loadPage), and the kebab is
// disabled for as long as that row is busy -- so a menu opened straight after a previous action
// races the reload it triggered.
function openRowMenu(title: string) {
    rowFor(title).find(KEBAB).should('not.be.disabled').focus().click();
}

describe('My Tasks screen (rendered UI, via the admin dashboard tile)', () => {
    before(() => {
        createSite(SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: SITE_KEY, locale: 'en'});
        addNode({parentPathOrId: CONTENT_ROOT, primaryNodeType: 'jnt:tasks', name: 'e2e-ui-tasks'});
        addNode({parentPathOrId: CONTENT_ROOT, primaryNodeType: 'jnt:contentFolder', name: REVIEW_TARGET_NAME});

        addTask(TASKS_CONTAINER, OLDEST, [{name: 'state', value: 'active'}, {name: 'priority', value: 'high'}]);
        addTask(TASKS_CONTAINER, MIDDLE, [{name: 'state', value: 'active'}]);
        addTask(TASKS_CONTAINER, NEWEST, [{name: 'state', value: 'active'}]);
        addTask(TASKS_CONTAINER, FINISHED, [{name: 'state', value: 'finished'}]);

        // A real workflow task, so the preview panel has a target to show: a plain jnt:task has no
        // targetNode at all, and the two Preview actions are only offered when one resolves.
        startPublicationReview(`${CONTENT_ROOT}/${REVIEW_TARGET_NAME}`);
    });

    after(() => {
        deleteSite(SITE_KEY);
    });

    beforeEach(() => {
        openBoard();
    });

    it('renders the board as a table with the columns the reviewer triages on', () => {
        ['Task', 'Due', 'Priority', 'Waiting', 'Owner', 'State', 'Actions'].forEach(column => {
            cy.contains('th', column).should('be.visible');
        });

        search('zzui Renew');
        rowFor(OLDEST).within(() => {
            // The Task cell stacks the title with the created-by line; Owner and State are their
            // own cells, and priority is carried by the WORD, never by weight alone.
            cy.contains('.task-board__task-cell', OLDEST).should('be.visible');
            cy.contains('.task-board__meta', 'Created by:').should('be.visible');
            cy.contains('High').should('be.visible');
            cy.contains('Unassigned').should('be.visible');
            cy.contains('Active').should('be.visible');
        });
    });

    it('filters the table live as you type in the search box', () => {
        search('SSL');
        rowFor(OLDEST).should('be.visible');
        cy.contains('tbody tr', MIDDLE).should('not.exist');
    });

    it('opens on the newest-created task first', () => {
        search('zzui');
        // Every fixture task matches, and the board's default sort is jcr:created descending
        // (DEFAULT_SORT_BY/ORDER) -- so the reverse of the creation order above. The finished one
        // is absent: the "Show finished" toggle starts off.
        cy.get('tbody tr').should('have.length', 3);
        cy.get('tbody tr').eq(0).should('contain.text', NEWEST);
        cy.get('tbody tr').eq(1).should('contain.text', MIDDLE);
        cy.get('tbody tr').eq(2).should('contain.text', OLDEST);
    });

    it('keeps every row action behind the row\'s kebab menu, and runs one from it', () => {
        search('Rotate the backup credentials');

        // Nothing is offered up front: the Actions cell holds one icon button and no visible verbs.
        rowFor(NEWEST).within(() => {
            cy.contains('button', 'Assign to me').should('not.exist');
        });

        // Unassigned + active offers exactly one primary action.
        openRowMenu(NEWEST);
        cy.contains('[role="menuitem"], li', 'Assign to me').click();

        // Assigning fills the owner and leaves the state "active" (see assignTaskToMe's own
        // comment); the menu's contents follow, offering the next step instead.
        rowFor(NEWEST).should('not.contain.text', 'Unassigned');
        openRowMenu(NEWEST);
        cy.contains('[role="menuitem"], li', 'Assign to me').should('not.exist');
        cy.contains('[role="menuitem"], li', 'Unassign').should('be.visible');
        cy.contains('[role="menuitem"], li', 'Start').click();

        rowFor(NEWEST).should('contain.text', 'Started');
        openRowMenu(NEWEST);
        cy.contains('[role="menuitem"], li', 'Suspend').should('be.visible');
        // A started plain task with no declared outcomes still has a way to be finished.
        cy.contains('[role="menuitem"], li', 'Complete').should('be.visible');
    });

    it('switches scope with the tabs, and each empty scope says what it means', () => {
        // The board always opens on "All tasks" (INITIAL_SCOPE), whoever is looking.
        cy.get('[role="tab"]').should('have.length', 3);
        cy.contains('[role="tab"]', 'All tasks').should('have.attr', 'aria-selected', 'true');

        cy.contains('[role="tab"]', 'Available to my group(s)').click();
        cy.contains('[role="tab"]', 'Available to my group(s)').should('have.attr', 'aria-selected', 'true');
        // root is a member of the administrators group, which every publication review lists as a
        // candidate -- so this scope is not empty, and the row that is there is the workflow task.
        cy.get('#task-board-panel').should('exist');
        cy.contains('tbody tr', 'Publication review').should('be.visible');

        cy.contains('[role="tab"]', 'Assigned to me').click();
        search('zzui Unrelated');
        // Nothing here is assigned to root, and the empty state says THAT rather than "no tasks".
        cy.contains('No tasks are assigned to you.').should('be.visible');
    });

    it('reveals terminal tasks only when "Show finished" is on', () => {
        search('Ship the release notes');
        cy.contains('No tasks to show.').should('be.visible');

        cy.get('#task-board-show-finished').click({force: true});

        rowFor(FINISHED).should('be.visible').and('contain.text', 'Finished');

        cy.get('#task-board-show-finished').click({force: true});
        cy.contains('tbody tr', FINISHED).should('not.exist');
    });

    it('previews the content under review beside the board, and closes again', () => {
        search('Publication review');

        openRowMenu('Publication review');
        cy.contains('[role="menuitem"], li', 'Preview in a new tab').should('be.visible');
        // Anchored, because the menu offers two items starting with "Preview" and a substring match
        // would pick whichever came first.
        cy.contains('[role="menuitem"], li', /^Preview$/).click();

        cy.get('.task-board__preview').should('be.visible').within(() => {
            // The panel names both what it shows and the task it was opened for, and it is a
            // dialog that does not claim to be modal (the board behind it stays usable).
            cy.contains('Task:').should('be.visible');
            cy.get('iframe.task-board__preview-frame').should('exist');
        });
        cy.get('.task-board__preview').should('have.attr', 'role', 'dialog');

        cy.get('[aria-label="Close preview"]').click();
        cy.get('.task-board__preview').should('not.exist');
    });
});
