// @ts-check
//
// Second Vite build of this module: the Module Federation REMOTE that the Jahia app shell loads
// to put the "My tasks" screen in the dashboard. It is separate from vite.config.mjs (the
// @jahia/vite-plugin build that produces the SSR server bundle + client islands in dist/) because
// the two have nothing in common but the source tree: different entry, different output layout,
// different runtime contract. `yarn build` runs both, in that order.
//
// Replaces webpack.config.cjs + webpack.shared.cjs (#61). The skeleton is the one used by Jahia's
// own already-migrated remotes -- copy-to-other-languages (the reference migration, PR #109),
// formidable-engine and kfind: outDir straight into src/main/resources/javascript/apps and a
// single './init' expose. The `shared` block, which those three do not have, is where this module
// deliberately parts company with them; the long comment on it says why, and it is not optional --
// without it this remote takes the whole Jahia admin UI down at boot.
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
            // Only what the app shell actually provides is shared, and it is shared with NO local
            // fallback. `import: false` is module-federation's "the host must supply this" flag,
            // and the plugin honours it by skipping the prebuilt local copy entirely
            // (@module-federation/vite: `if (shareItem.shareConfig?.import !== false)
            // writePreBuildLibPath(...)`). jahia-ui-root publishes react 18.3.1, react-dom 18.3.1
            // and @jahia/ui-extender 1.0.6, so all three resolve; nothing else is shared, because
            // the auto-share list is exactly package.json's "dependencies" and Moonstone was moved
            // out of it (see the note there).
            //
            // Why no fallbacks, rather than the singleton-with-fallback the reference modules use:
            // the fallbacks are what crashed the shell. The generated share-materialisation code
            // is fully SYNCHRONOUS -- for each share it reads
            // globalThis.__mf_module_cache__.share['default:<pkg>'], falls back to the bundled copy
            // only when that read is `undefined`, and then immediately dereferences the result
            // (`e.useEffect`, `e.AbTesting`, ...). Bridging a webpack host's share scope is
            // asynchronous, so that cache slot can hold a not-yet-resolved value; `null` is not
            // `undefined`, the fallback branch does not fire, and the dereference throws
            // "Cannot read properties of null (reading 'useEffect')" out of remoteEntry.init() --
            // which the shell awaits during boot, so the whole /jahia UI hangs on "Loading Jahia",
            // not just this module's tab. Observed on jahia-cortex, 2026-08-16.
            //
            // With no local copies to materialise there is nothing for the shell's own instances to
            // race against, which is also the July 2026 smart-images lesson stated the other way
            // round: libraries the host CAN provide are taken from the host and never duplicated;
            // libraries the host CANNOT provide (Moonstone here) are bundled privately and stay out
            // of the share runtime altogether.
            //
            // @jahia/ui-extender must be the host's instance regardless of crash-safety: init.tsx
            // registers the 'tasks' adminRoute into the registry the shell later reads, and a
            // private registry object would simply never surface the tab. 1.0.6 carries the same
            // registry API this module uses (add/addOrReplace/clear/find/get/remove -- checked
            // against the published 1.0.6 tarball), so consuming the older host copy is safe.
            shared: {
                react: {singleton: true, import: false},
                'react-dom': {singleton: true, import: false},
                '@jahia/ui-extender': {singleton: true, import: false}
            },
            dts: false // No @mf-types.zip / @mf-types.d.ts: nothing federates types off this module.
        })
    ]
});
