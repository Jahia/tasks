import {defineConfig} from 'cypress';
import {registerPlugins} from '@jahia/cypress/dist/plugins/registerPlugins.js';

export default defineConfig({
    reporter: 'junit',
    reporterOptions: {
        mochaFile: 'results/[hash].xml'
    },
    // Wider than Cypress's 1000x660 default because the rendered board is not the whole page: it
    // sits inside the admin shell, whose navigation takes ~400px of it, and the table itself
    // declares a min-width (the sum of its fixed columns -- see TaskBoard.client.css). At the
    // default size the right-hand columns are genuinely scrolled out of view, and Cypress is right
    // to call them invisible.
    viewportWidth: 1600,
    viewportHeight: 1000,
    e2e: {
        setupNodeEvents(on, config) {
            registerPlugins(on, config);
            return config;
        },
        specPattern: 'cypress/e2e/**/*.cy.ts',
        supportFile: 'cypress/support/e2e.ts'
    }
});
