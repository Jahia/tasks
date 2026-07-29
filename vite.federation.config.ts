import {defineConfig} from 'vite';
import jahia from '@jahia/vite-federation-plugin';

export default defineConfig({
    build: {
        outDir: './src/main/resources/javascript/apps/'
    },
    plugins: [
        jahia({
            exposes: {
                './init': './src/javascript/init.tsx'
            }
        })
    ]
});
