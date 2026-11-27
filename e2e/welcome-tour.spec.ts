import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import { launchApp, type LaunchedApp } from './launch';

/**
 * The 1.0 welcome tour (#2814) on a fresh install: it opens by itself in the
 * pane, steps forward and back, closes as seen, and comes back from Help.
 * Every other spec seeds it as seen (app-profile.ts).
 */

let app: LaunchedApp | undefined;
let window: Page;

test.beforeAll(async () => {
  app = await launchApp({ userDataFiles: { 'welcome-tour.json': { seenVersion: 0, variant: null, variantVersion: 0 } } });
  window = app.window;
});

test.afterAll(async () => {
  await app?.electronApp.close().catch(() => {});
  if (app?.userDataDir) fs.rmSync(app.userDataDir, { recursive: true, force: true });
});

test('a fresh install opens the new-user tour, which closes as seen and comes back from Help', async () => {
  const tour = window.getByTestId('welcome-tour');
  await expect(tour).toBeVisible({ timeout: 15_000 });
  await expect(tour).toHaveAttribute('data-variant', 'new');
  await expect(window.getByTestId('welcome-tour-title')).toHaveText('Welcome to Clubhouse');
  // The sidebar stays usable around it.
  await expect(window.getByTestId('nav-help')).toBeVisible();

  await window.getByTestId('welcome-tour-next').click();
  await expect(tour).toHaveAttribute('data-step', 'managed');
  await window.getByTestId('welcome-tour-back').click();
  await expect(tour).toHaveAttribute('data-step', 'welcome');
  await window.getByTestId('welcome-tour-step-start').click();
  await expect(window.getByTestId('welcome-tour-first-run')).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(tour).toBeHidden();
  // With no project, the empty app is the same Get started page.
  await expect(window.getByTestId('first-run')).toBeVisible();
  await expect.poll(() => window.evaluate(async () => (await window.clubhouse.app.getWelcomeTour()).state.seenVersion)).toBeGreaterThanOrEqual(1);

  await window.getByTestId('nav-help').click();
  await window.getByTestId('help-nav-welcome-tour').click();
  await expect(tour).toBeVisible();
  await expect(tour).toHaveAttribute('data-step', 'welcome');
  await window.getByTestId('welcome-tour-skip').click();
  await expect(tour).toBeHidden();
});
