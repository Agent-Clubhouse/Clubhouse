import { defineConfig } from '@playwright/test';
import { chatShardTestMatch } from './e2e/chat-shards.mjs';
import { CLASSIC_LAYOUT_ENV, CLASSIC_ONLY_SPECS, CLASSIC_SHARD_ENV, classicTestMatch } from './e2e/classic-specs.mjs';
import { ANNEX_SHARD_ENV, ANNEX_SHARDS, E2E_SHARD_ENV, E2E_SHARDS, listShardTestMatch } from './e2e/e2e-shards.mjs';

const chatShard = process.env.PLAYWRIGHT_CHAT_SHARD;
const e2eShard = process.env[E2E_SHARD_ENV];
const annexShard = process.env[ANNEX_SHARD_ENV];
// The Classic layout E2E job runs its own list on classic (#2843).
const classicRun = process.env[CLASSIC_LAYOUT_ENV] === 'classic';

/** The explicit list a sharded job runs, or undefined to run everything testIgnore leaves (#2843). */
function shardTestMatch(): string[] | undefined {
  const chosen = [classicRun && CLASSIC_LAYOUT_ENV, chatShard && 'PLAYWRIGHT_CHAT_SHARD', e2eShard && E2E_SHARD_ENV, annexShard && ANNEX_SHARD_ENV].filter(Boolean);
  if (chosen.length > 1) throw new Error(`Set one of ${chosen.join(', ')}: each picks a different job's list`);
  if (classicRun) return classicTestMatch(process.env[CLASSIC_SHARD_ENV]);
  if (chatShard) return chatShardTestMatch(chatShard);
  if (e2eShard) return listShardTestMatch(E2E_SHARD_ENV, e2eShard, E2E_SHARDS);
  if (annexShard) return listShardTestMatch(ANNEX_SHARD_ENV, annexShard, ANNEX_SHARDS);
  return undefined;
}
const testMatch = shardTestMatch();

export default defineConfig({
  testDir: './e2e',
  // The E2E, Annex E2E, Chat E2E and Classic layout E2E jobs each run one explicit list per shard.
  ...(testMatch ? { testMatch } : {}),
  // Annex E2E, the rich chat specs (e2e/chat-rich, #2480), the Dispatcher specs
  // (#2533, #3049, #3047), the Actions spec (#2918), the managed agents specs (#2819), the stable-mode and layout-default specs run in their own Validate jobs, and default-shell-macos in the macOS smoke set; the sharded
  // E2E run sets these to skip them.
  testIgnore: [
    // Classic-only UI runs only in the Classic layout E2E job (#2843).
    ...(classicRun ? [] : CLASSIC_ONLY_SPECS.map((spec) => `**/${spec}`)),
    ...(process.env.PLAYWRIGHT_IGNORE_ANNEX ? ['**/annex-v2/**'] : []),
    ...(process.env.PLAYWRIGHT_IGNORE_CHAT_RICH ? ['**/chat-rich/**', '**/actions.spec.ts', '**/dispatcher.spec.ts', '**/dispatcher-card.spec.ts', '**/dispatcher-setup.spec.ts', '**/managed-agents.spec.ts', '**/managed-agents-acceptance.spec.ts', '**/stable-mode.spec.ts', '**/layout-default.spec.ts', '**/default-shell-macos.spec.ts'] : []),
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
