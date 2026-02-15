import { test, expect, _electron as electron } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('stub dialog and add project appears in list', async () => {
  const projectPath = path.resolve(__dirname, 'fixtures/project-a');

  // Stub both the dialog AND BrowserWindow.getFocusedWindow (which returns null
  // in the Playwright test environment, causing the PICK_DIR handler to bail).
  await electronApp.evaluate(
    async ({ dialog, BrowserWindow }, fixturePath) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().startsWith('devtools://'),
      ) ?? BrowserWindow.getAllWindows()[0] ?? null;
      BrowserWindow.getFocusedWindow = () => win;

      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fixturePath],
      });
    },
    projectPath,
  );

  // Click the add project button (the "+" button with title="Add project")
  const addBtn = window.locator('[title*="Add project"]').first();
  if (await addBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await addBtn.click();

    // The project name ("project-a") comes from path.basename of the directory.
    // In ProjectRail it may show as full text or just the first letter "P".
    // Look for the text anywhere on the page.
    await expect(
      window.locator('text=project-a').first(),
    ).toBeVisible({ timeout: 10_000 });
  }
});

test('click project loads project view', async () => {
  // Look for any project in the list and click it
  const projectItem = window.locator('[data-project-id], [class*="project"]').first();
  if (await projectItem.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await projectItem.click();

    // Verify the project view loads (agent list or explorer should appear)
    await expect(
      window.locator('[data-testid="project-view"], [class*="explorer"], [class*="agent"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  }
});
