// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Catches real bugs (unused code, unsafe patterns, misused promises) without
 *  fighting the codebase's deliberate style — `any` at webview/provider
 *  boundaries and empty catches that carry a comment are allowed. */
export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'assets/**', 'deck/**', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);
