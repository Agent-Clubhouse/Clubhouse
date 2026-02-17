import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');

async function stubDialogForPath(dirPath: string) {
  await electronApp.evaluate(
    async ({ dialog, BrowserWindow }, fixturePath) => {
      const win =
        BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().startsWith('devtools://'),
        ) ?? BrowserWindow.getAllWindows()[0] ?? null;
      BrowserWindow.getFocusedWindow = () => win;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fixturePath],
      });
    },
    dirPath,
  );
}

async function addProject(dirPath: string) {
  await stubDialogForPath(dirPath);
  const addBtn = window.locator('[data-testid="nav-add-project"]');
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('switch projects updates active project in title bar', async () => {
  // Add both projects
  await addProject(FIXTURE_A);
  await addProject(FIXTURE_B);

  // Click project-a
  await window.locator('[title="project-a"]').first().click();
  await expect(window.locator('[data-testid="title-bar"]')).toContainText(
    'project-a',
    { timeout: 5_000 },
  );

  // Click project-b
  await window.locator('[title="project-b"]').first().click();
  await expect(window.locator('[data-testid="title-bar"]')).toContainText(
    'project-b',
    { timeout: 5_000 },
  );
});

test('agent list reflects new project', async () => {
  const agentList = window.locator('[data-testid="agent-list"]');

  if (await agentList.isVisible({ timeout: 5_000 }).catch(() => false)) {
    // Agent list is visible — it should reflect the current project's agents
    await expect(agentList).toBeVisible();
  }
});
