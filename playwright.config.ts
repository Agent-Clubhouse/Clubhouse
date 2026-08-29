import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.PLAYWRIGHT_IGNORE_ANNEX ? '**/annex-v2/**' : undefined,
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
