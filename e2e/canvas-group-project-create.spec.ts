/**
 * Group project widget on a project canvas: create, then post to its bulletin.
 *
 * Runs on the new layout, and on classic in the Classic layout E2E job
 * (#2843). Only reaching the project's Canvas tab differs between them.
 */
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchApp } from './launch';
import { addProject, assertRunLayout, clickExplorerTab } from './smoke-helpers';
import { isNewLayout } from './layout';

const FIXTURE_PROJECT = path.resolve(__dirname, 'fixtures/project-group-project');
const FIXTURE_STATE = path.join(FIXTURE_PROJECT, '.clubhouse');
const GROUP_PROJECT_WIDGET = 'plugin:group-project:group-project';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;
let userDataDir: string | undefined;

async function navigateToCanvas(page: Page): Promise<void> {
  // On the new layout the tab is in the title bar or its More menu, which
  // clickExplorerTab opens when it has to.
  if (!(await isNewLayout(page))) {
    await expect(page.locator('[data-testid="explorer-tab-plugin:canvas"]')).toBeVisible({ timeout: 10_000 });
  }
  // On classic, addProject leaves the pointer on the rail, whose hover flyout covers the tab.
  await clickExplorerTab(electronApp, page, 'explorer-tab-plugin:canvas');
  await expect(page.locator('[data-testid="canvas-panel"]')).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(async () => {
  fs.rmSync(FIXTURE_STATE, { recursive: true, force: true });
  ({ electronApp, window, userDataDir } = await launchApp({
    // An old saved "off" is ignored: the Clubhouse MCP always runs, so group projects work.
    userDataFiles: {
      'mcp-settings.json': { enabled: false, projectDefault: false },
    },
  }));
  await assertRunLayout(window);
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
  const nameInput = widget.locator('input[placeholder="Project name"]');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill('E2E Group Project');
  const createButton = widget.getByRole('button', { name: 'Create', exact: true });
  await expect(createButton).toBeEnabled();
  await createButton.dispatchEvent('click');

  await expect(nameInput).not.toBeVisible({ timeout: 10_000 });
  await expect(widget.getByRole('alert')).toHaveCount(0);
  await expect(widget.getByText('0 agents', { exact: true })).toBeVisible({ timeout: 10_000 });
  const polling = widget.getByRole('switch', { name: 'Polling' });
  await expect(polling).toBeVisible({ timeout: 5_000 });
  await expect(polling).toHaveAttribute('aria-checked', 'false');

  const resizeHandle = widget.locator('[data-testid="canvas-view-resize-e"]').last();
  const resizeBox = await resizeHandle.boundingBox();
  expect(resizeBox).not.toBeNull();
  await window.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + 120);
  await window.mouse.down();
  await window.mouse.move(resizeBox!.x + resizeBox!.width / 2 + 320, resizeBox!.y + 120);
  await window.mouse.up();

  await expect(widget.getByLabel('Bulletin topic')).toBeVisible({ timeout: 5_000 });
  await widget.getByLabel('Bulletin topic').fill('updates');
  await widget.getByLabel('Bulletin message').fill('E2E bulletin round trip');
  await widget.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(widget.getByText('E2E bulletin round trip', { exact: true })).toBeVisible({ timeout: 10_000 });

  // The expanded view has its own Polling switch in the header.
  const headerPolling = widget.getByRole('switch', { name: 'Polling' });
  await headerPolling.click();
  await expect(headerPolling).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });
  await headerPolling.click();
  await expect(headerPolling).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 });
});

test('an existing group project can appear on two canvases and removing a card leaves it intact', async () => {
  const tabs = window.getByRole('tablist', { name: 'Canvases' }).getByRole('tab');
  const firstTab = tabs.first();
  const firstId = await firstTab.getAttribute('data-testid');
  expect(firstId).toBeTruthy();
  await window.getByTestId('canvas-add-button').click();
  await window.getByTestId('canvas-add-new').click();
  await expect(tabs).toHaveCount(2);

  const workspace = window.getByTestId('canvas-workspace');
  const box = await workspace.boundingBox();
  expect(box).not.toBeNull();
  await workspace.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: box!.x + 220, clientY: box!.y + 180 });
  await window.getByTestId(`canvas-context-menu-${GROUP_PROJECT_WIDGET}`).click();
  const card = workspace.locator('[data-testid^="canvas-view-cv_"]').first();
  await card.getByLabel('Existing group project').selectOption({ label: 'E2E Group Project' });
  await card.getByRole('button', { name: 'Add existing' }).click();
  const polling = card.getByRole('switch', { name: 'Polling' });
  await expect(polling).toHaveAttribute('aria-checked', 'false');
  await polling.click();
  await expect(polling).toHaveAttribute('aria-checked', 'true');
  await card.getByTestId('canvas-view-close').click();
  await expect(workspace.locator('[data-testid^="canvas-view-cv_"]')).toHaveCount(0);

  await window.getByTestId(firstId!).click();
  const original = workspace.locator('[data-testid^="canvas-view-cv_"]').first();
  await expect(original.getByRole('switch', { name: 'Polling' })).toHaveAttribute('aria-checked', 'true');
  await expect(original.getByText('E2E bulletin round trip', { exact: true })).toBeVisible();
});
