import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';

test('create a group project in the directory', async () => {
  const { electronApp, window, userDataDir } = await launchApp();
  try {
    await window.getByTestId('nav-settings').click();
    await window.getByTestId('settings-nav-app-group-projects').click();
    await expect(window.getByText(/Every top-level durable agent in every local project joins automatically/)).toBeVisible();
    await window.getByLabel('New group project name').fill('Directory E2E');
    await window.getByRole('button', { name: 'Create group project' }).click();
    await expect(window.getByRole('button', { name: 'Directory E2E', exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
