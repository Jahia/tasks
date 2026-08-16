// @ts-check
//
// Second Vite build of this module: the Module Federation REMOTE that the Jahia app shell loads
// to put the "My tasks" screen in the dashboard. It is separate from vite.config.mjs (the
// @jahia/vite-plugin build that produces the SSR server bundle + client islands in dist/) because
// the two have nothing in common but the source tree: different entry, different output layout,
// different runtime contract. `yarn build` runs both, in that order.
//
// Replaces webpack.config.cjs + webpack.shared.cjs (#61). The shape below is the one used by
// Jahia's own already-migrated remotes -- copy-to-other-languages (the reference migration,
// PR #109), formidable-engine and kfind: outDir straight into src/main/resources/javascript/apps,
// a single './init' expose, and everything else left to @jahia/vite-federation-plugin.
import {defineConfig} from 'vite';
import jahiaFederation from '@jahia/vite-federation-plugin';

export default defineConfig({
    build: {
        // maven-bundle-plugin folds src/main/resources/** into the jar root ({maven-resources} in
        // pom.xml), so this lands at javascript/apps/ inside the bundle -- the path the root
        // package.json's jahia.remotes entry points the app shell at.
        outDir: 'src/main/resources/javascript/apps',
        // Vite already empties an outDir that sits inside the project root; stated explicitly
        // because THIS is what keeps stale content-hashed chunks from piling up in the jar.
        // The webpack build could not do it (its clean step raced Windows on-access AV scanners
        // over the files it was unlinking, see the removed webpack.config.cjs), which is why 18
        // dead chunks had once shipped and why pom.xml's maven-clean-plugin grew an extra fileset
        // for this directory (#62). Vite's emptyOutDir removes the whole directory tree in one
        // `rm -rf` before writing anything, rather than unlinking individual just-superseded
        // files, so the failure mode that forced webpack's hand does not apply. The
        // maven-clean-plugin fileset stays as the belt to this suspenders.
        emptyOutDir: true
        // minify / sourcemap are deliberately NOT set here: the plugin's own `config` hook forces
        // `minify: !watch` and `sourcemap: true`, and Vite merges plugin-returned config OVER the
        // user's, so anything set here would be silently ignored. A plain `vite build` is
        // therefore already a minified production build (what 5ec93a8 had to pass --mode
        // production to webpack to get), and it emits .map files exactly like webpack's
        // production `devtool: 'source-map'` did.
    },
    plugins: [
        jahiaFederation({
            exposes: {
                './init': './src/javascript/init.tsx'
            },
            // No `shared` overrides on purpose -- same as copy-to-other-languages and
            // formidable-engine. The plugin already shares EVERY package.json dependency as a
            // module-federation `singleton` (with requiredVersion derived from the declared
            // range), which is exactly, key for key, what the deleted webpack.shared.cjs spelled
            // out by hand for react / react-dom / @jahia/ui-extender / @jahia/moonstone. Singleton
            // is the part that matters: the app shell (jahia-ui-root) publishes its own react,
            // react-dom, @jahia/moonstone and @jahia/ui-extender into the share scope, and a
            // singleton share resolves to ONE instance across host and remote, so the copies
            // bundled here are inert fallbacks for the "nobody else provided it" case rather than
            // a second React able to shadow the host's. (A remote that shares its dependencies
            // WITHOUT singleton semantics is what produced the "useContext of null" dual-React
            // crashes seen on another module in July 2026.)
            //
            // @jahia/ui-extender in particular MUST end up as the host's instance: init.tsx
            // registers the 'tasks' adminRoute into the registry the shell later reads, and a
            // private registry object would simply never surface the tab.
            dts: false // No @mf-types.zip / @mf-types.d.ts: nothing federates types off this module.
        })
    ]
});
