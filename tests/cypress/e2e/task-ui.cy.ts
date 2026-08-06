import {createSite, deleteSite, addNode} from '@jahia/cypress';
import {TEST_SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';

// Unlike every other spec in this suite (task-board/task-detail/task-list-create/
// task-schedule-workflow), which drive the GraphQL API directly via cy.apollo() and never
// render anything, this test actually cy.visit()s a real page and interacts with the rendered
// React UI -- so you can watch the app under test in Cypress's right-hand pane.
//
// The task board is reached via the admin "My tasks" dashboard tile at /jahia/dashboard/tasks
// (confirmed by hand, not guessed -- the internal adminRoute key 'tasks' registered in
// src/javascript/init.tsx resolves to this URL under the app-shell's own routing).
//
// A UI test for the detail view (TaskDetail.client.tsx, with its Suspend/Cancel/Complete
// buttons) is intentionally not included yet: TaskBoard's cards have no click-to-navigate to
// it (no onClick on .task-board__card in TaskBoard.client.tsx), and jContent's own content
// browser can't render it either -- its live preview iframe only activates for jnt:page nodes
// or nodes with the jmix:mainResource mixin (ContentRoute.jsx), neither of which a plain
// jnt:task is. Add that test once there's a confirmed real entry point to the rendered detail
// view.
const CONTAINER = `/sites/${TEST_SITE_KEY}/contents/e2e-ui-tasks`;

describe('Task board search (rendered UI, via the admin dashboard tile)', () => {
    before(() => {
        createSite(TEST_SITE_KEY, {templateSet: TEST_TEMPLATE_SET, serverName: TEST_SITE_KEY, locale: 'en'});
        addNode({parentPathOrId: `/sites/${TEST_SITE_KEY}/contents`, primaryNodeType: 'jnt:tasks', name: 'e2e-ui-tasks'});
        addNode({
            parentPathOrId: CONTAINER,
            primaryNodeType: 'jnt:task',
            name: 'ui-search-match',
            properties: [
                {name: 'jcr:title', value: 'Renew the SSL certificate', language: 'en'},
                {name: 'state', value: 'active'}
            ]
        });
        addNode({
            parentPathOrId: CONTAINER,
            primaryNodeType: 'jnt:task',
            name: 'ui-search-nomatch',
            properties: [
                {name: 'jcr:title', value: 'Unrelated onboarding task', language: 'en'},
                {name: 'state', value: 'active'}
            ]
        });
        addNode({
            parentPathOrId: CONTAINER,
            primaryNodeType: 'jnt:task',
            name: 'ui-action-task',
            properties: [
                {name: 'jcr:title', value: 'Rotate the backup credentials', language: 'en'},
                {name: 'state', value: 'active'}
            ]
        });
    });

    after(() => {
        deleteSite(TEST_SITE_KEY);
    });

    it('filters the board live as you type in the search box', () => {
        cy.loginAndStoreSession('root', Cypress.env('SUPER_USER_PASSWORD'), '/start');
        cy.visit('/jahia/dashboard/tasks');

        cy.get('input[placeholder="Search tasks..."]', {timeout: 30000}).type('SSL');

        cy.contains('.task-board__card', 'Renew the SSL certificate').should('be.visible');
        cy.contains('.task-board__card', 'Unrelated onboarding task').should('not.exist');
    });

    it('assigns a task to yourself and starts it, live from the board buttons', () => {
        cy.loginAndStoreSession('root', Cypress.env('SUPER_USER_PASSWORD'), '/start');
        cy.visit('/jahia/dashboard/tasks');

        cy.get('input[placeholder="Search tasks..."]', {timeout: 30000}).type('Rotate the backup credentials');

        // Unassigned + active starts with just one action: Assign to me.
        cy.contains('.task-board__card', 'Rotate the backup credentials')
            .should('contain.text', 'Owner: Unassigned')
            .within(() => {
                cy.contains('button', 'Assign to me').click();
            });

        // Assigning leaves state "active" but fills the owner -- Assign to me is replaced by
        // Unassign + Start.
        cy.contains('.task-board__card', 'Rotate the backup credentials')
            .should('not.contain.text', 'Owner: Unassigned')
            .within(() => {
                cy.contains('button', 'Assign to me').should('not.exist');
                cy.contains('button', 'Unassign').should('be.visible');
                cy.contains('button', 'Start').click();
            });

        // Started -- Start is replaced by Suspend, and the state chip flips to Started.
        cy.contains('.task-board__card', 'Rotate the backup credentials')
            .should('contain.text', 'Started')
            .within(() => {
                cy.contains('button', 'Start').should('not.exist');
                cy.contains('button', 'Suspend').should('be.visible');
            });
    });
});
