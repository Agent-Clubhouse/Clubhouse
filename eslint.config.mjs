import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

const builtinHostImportAllowlist = new Set([
  'src/renderer/plugins/builtin/agent-queue/main.ts',
  'src/renderer/plugins/builtin/agent-queue/AgentQueueCanvasWidget.tsx',
  'src/renderer/plugins/builtin/browser/BrowserCanvasWidget.tsx',
  'src/renderer/plugins/builtin/canvas/AgentCanvasView.tsx',
  'src/renderer/plugins/builtin/canvas/CanvasView.tsx',
  'src/renderer/plugins/builtin/canvas/CanvasWorkspace.tsx',
  'src/renderer/plugins/builtin/canvas/CanvasContextMenu.tsx',
  'src/renderer/plugins/builtin/canvas/LinkDropdown.tsx',
  'src/renderer/plugins/builtin/canvas/MonacoDiffEditor.tsx',
  'src/renderer/plugins/builtin/canvas/ReadOnlyMonacoEditor.tsx',
  'src/renderer/plugins/builtin/canvas/WireConfigPopover.tsx',
  'src/renderer/plugins/builtin/canvas/PendingWidgetPlaceholder.tsx',
  'src/renderer/plugins/builtin/canvas/ResizableSidebar.tsx',
  'src/renderer/plugins/builtin/canvas/WireOverlay.tsx',
  'src/renderer/plugins/builtin/canvas/WireToolPermissionsDialog.tsx',
  'src/renderer/plugins/builtin/canvas/WireInstructionsDialog.tsx',
  'src/renderer/plugins/builtin/canvas/canvas-store.ts',
  'src/renderer/plugins/builtin/canvas/canvas-sync.ts',
  'src/renderer/plugins/builtin/canvas/main.ts',
  'src/renderer/plugins/builtin/canvas/useBlueprintDrop.ts',
  'src/renderer/plugins/builtin/canvas/useViewportControls.ts',
  'src/renderer/plugins/builtin/canvas/useWiring.ts',
  'src/renderer/plugins/builtin/canvas/wire-render-contract.ts',
  'src/renderer/plugins/builtin/files/FileTree.ts',
  'src/renderer/plugins/builtin/files/FileViewerCanvasWidget.tsx',
  'src/renderer/plugins/builtin/files/MermaidDiagram.ts',
  'src/renderer/plugins/builtin/files/MonacoEditor.ts',
  'src/renderer/plugins/builtin/git/GitCanvasWidget.tsx',
  'src/renderer/plugins/builtin/git/remote-git.ts',
  'src/renderer/plugins/builtin/group-project/GroupProjectCanvasWidget.tsx',
  'src/renderer/plugins/builtin/group-project/GroupProjectPanelSidebar.tsx',
  'src/renderer/plugins/builtin/group-project/main.ts',
  'src/renderer/plugins/builtin/group-project/useGroupProjectContext.ts',
  'src/renderer/plugins/builtin/hub/AgentPicker.tsx',
  'src/renderer/plugins/builtin/hub/CrossProjectAgentPicker.tsx',
  'src/renderer/plugins/builtin/hub/HubPane.tsx',
  'src/renderer/plugins/builtin/hub/main.ts',
  'src/renderer/plugins/builtin/review/main.ts',
  'src/renderer/plugins/builtin/sessions/main.ts',
  'src/renderer/plugins/builtin/terminal/TerminalCanvasWidget.tsx',
]);

const builtinImportBoundary = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!filename.includes('/src/renderer/plugins/builtin/')) return {};
    const relativeFilename = filename.slice(filename.lastIndexOf('src/'));
    if (relativeFilename.endsWith('.test.ts') || relativeFilename.endsWith('.test.tsx')) return {};

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (
          /(?:^|\/)(?:stores|hooks|features|components)(?:\/|$)/.test(source)
          && !builtinHostImportAllowlist.has(relativeFilename)
        ) {
          context.report({
            node,
            message: 'Builtin plugins may not import host internals outside the documented allowlist.',
          });
        }
      },
    };
  },
};

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
    files: ['src/renderer/plugins/builtin/**/*.{ts,tsx}'],
    plugins: { clubhouse: { rules: { 'builtin-import-boundary': builtinImportBoundary } } },
    rules: { 'clubhouse/builtin-import-boundary': 'error' },
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
        {
          selector: "JSXAttribute[name.name='className'][value.value=/text-\\[10px\\]/]",
          message: 'Use text-xs (12px) instead of text-[10px] — WCAG minimum font-size requirement.',
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
