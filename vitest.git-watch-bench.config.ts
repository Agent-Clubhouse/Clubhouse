// The git watcher rebuild benchmark (#3230). Run by hand, never in CI.
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    include: ['src/main/services/git-watcher.bench.qa.ts'],
    environment: 'node',
  },
  resolve: { alias: {
    electron: path.resolve(__dirname, 'src/__mocks__/electron.ts'),
  } },
});
