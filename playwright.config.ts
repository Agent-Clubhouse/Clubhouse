import { defineConfig } from '@playwright/test';
import { chatShardTestMatch } from './e2e/chat-shards.mjs';

const chatShard = process.env.PLAYWRIGHT_CHAT_SHARD;

export default defineConfig({
  testDir: './e2e',
  // The e2e-chat job runs one explicit list at a time.
  ...(chatShard ? { testMatch: chatShardTestMatch(chatShard) } : {}),
  // Annex E2E, the rich chat specs (e2e/chat-rich, #2480), the Dispatcher spec
  // (#2533), the managed agents specs (#2819), the stable-mode and layout-default specs run in their own Validate jobs, and default-shell-macos in the macOS smoke set; the sharded
  // E2E run sets these to skip them.
  testIgnore: [
    ...(process.env.PLAYWRIGHT_IGNORE_ANNEX ? ['**/annex-v2/**'] : []),
    ...(process.env.PLAYWRIGHT_IGNORE_CHAT_RICH ? ['**/chat-rich/**', '**/dispatcher.spec.ts', '**/managed-agents.spec.ts', '**/managed-agents-acceptance.spec.ts', '**/stable-mode.spec.ts', '**/layout-default.spec.ts', '**/default-shell-macos.spec.ts'] : []),
  ],
  timeout: 120_000,
  // CI keeps its flake tolerance. Locally a retry discards the worker and
  // re-runs beforeAll, launching a brand-new Electron app for every failing
  // test — a dozen live instances in minutes. Not worth it on a dev machine.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
  },
});
