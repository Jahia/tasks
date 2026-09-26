import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // node_modules/** is ignored by ESLint's own defaults; node/** is not --
    // it's frontend-maven-plugin's locally-provisioned Node/Yarn distribution
    // (created by the "install node and yarn" execution), which ships its own
    // unlinted vendor JS (yarn's bin/lib files) directly under the project root.
    // src/main/** is the Java module's own tree (compiled resources, legacy
    // JSP-era assets like javascript/tasks.js) -- not part of this lint's target.
    // tests/** is its own package (own package.json/tsconfig, Cypress globals this
    // config doesn't declare) -- a separate toolchain boundary, same reasoning as
    // src/main/**, not something this build's lint step should reach into.
    // (The 'webpack.*.cjs' ignore that used to sit here went away with the webpack
    // build itself, #61: the Vite config that replaced it is plain ESM and lints
    // clean like the rest of the root-level sources. 'dist/**' went the same way in
    // #69, with the server-rendered build that produced it.)
    // .__* is @module-federation/vite's scratch tree (.__mf__temp/ today): generated
    // JS the federation build writes into the project root mid-build, gitignored, and
    // not written to this project's rules -- it fails no-unused-vars and
    // no-constant-condition. Linting it only ever breaks `mvn install` after a build.
    {ignores: ['.__*/**', 'node/**', 'src/main/**', 'target/**', 'tests/**']},
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: {
                ecmaFeatures: {jsx: true}
            }
        }
    }
);
