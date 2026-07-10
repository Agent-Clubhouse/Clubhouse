import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchApp } from './launch';
import { addProject } from './smoke-helpers';

const FIXTURE_PROJECT = path.resolve(__dirname, 'fixtures/project-group-project');
const FIXTURE_STATE = path.join(FIXTURE_PROJECT, '.clubhouse');
const GROUP_PROJECT_WIDGET = 'plugin:group-project:group-project';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;
let userDataDir: string | undefined;

async function navigateToCanvas(page: Page): Promise<void> {
  const canvasButton = page.locator('[data-testid="explorer-tab-plugin:canvas"]');
  await expect(canvasButton).toBeVisible({ timeout: 10_000 });
  await canvasButton.click();
  await expect(page.locator('[data-testid="canvas-panel"]')).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(async () => {
  fs.rmSync(FIXTURE_STATE, { recursive: true, force: true });
  ({ electronApp, window, userDataDir } = await launchApp({
    userDataFiles: {
      'mcp-settings.json': { enabled: false, projectDefault: false },
    },
  }));
  await window.evaluate(async () => {
    await window.clubhouse.settings.save('mcp', { enabled: true, projectDefault: true });
  });
  await window.reload();
  await window.waitForLoadState('load');
  await addProject(electronApp, window, FIXTURE_PROJECT);
  await navigateToCanvas(window);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(FIXTURE_STATE, { recursive: true, force: true });
});

test('creating a group project advances from naming form to initialized card', async () => {
  const workspace = window.locator('[data-testid="canvas-workspace"]');
  await expect(workspace).toBeVisible({ timeout: 5_000 });

  const workspaceBox = await workspace.boundingBox();
  expect(workspaceBox).not.toBeNull();
  await workspace.dispatchEvent('contextmenu', {
    bubbles: true,
    button: 2,
    clientX: workspaceBox!.x + 220,
    clientY: workspaceBox!.y + 180,
  });
  const contextMenu = window.locator('[data-testid="canvas-context-menu"]');
  await expect(contextMenu).toBeVisible({ timeout: 5_000 });

  const addGroupProject = window.locator(
    `[data-testid="canvas-context-menu-${GROUP_PROJECT_WIDGET}"]`,
  );
  await expect(addGroupProject).toBeVisible({ timeout: 5_000 });
  await addGroupProject.dispatchEvent('click');

  const widget = workspace.locator('[data-testid^="canvas-view-cv_"]').first();
  await expect(widget).toBeVisible({ timeout: 8_000 });
  const nameInput = widget.locator('input[placeholder="Project name..."]');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill('E2E Group Project');
  const createButton = widget.getByRole('button', { name: 'Create', exact: true });
  await expect(createButton).toBeEnabled();
  await createButton.dispatchEvent('click');

  await expect(nameInput).not.toBeVisible({ timeout: 10_000 });
  await expect(widget.getByRole('alert')).toHaveCount(0);
  await expect(widget.getByText('0 agents', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(widget.getByText('Poll: Off', { exact: true })).toBeVisible({ timeout: 5_000 });
});
