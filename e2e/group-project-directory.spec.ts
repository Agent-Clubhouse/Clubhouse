import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';
import { installFakeClis } from './chat-fake-cli';

test('create a group project in the directory', async () => {
  const fakes = await installFakeClis({});
  const { electronApp, window, userDataDir } = await launchApp({ env: fakes.env });
  try {
    await window.getByTestId('nav-settings').click();
    await window.getByTestId('settings-nav-app-group-projects').click();
    await window.getByRole('button', { name: 'New group project', exact: true }).click();
    await expect(window.getByLabel('Covers')).toHaveValue('app');
    await expect(window.getByRole('radio', { name: 'This computer' })).toBeChecked();
    await expect(window.getByText('0 agents will join now.')).toBeVisible();
    await window.getByLabel('New group project name').fill('Directory E2E');
    await window.getByRole('button', { name: 'Create group project' }).click();
    // Creating closes the form and opens the new group on its Board.
    await expect(window.getByRole('heading', { name: 'Directory E2E' })).toBeVisible();
    await expect(window.getByTestId('group-project-section-board')).toBeVisible();
    await window.getByRole('button', { name: 'Back to Group Projects' }).click();
    await expect(window.getByRole('button', { name: 'Directory E2E', exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
    await fakes.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Group Projects opens from the app row, shows a group in the hub, and Settings shows the same hub', async () => {
  const fakes = await installFakeClis({});
  const { electronApp, window, userDataDir } = await launchApp({ env: fakes.env });
  try {
    // At the default sidebar width only the selected entry of the app row shows its label, so the entry is found by its test id.
    const entry = window.getByTestId('app-row-group-projects');
    await expect(entry).toHaveAttribute('aria-label', 'Group Projects');
    await entry.click();
    await expect(entry).toHaveAttribute('aria-current', 'page');
    const hub = window.getByTestId('group-projects-hub');
    await expect(hub.getByRole('heading', { name: 'Group Projects', level: 2 })).toBeVisible();
    await hub.getByRole('button', { name: 'New group project', exact: true }).click();
    await window.getByLabel('New group project name').fill('Hub E2E');
    await window.getByRole('button', { name: 'Create group project' }).click();
    // Creating opens the new group on its Board; Back returns to the hub, where it is listed.
    await expect(window.getByTestId('group-project-section-board')).toBeVisible();
    await window.getByRole('button', { name: 'Back to Group Projects' }).click();
    await expect(window.getByTestId('group-projects-hub')).toBeVisible();
    const row = window.getByTestId('group-projects-hub').getByRole('button', { name: 'Hub E2E', exact: true });
    await expect(row).toBeVisible();
    await expect(window.getByRole('searchbox', { name: 'Search group projects' })).toBeVisible();
    await row.click();
    await expect(window.getByTestId('group-project-workspace')).toBeVisible();
    await window.getByRole('button', { name: 'Back to Group Projects' }).click();
    await expect(window.getByTestId('group-projects-hub')).toBeVisible();

    await window.getByTestId('nav-settings').click();
    await window.getByTestId('settings-nav-app-group-projects').click();
    const settingsHub = window.getByTestId('group-projects-hub');
    await expect(settingsHub.getByRole('searchbox', { name: 'Search group projects' })).toBeVisible();
    await expect(settingsHub.getByRole('button', { name: 'Hub E2E', exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
    await fakes.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
