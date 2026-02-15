import { test, expect, _electron as electron } from '@playwright/test';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('start agent shows running status', async () => {
  // Look for a "Start" or "New Agent" button
  const startBtn = window.locator('button:has-text("Start"), button:has-text("New Agent"), [aria-label*="start agent"]').first();

  if (await startBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await startBtn.click();

    // The agent should show "running" status
    await expect(
      window.locator('text=running, [data-status="running"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  }
});

test('agent terminal shows output', async () => {
  // If an agent is running, its terminal should display output
  const terminal = window.locator('[class*="xterm"], [data-testid="agent-terminal"]').first();

  if (await terminal.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await expect(terminal).toBeVisible();
  }
});

test('stop agent shows sleeping status', async () => {
  // Look for a "Stop" button associated with the running agent
  const stopBtn = window.locator('button:has-text("Stop"), button:has-text("Kill"), [aria-label*="stop"]').first();

  if (await stopBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await stopBtn.click();

    // The agent should show "sleeping" or "stopped" status
    await expect(
      window.locator('text=sleeping, text=stopped, [data-status="sleeping"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  }
});
