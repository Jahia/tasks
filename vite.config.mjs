// @ts-check
//
// The module's only build: the Module Federation REMOTE the Jahia app shell loads to put the
// "My tasks" screen in the dashboard. Until #69 this was vite.federation.config.mjs, running
// second behind a @jahia/vite-plugin build that produced a server bundle and hydrated islands in
// dist/; that whole path is gone, so this is now vite.config.mjs and `yarn build` is a plain
// `vite build`, the same shape kfind and copy-to-other-languages ship.
//
// This file is deliberately close to formidable-engine's vite.config.ts -- outDir straight into
// src/main/resources/javascript/apps, a single './init' expose -- because formidable-engine is the
// one Vite federation remote observed working against Jahia's webpack-5 app shell on the
// jahia-cortex bench. What makes that work is not this file but the TOOLCHAIN VERSIONS it is built
// with, which package.json pins to formidable's exactly; read the "_comment-toolchain-pins" note
// there before touching vite, @jahia/vite-federation-plugin or the @module-federation/vite
// resolution. Two earlier shapes of this config, both plausible, both took the entire Jahia admin
// UI down at boot on a newer toolchain -- see the commit history for #61.
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
            // Every key of package.json "dependencies" is auto-shared by the plugin as
            // {singleton: true, requiredVersion: <the INSTALLED version>}. The block below
            // overrides the version this module ADVERTISES for the four packages the shell
            // publishes, and 0.0.0 is not a placeholder: it is the fix kfind landed after its
            // remote took the whole Jahia admin UI down (see kfind's HANDOFF_RUNTIME_ISSUE.md).
            //
            // The failure is a singleton VERSION TIE. @module-federation/vite pre-builds a full
            // fallback copy of every shared package, so this remote's share entries carry a real
            // `get()` factory and are eligible to PROVIDE, not just consume. The webpack shell
            // calls `get()` on every entry while populating the share scope, and the highest
            // version wins; declaring react ^18.3.1 against a shell that publishes exactly 18.3.1
            // makes this module win the tie-break and serve its own React to the entire platform.
            // Two React instances then share one component tree -- the hooks dispatcher is null
            // and every page dies on "Cannot read properties of null (reading 'useMemo')".
            // Advertising 0.0.0 means this module can never win, so the shell's copy is always
            // the one loaded, while `loadShare()` still resolves our imports to it normally.
            //
            // Do NOT reach for `import: false` to get the same guarantee. It stops the fallback
            // being bundled but makes `get()` THROW, and webpack's `consumes` calls `get()`
            // unconditionally -- the shell then dies with "Shared module 'react' must be provided
            // by host" instead. kfind burned twelve attempts proving that; 0.0.0 is the one that
            // held. (The plugin shallow-merges this block over its defaults, so each entry must
            // restate `singleton: true` or it is lost.)
            //
            // @jahia/moonstone is absent here because it is absent from "dependencies": the shell
            // only publishes 2.14.2, which lacks Banner, DataTable and EmptyData, so the board
            // bundles 2.20.3 privately. Private is also strictly safer -- a privately bundled
            // library is a plain import, never a participant in the share runtime.
            shared: {
                react: {singleton: true, version: '0.0.0'},
                'react-dom': {singleton: true, version: '0.0.0'},
                '@apollo/client': {singleton: true, version: '0.0.0'},
                '@jahia/ui-extender': {singleton: true, version: '0.0.0'}
            },
            dts: false // No @mf-types.zip / @mf-types.d.ts: nothing federates types off this module.
        })
    ]
});
