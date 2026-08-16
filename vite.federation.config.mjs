// @ts-check
//
// Second Vite build of this module: the Module Federation REMOTE that the Jahia app shell loads
// to put the "My tasks" screen in the dashboard. It is separate from vite.config.mjs (the
// @jahia/vite-plugin build that produces the SSR server bundle + client islands in dist/) because
// the two have nothing in common but the source tree: different entry, different output layout,
// different runtime contract. `yarn build` runs both, in that order.
//
// Replaces webpack.config.cjs + webpack.shared.cjs (#61). This file is deliberately a copy of
// formidable-engine's vite.config.ts -- outDir straight into src/main/resources/javascript/apps,
// a single './init' expose, no `shared` overrides -- because formidable-engine is the one Vite
// federation remote observed working against Jahia's webpack-5 app shell on the jahia-cortex bench.
// What makes that work is not this file but the TOOLCHAIN VERSIONS it is built with, which
// package.json pins to formidable's exactly; read the "_comment-toolchain-pins" note there before
// touching vite, @jahia/vite-federation-plugin or the @module-federation/vite resolution. Two
// earlier shapes of this config, both plausible, both took the entire Jahia admin UI down at boot
// on a newer toolchain -- see the commit history for #61.
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
            // No `shared` block: the auto-share list (package.json "dependencies") is already
            // exactly react / react-dom / @jahia/ui-extender, the three packages jahia-ui-root
            // publishes, and the plugin registers each as {singleton: true, strictVersion: false,
            // requiredVersion: <declared range>} -- byte-for-byte the shareConfig formidable-engine
            // registers on this same bench and shell. Moonstone is absent from that list because it
            // is a devDependency (see package.json): the shell only has 2.14.2, which lacks Banner,
            // DataTable and EmptyData, so the board must bundle 2.20.3 privately. Private is also
            // strictly safer -- a privately bundled library is a plain import, never a participant
            // in the share runtime.
            //
            // Do NOT reach for `import: false` here. It reads like the obvious way to guarantee the
            // host's copy wins, and on this webpack-5 shell it fails outright: the runtime cannot
            // bridge a webpack share scope for a share it has no local provider for, and every one
            // of the three dies with "Failed to bridge external shared module" /
            // "Shared module 'react' must be provided by host", taking the shell's boot with it.
            // Measured on jahia-cortex, 2026-08-16.
            dts: false // No @mf-types.zip / @mf-types.d.ts: nothing federates types off this module.
        })
    ]
});
