// Explicit, separately authorized QA only. The caller must establish an
// OS-enforced loopback-only network sandbox and a clean environment first.
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    include: ['src/main/chat/copilot/driver.runtime.qa.ts'],
    environment: 'node',
    mockReset: true,
    restoreMocks: true,
  },
  resolve: { alias: {
    electron: path.resolve(__dirname, 'src/__mocks__/electron.ts'),
    ws: path.resolve(__dirname, 'src/__mocks__/ws.ts'),
  } },
});
