import { defineConfig } from '@playwright/test';
import { chatShardTestMatch } from './e2e/chat-shards.mjs';
import { CLASSIC_LAYOUT_ENV, CLASSIC_ONLY_SPECS, CLASSIC_SHARD_ENV, classicTestMatch } from './e2e/classic-specs.mjs';

const chatShard = process.env.PLAYWRIGHT_CHAT_SHARD;
// The Classic layout E2E job runs its own list on classic (#2843).
const classicRun = process.env[CLASSIC_LAYOUT_ENV] === 'classic';

export default defineConfig({
  testDir: './e2e',
  // The e2e-chat job runs one explicit list at a time, and so does e2e-classic.
  ...(classicRun ? { testMatch: classicTestMatch(process.env[CLASSIC_SHARD_ENV]) } : chatShard ? { testMatch: chatShardTestMatch(chatShard) } : {}),
  // Annex E2E, the rich chat specs (e2e/chat-rich, #2480), the Dispatcher specs
  // (#2533, #3049, #3047), the Actions spec (#2918), the managed agents specs (#2819), the stable-mode and layout-default specs run in their own Validate jobs, and default-shell-macos in the macOS smoke set; the sharded
  // E2E run sets these to skip them.
  testIgnore: [
    // Classic-only UI runs only in the Classic layout E2E job (#2843).
    ...(classicRun ? [] : CLASSIC_ONLY_SPECS.map((spec) => `**/${spec}`)),
    ...(process.env.PLAYWRIGHT_IGNORE_ANNEX ? ['**/annex-v2/**'] : []),
    ...(process.env.PLAYWRIGHT_IGNORE_CHAT_RICH ? ['**/chat-rich/**', '**/actions.spec.ts', '**/dispatcher.spec.ts', '**/dispatcher-card.spec.ts', '**/dispatcher-settings.spec.ts', '**/dispatcher-setup.spec.ts', '**/managed-agents.spec.ts', '**/managed-agents-acceptance.spec.ts', '**/stable-mode.spec.ts', '**/layout-default.spec.ts', '**/default-shell-macos.spec.ts'] : []),
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
