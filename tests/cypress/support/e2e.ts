import '@jahia/cypress';
import '@jahia/cypress/dist/support/commands.js';
import {registerSupport} from '@jahia/cypress/dist/support/registerSupport.js';

registerSupport();

// Run-level cleanup: if a previous run crashed mid-suite and left a site behind, remove it before
// this run starts so re-runs stay idempotent (jahia-cypress-testing). Every site key the suite can
// create is listed in one place (constants.ts), so a spec that adds its own site does not also have
// to remember to add it here -- deleteSite is a no-op for a site that isn't there.
import {deleteSite} from '@jahia/cypress';
import {ALL_TEST_SITE_KEYS} from './constants';

before(() => {
    ALL_TEST_SITE_KEYS.forEach(siteKey => deleteSite(siteKey));
});
