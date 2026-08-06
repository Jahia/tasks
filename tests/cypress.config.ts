import {defineConfig} from 'cypress';
import {registerPlugins} from '@jahia/cypress/dist/plugins/registerPlugins.js';

export default defineConfig({
    reporter: 'junit',
    reporterOptions: {
        mochaFile: 'results/[hash].xml'
    },
    e2e: {
        setupNodeEvents(on, config) {
            registerPlugins(on, config);
            return config;
        },
        specPattern: 'cypress/e2e/**/*.cy.ts',
        supportFile: 'cypress/support/e2e.ts'
    }
});
