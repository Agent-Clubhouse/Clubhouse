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
    await expect(window.getByLabel('Covers')).toHaveValue('app');
    await expect(window.getByRole('radio', { name: 'This computer' })).toBeChecked();
    await expect(window.getByText('0 agents will join now.')).toBeVisible();
    await window.getByLabel('New group project name').fill('Directory E2E');
    await window.getByRole('button', { name: 'Create group project' }).click();
    await expect(window.getByRole('button', { name: 'Directory E2E', exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
    await fakes.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
