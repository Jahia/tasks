import {createSite, deleteSite, addNode} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';

// Drives the rendered UI rather than the GraphQL API, the same way task-ui.cy.ts does, and reaches
// the board the same way: the admin "My tasks" dashboard tile at /jahia/dashboard/tasks.
//
// The switcher is the one control whose effect is not visible in a GraphQL response at all -- both
// views ask the same taskBoard field, so what changes is only which document is sent and what is
// rendered from it. That makes this test the only place the two views are shown to be two views of
// the same tasks.
const CONTAINER = `/sites/${TEST_SITE_KEY}/contents/e2e-switcher-tasks`;

const TASK_TITLE = 'Switcher rotate the certificates';

describe('My Tasks board/list switcher (rendered UI, via the admin dashboard tile)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
        addNode({parentPathOrId: `/sites/${TEST_SITE_KEY}/contents`, primaryNodeType: 'jnt:tasks', name: 'e2e-switcher-tasks'});
        addNode({
            parentPathOrId: CONTAINER,
            primaryNodeType: 'jnt:task',
            name: 'ui-switcher-task',
            properties: [
                {name: 'jcr:title', value: TASK_TITLE, language: 'en'},
                {name: 'state', value: 'active'},
                {name: 'priority', value: 'high'}
            ]
        });
    });

    after(() => {
        deleteSite(TEST_SITE_KEY);
    });

    const openBoard = () => {
        cy.loginAndStoreSession('root', Cypress.env('SUPER_USER_PASSWORD'), '/start');
        cy.visit('/jahia/dashboard/tasks');
        // Waiting on the search box rather than on a card: it is in the toolbar, which renders
        // before the first page of tasks arrives, so this is the "the app is up" signal.
        cy.get('input[placeholder="Search tasks..."]', {timeout: 30000}).should('be.visible');
    };

    it('opens on the board, with Board the selected view', () => {
        openBoard();

        cy.get('.task-board__view[aria-pressed="true"]').should('have.text', 'Board');
        cy.get('.task-board__columns').should('be.visible');
        cy.get('.task-list').should('not.exist');
    });

    it('shows the same task as a table row once you switch to List', () => {
        openBoard();
        cy.get('input[placeholder="Search tasks..."]').type('Switcher rotate');
        cy.contains('.task-board__card', TASK_TITLE).should('be.visible');

        cy.contains('.task-board__view', 'List').click();

        // The cards are gone and the table has taken their place -- the search that was already in
        // the box still applies, which is the point of keeping the toolbar across the switch.
        cy.get('.task-board__columns').should('not.exist');
        cy.get('.task-list table', {timeout: 30000}).should('be.visible');
        cy.contains('.task-list tbody tr', TASK_TITLE).should('be.visible');
        // Not an exact row count: the dashboard lists the viewer's tasks across every site, so a
        // task another spec left behind would break a count without saying anything about the
        // switcher. What matters is that the search still narrows the list it switched into.
        cy.contains('.task-list tbody tr', 'Unrelated').should('not.exist');

        // The columns the board has no room for. Priority is list-only, which is why the fixture
        // sets it.
        cy.get('.task-list thead').within(() => {
            ['Task', 'Due', 'Priority', 'Waiting', 'Assigned to', 'State', 'Actions']
                .forEach(label => cy.contains(label).should('exist'));
        });
        cy.contains('.task-list tbody tr', TASK_TITLE).should('contain.text', 'High');
    });

    it('offers the same actions on a row as on a card', () => {
        openBoard();
        cy.get('input[placeholder="Search tasks..."]').type('Switcher rotate');
        cy.contains('.task-board__view', 'List').click();

        // Unassigned + active, so exactly one action -- the same one the card offers, because both
        // views render it from the same TaskActions component.
        cy.contains('.task-list tbody tr', TASK_TITLE).within(() => {
            cy.contains('button', 'Assign to me').should('be.visible');
        });
    });

    it('hides the board sort dropdown in the list, where the column headers sort instead', () => {
        openBoard();

        cy.contains('.task-board__sort', 'Sort by:').should('be.visible');

        cy.contains('.task-board__view', 'List').click();

        cy.get('.task-list table', {timeout: 30000}).should('be.visible');
        cy.get('.task-board__sort').should('not.exist');
    });

    it('remembers the chosen view across a reload', () => {
        openBoard();

        cy.contains('.task-board__view', 'List').click();
        cy.get('.task-list table', {timeout: 30000}).should('be.visible');

        cy.reload();

        // Painted straight into the list, never passing through the board: the stored choice is
        // read in the state initializer rather than in an effect.
        cy.get('.task-list table', {timeout: 30000}).should('be.visible');
        cy.get('.task-board__view[aria-pressed="true"]').should('have.text', 'List');
        cy.get('.task-board__columns').should('not.exist');
    });
});
