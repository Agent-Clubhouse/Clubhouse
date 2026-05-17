import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'import-x': importX,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      'no-empty': 'off',
      'prefer-const': 'warn',
    },
    languageOptions: {
      globals: {
        // Browser
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLButtonElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
        // Node
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      'test/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="fs"][callee.property.name="readFileSync"]',
          message: 'Use behavioral tests (spies, output assertions) instead of reading source files in tests.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.tsx', 'src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='className'][value.value=/\\bz-modal\\b/]",
          message: 'Use <Modal> from src/renderer/components/Modal.tsx instead of a bespoke fixed overlay with z-modal.',
        },
      ],
    },
  },
  {
    ignores: [
      '.webpack/**',
      'out/**',
      'dist/**',
      'node_modules/**',
      'recovery/**',
      '.clubhouse/agents/**/.webpack/**',
      '.clubhouse/agents/**/out/**',
      '.clubhouse/agents/**/dist/**',
      '.clubhouse/agents/**/node_modules/**',
    ],
  },
);
