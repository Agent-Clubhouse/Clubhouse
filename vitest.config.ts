import { defineConfig, Plugin } from 'vitest/config';
import * as path from 'path';
import * as fs from 'fs';

/** Vite plugin that loads .md files as raw strings (matching Webpack's asset/source). */
function rawMarkdown(): Plugin {
  return {
    name: 'raw-markdown',
    transform(_code, id) {
      if (id.endsWith('.md')) {
        const content = fs.readFileSync(id, 'utf-8');
        return { code: `export default ${JSON.stringify(content)};`, map: null };
      }
    },
  };
}

const sharedTestConfig = {
  globals: true as const,
  mockReset: true,
  restoreMocks: true,
};

const aliases = {
  electron: path.resolve(__dirname, 'src/__mocks__/electron.ts'),
  'monaco-editor': path.resolve(__dirname, 'src/__mocks__/monaco-editor.ts'),
};

export default defineConfig({
  plugins: [rawMarkdown()],
  test: {
    ...sharedTestConfig,
    projects: [
      {
        plugins: [rawMarkdown()],
        test: {
          name: 'main',
          ...sharedTestConfig,
          include: ['src/main/**/*.test.ts'],
          environment: 'node',
        },
        resolve: { alias: aliases },
      },
      {
        plugins: [rawMarkdown()],
        test: {
          name: 'renderer',
          ...sharedTestConfig,
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./test/setup-renderer.ts'],
        },
        resolve: { alias: aliases },
      },
      {
        plugins: [rawMarkdown()],
        test: {
          name: 'shared',
          ...sharedTestConfig,
          include: ['src/shared/**/*.test.ts'],
          environment: 'node',
        },
        resolve: { alias: aliases },
      },
    ],
  },
  resolve: { alias: aliases },
});
