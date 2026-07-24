import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // node_modules/** is ignored by ESLint's own defaults; node/** is not --
    // it's frontend-maven-plugin's locally-provisioned Node/Yarn distribution
    // (created by the "install node and yarn" execution), which ships its own
    // unlinted vendor JS (yarn's bin/lib files) directly under the project root.
    {ignores: ['dist/**', 'node/**']},
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
