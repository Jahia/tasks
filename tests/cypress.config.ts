import {defineConfig} from 'cypress';
import registerJahiaPlugins from '@jahia/cypress/dist/plugins/index.js';

export default defineConfig({
    reporter: 'junit',
    reporterOptions: {
        mochaFile: 'results/[hash].xml'
    },
    e2e: {
        setupNodeEvents(on, config) {
            return registerJahiaPlugins(on, config);
        },
        specPattern: 'cypress/e2e/**/*.cy.ts',
        supportFile: 'cypress/support/e2e.ts'
    }
});
