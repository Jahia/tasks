import {defineConfig} from 'cypress';
import {registerPlugins} from '@jahia/cypress/dist/plugins/registerPlugins.js';

export default defineConfig({
    reporter: 'junit',
    reporterOptions: {
        mochaFile: 'results/[hash].xml'
    },
    // Under results/, which is the one directory CI copies out of the container
    // (docker cp cypress:/home/jahians/results). Cypress's own default, cypress/screenshots, is
    // left behind with the container, so a failure that only a picture explains - a page that
    // rendered something other than what the selector wanted - arrives as a bare timeout.
    screenshotsFolder: './results/screenshots',
    e2e: {
        setupNodeEvents(on, config) {
            registerPlugins(on, config);
            return config;
        },
        specPattern: 'cypress/e2e/**/*.cy.ts',
        supportFile: 'cypress/support/e2e.ts'
    }
});
