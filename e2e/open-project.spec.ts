/**
 * Adding a project and opening it. Runs on the new layout, and on classic in
 * the Classic layout E2E job (#2843).
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';
import { assertActiveProject, assertRunLayout, projectButton, selectProject } from './smoke-helpers';
import { isNewLayout } from './layout';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await assertRunLayout(window);
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

  const addBtn = window.locator('[data-testid="nav-add-project"]');

  if (await isNewLayout(window)) {
    // The sidebar footer always has Add project, and the new project gets a
    // row in the tree.
    await expect(addBtn).toBeVisible({ timeout: 5_000 });
    await addBtn.click();
    await expect(await projectButton(window, 'project-a')).toBeVisible({ timeout: 10_000 });
    return;
  }

  // Click the add project button
  if (await addBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await addBtn.click();

    // The project name should appear somewhere on the page
    await expect(
      window.locator('text=project-a').first(),
    ).toBeVisible({ timeout: 10_000 });
  }
});

test('click project loads project view', async () => {
  if (await isNewLayout(window)) {
    // The project's header in the tree opens its start page.
    await selectProject(window, 'project-a');
    await assertActiveProject(window, 'project-a');
    await expect(
      window.getByTestId('start-page').getByRole('heading', { level: 1, name: 'project-a', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    return;
  }

  // Look for the project by its title attribute
  const projectItem = window.locator('[title="project-a"]').first();
  if (await projectItem.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await projectItem.click();

    // Verify the project view loads (agent list or explorer should appear)
    await expect(
      window.locator('[data-testid="agent-list"], [data-testid="no-active-agent"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  }
});
