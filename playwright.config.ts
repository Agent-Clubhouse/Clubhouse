import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 1,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
  },
});
