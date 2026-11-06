// Explicit real-CLI QA only. Apply the appropriate credential and network
// boundary before running; this config intentionally does not sanitize env.
import { defineConfig } from 'vitest/config';
import * as path from 'path';
export default defineConfig({
  test: {
    include: [
      'src/main/chat/*-smoke.test.ts',
      'src/main/chat/copilot/record-fixtures.test.ts',
      'src/main/orchestrators/quota-probes-smoke.test.ts',
      'scripts/check-copilot-sdk-chunk.test.ts',
    ],
    environment: 'node', mockReset: true, restoreMocks: true,
  },
  resolve: { alias: {
    electron: path.resolve(__dirname, 'src/__mocks__/electron.ts'),
    'monaco-editor': path.resolve(__dirname, 'src/__mocks__/monaco-editor.ts'),
    ws: path.resolve(__dirname, 'src/__mocks__/ws.ts'),
  } },
});
