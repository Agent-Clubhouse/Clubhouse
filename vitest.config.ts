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

export default defineConfig({
  plugins: [rawMarkdown()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'src/__mocks__/electron.ts'),
      'monaco-editor': path.resolve(__dirname, 'src/__mocks__/monaco-editor.ts'),
    },
  },
});
