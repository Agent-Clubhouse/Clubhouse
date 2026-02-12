import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
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
    },
  },
});
