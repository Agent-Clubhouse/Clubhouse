// Explicit, separately authorized QA only. The caller must establish an
// OS-enforced loopback-only network sandbox and a clean environment first.
import { defineConfig, Plugin } from 'vitest/config';
import * as path from 'path';
import * as fs from 'fs';

/** .md files as raw strings, as in vitest.config.ts: the controller test loads the real tool registrations. */
function rawMarkdown(): Plugin {
  return {
    name: 'raw-markdown',
    transform(_code, id) {
      if (id.endsWith('.md')) return { code: `export default ${JSON.stringify(fs.readFileSync(id, 'utf-8'))};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [rawMarkdown()],
  test: {
    include: ['src/main/chat/copilot/handshake.runtime.qa.ts', 'src/main/chat/copilot/driver.runtime.qa.ts', 'src/main/chat/copilot/dispatcher-tools.runtime.qa.ts'],
    environment: 'node',
    mockReset: true,
    restoreMocks: true,
  },
  resolve: { alias: {
    electron: path.resolve(__dirname, 'src/__mocks__/electron.ts'),
    ws: path.resolve(__dirname, 'src/__mocks__/ws.ts'),
  } },
});
