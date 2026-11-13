import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';

test('directory deletion requires an impact check and confirmation', async () => {
  const { electronApp, window, userDataDir } = await launchApp();
  try {
    await window.getByTestId('nav-settings').click();
    await window.getByTestId('settings-nav-app-group-projects').click();
    await window.getByLabel('New group project name').fill('Deletion fixture');
    await window.getByRole('button', { name: 'Create group project' }).click();
    await window.getByRole('button', { name: 'Deletion fixture', exact: true }).click();
    await window.getByRole('button', { name: 'Delete group project' }).click();
    const dialog = window.getByRole('dialog', { name: 'Delete Deletion fixture?' });
    await expect(dialog.getByText('There is no undo.', { exact: false })).toBeVisible();
    await expect(dialog.getByText(/^Members \(\d+\)$/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.getByRole('button', { name: 'Deletion fixture', exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'Delete group project' }).click();
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(window.getByRole('button', { name: 'Deletion fixture', exact: true })).toHaveCount(0);
  } finally {
    await electronApp.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
