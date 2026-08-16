import {addNode, createSite, deleteSite} from '@jahia/cypress';
import {runScopedName, UI_SITE_KEY as SITE_KEY, TEST_TEMPLATE_SET} from '../support/constants';
import {addTask, startPublicationReview} from '../support/taskFixtures';

// The only spec in this suite that renders anything: it drives the actual My Tasks screen, in a
// browser, through the admin dashboard tile at /jahia/dashboard/tasks (the adminRoute key 'tasks'
// registered in src/javascript/init.tsx, which deliberately replaces jahia-dashboard's own).
//
// What it asserts is the screen as it is NOW: a Moonstone DataTable (not the card list this spec
// used to describe), whose per-row actions live behind a hover/focus-revealed kebab menu, above
// scope tabs and a "Show finished" toggle, with a tabbed preview side panel (Preview / Details /
// Usages / History, #61). Every selector below is either a real class or id this module owns
// (task-board__*, task-board-preview-panel-*) or a role/label the component sets on purpose -- no
// Moonstone-internal class names, which would break on a component upgrade that changes nothing
// this spec is about.
const CONTENT_ROOT = `/sites/${SITE_KEY}/contents`;
const TASKS_CONTAINER = `${CONTENT_ROOT}/e2e-ui-tasks`;
// Per-run, for the same reason the schedule spec's target is (see runScopedName): the History tab
// asserted below reports the engine's processes for THIS node's path, and a fixed path would
// accumulate one finished process per previous run beside the one this run started.
const REVIEW_TARGET_NAME = runScopedName('e2e-ui-review-target');

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

// Distinguishes one search's network alias from the next within a spec run -- Cypress aliases are
// global, and reusing one would have a later cy.wait() match the earlier request.
let searchCount = 0;

/**
 * Narrows the board to one spec fixture, and does not return until that has actually HAPPENED.
 *
 * <p>Typing is only half of this interaction: the box is debounced (SEARCH_DEBOUNCE_MS) and the
 * filtering is SERVER-side, so ~350ms after the last keystroke the board fetches page 1 again and
 * re-renders the whole table. Until then the old, unfiltered rows are still on screen -- and they
 * satisfy assertions, can be found, and can even have their action menu opened. Whatever the test
 * grabbed in that window is then torn out from under it when the fetch lands, which surfaces as
 * Cypress's "we initially found matching element(s) ... they disappeared from the page" on the
 * click that follows (observed here on the row menu's "Assign to me").
 *
 * <p>So the settle is waited for on two independent signals, because neither alone is sound: the
 * board's own request, which proves the debounced fetch completed rather than merely guessing at a
 * duration; and the rendered rows, which proves the RE-RENDER for it has happened too and catches
 * the case where the debounce fired more than once (clear() and type() are separate value changes,
 * and a long term types for most of the debounce window). Rows are checked with "every row matches"
 * rather than a count, so the same helper serves the searches that expect an empty board.
 */
function search(term: string) {
    const alias = `boardSearch${searchCount++}`;
    // Registered BEFORE typing: cy.intercept only captures requests made after it is set up, which
    // is also what keeps it from matching the board's initial page load.
    cy.intercept('POST', '**/modules/graphql').as(alias);
    cy.get('input[placeholder="Search tasks..."]').clear().type(term);
    cy.wait(`@${alias}`);
    cy.get('#task-board-panel').should($panel => {
        // While the board is loading it renders a Loader INSTEAD of the table, so "no stale rows"
        // is trivially true mid-fetch -- the panel has to be shown to hold one of the two settled
        // outcomes (a table, or the empty state, which is the EmptyData carrying role="status")
        // before the row check below means anything.
        const isSettled = $panel.find('table').length > 0 || $panel.find('[role="status"]').length > 0;
        expect(isSettled, 'the board finished loading').to.equal(true);

        const rows = Array.from($panel.find('tbody tr'));
        const stale = rows.filter(row => !(row.textContent ?? '').includes(term));
        expect(stale, `rows not matching "${term}"`).to.have.length(0);
    });
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

// Opens the preview side panel on the workflow task's target. Every panel test starts here, so the
// "which of the two Preview items" subtlety is stated once: the menu offers "Preview" and "Preview
// in a new tab", and an unanchored substring match would pick whichever came first.
function openPreview() {
    search('Publication review');
    openRowMenu('Publication review');
    cy.contains('[role="menuitem"], li', 'Preview in a new tab').should('be.visible');
    cy.contains('[role="menuitem"], li', /^Preview$/).click();
    cy.get('.task-board__preview').should('be.visible');
}

// The panel's OWN tab strip. Scoped to the panel because the board's scope selector is a tablist
// too, and both are on screen while the panel is open.
function panelTabs() {
    return cy.get('.task-board__preview [role="tab"]');
}

function panelTab(label: string) {
    return cy.get('.task-board__preview').contains('[role="tab"]', label);
}

function selectPanelTab(label: string) {
    panelTab(label).click();
    panelTab(label).should('have.attr', 'aria-selected', 'true');
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
        openPreview();

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

    it('opens on the Preview tab, and offers the other three beside it', () => {
        openPreview();

        // Scoped to the panel: the board's own scope selector is a tablist too, and an unscoped
        // [role="tab"] would count all seven.
        panelTabs().should('have.length', 4);
        ['Preview', 'Details', 'Usages', 'History'].forEach(tab => {
            panelTab(tab).should('be.visible');
        });
        panelTab('Preview').should('have.attr', 'aria-selected', 'true');
        // Every tab points at the panel it controls, and that panel names it back.
        panelTab('Details').should('have.attr', 'aria-controls', 'task-board-preview-panel-details');
        cy.get('#task-board-preview-panel-details').should('have.attr', 'role', 'tabpanel');
    });

    it('answers about the reviewed content on the Details tab', () => {
        openPreview();
        selectPanelTab('Details');

        cy.get('#task-board-preview-panel-details').should('be.visible').within(() => {
            // Labelled rows, not raw JSON: the label is a <dt>, the value the <dd> beside it.
            cy.contains('dt', 'Content type').should('be.visible');
            cy.contains('dd', 'Content Folder').should('be.visible');
            cy.contains('dt', 'Path').should('be.visible');
            cy.contains('dd', `${CONTENT_ROOT}/${REVIEW_TARGET_NAME}`).should('be.visible');
            // aggregatedPublicationInfo is queryable on this provider, so the status row is there;
            // the target has never been published.
            cy.contains('dt', 'Publication status').should('be.visible');
            cy.contains('Not published').should('be.visible');
        });

        // The iframe survives a tab switch -- the panels are hidden, not unmounted, so coming back
        // to Preview does not re-request the page.
        cy.get('iframe.task-board__preview-frame').should('exist');
    });

    it('reports what references the reviewed content on the Usages tab', () => {
        openPreview();
        selectPanelTab('Usages');

        // Nothing points at this folder except the workflow task the panel was opened from, and
        // that one is filtered out server-side -- so the honest answer is the empty state.
        cy.get('#task-board-preview-panel-usages')
            .should('be.visible')
            .and('contain.text', 'No other content references this one.');
    });

    it('shows the running publication request on the History tab', () => {
        openPreview();
        selectPanelTab('History');

        cy.get('#task-board-preview-panel-history').should('be.visible').within(() => {
            cy.contains('h3', 'Workflow').should('be.visible');
            // The one fact that exists the moment a request is raised: who started what, when.
            // Neither activeTasks (due-dated steps only) nor history (ended steps only) carries it.
            cy.contains('started by root').should('be.visible');
            cy.contains('Running').should('be.visible');
        });
    });
});
