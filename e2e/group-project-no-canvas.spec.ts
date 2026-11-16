/**
 * #3552: a group project works with zero Canvas. The group is created, its Board
 * takes a post and its Canvases section says it is on none, all from the app row
 * with the Canvas view never opened. Fake CLIs only; no agent runs and no prompt
 * is sent.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';
import { installFakeClis } from './chat-fake-cli';

test('a group project is created, posted to and managed without opening a canvas', async () => {
  const fakes = await installFakeClis({});
  const { electronApp, window, userDataDir } = await launchApp({ env: fakes.env });
  try {
    const entry = window.getByTestId('app-row-group-projects');
    await entry.click();
    await expect(window.getByTestId('group-projects-hub')).toBeVisible();
    await window.getByRole('button', { name: 'New group project', exact: true }).click();
    await window.getByLabel('New group project name').fill('No canvas');
    await window.getByRole('button', { name: 'Create group project' }).click();

    // Board first, with nothing from a canvas around it.
    await expect(window.getByRole('heading', { name: 'No canvas' })).toBeVisible();
    await expect(window.getByTestId('group-project-section-board')).toBeVisible();
    await window.getByLabel('Bulletin topic').fill('general');
    await window.getByLabel('Bulletin message').fill('posted with no canvas');
    await window.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(window.getByText('posted with no canvas').first()).toBeVisible({ timeout: 15_000 });

    await window.getByRole('button', { name: 'Canvases', exact: true }).click();
    await expect(window.getByText('This group project is not on a canvas. It works without one.')).toBeVisible();

    // The Canvas entry in the app row was never selected.
    await expect(window.getByTestId('app-row-canvas')).toHaveAttribute('data-active', 'false');
    await expect(entry).toHaveAttribute('aria-current', 'page');

    // The same board is still there after leaving and coming back.
    await window.getByRole('button', { name: 'Back to Group Projects' }).click();
    await window.getByRole('button', { name: 'No canvas', exact: true }).click();
    await expect(window.getByText('posted with no canvas').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await electronApp.close();
    await fakes.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
