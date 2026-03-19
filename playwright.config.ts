import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.PLAYWRIGHT_IGNORE_ANNEX ? '**/annex-v2/**' : undefined,
  timeout: 120_000,
  retries: 1,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
  },
});
