import '@jahia/cypress';
import '@jahia/cypress/dist/support/commands.js';
import {registerSupport} from '@jahia/cypress/dist/support/registerSupport.js';

registerSupport();

// Run-level cleanup: if a previous run crashed mid-suite and left its site behind,
// remove it before this run starts so re-runs stay idempotent (jahia-cypress-testing).
import {deleteSite} from '@jahia/cypress';
import {TEST_SITE_KEY} from './constants';

before(() => {
    deleteSite(TEST_SITE_KEY);
});
