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

test('app window is visible', async () => {
  await expect(window.locator('#root')).toBeVisible({ timeout: 10_000 });
});

test('renderer loads (app shell element appears)', async () => {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 10_000 });
  // Verify React rendered something inside root
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);
});

test('no console errors on startup', async () => {
  const errors: string[] = [];
  window.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  // Wait a moment for any deferred errors
  await window.waitForTimeout(2_000);

  // Filter out known benign errors (DevTools, source maps, Chromium internals)
  const criticalErrors = errors.filter(
    (e) =>
      !e.includes('DevTools') &&
      !e.includes('source map') &&
      !e.includes('favicon') &&
      !e.includes('Autofill'),
  );

  expect(criticalErrors).toEqual([]);
});
