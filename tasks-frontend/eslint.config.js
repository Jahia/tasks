import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {ignores: ['dist/**']},
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
