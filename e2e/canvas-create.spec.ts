/**
 * Mission 71 — Canvas "+" button create-flow E2E coverage.
 *
 * Mason reported that the "+" button to create a new canvas was broken,
 * and asked: how was this missed in test coverage?
 *
 * The unit-level CanvasTabBar tests use mocked onAddCanvas handlers, so
 * they verify the click → handler wiring at the component layer but never
 * exercise the real store action behind it. The integration test added in
 * the same PR (CanvasTabBar.test.tsx) closes the unit-level seam, but the
 * canonical "missed" coverage is an end-to-end test that:
 *   1. Launches the real Electron app
 *   2. Navigates to a project's Canvas explorer tab
 *   3. Clicks the canvas "+" add button
 *   4. Clicks "New Canvas" in the dropdown
 *   5. Verifies a brand-new canvas tab appears
 *
 * This is the test that should have existed before the regression was
 * possible.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_PROJECT = path.resolve(__dirname, 'fixtures/project-a');

/** Stub Electron's dialog so the next pickAndAddProject resolves to `dirPath`. */
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

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp({ experimental: {} }));
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('clicking the canvas + button → New Canvas creates a new canvas tab', async () => {
  // 1. Add a project fixture (canvas is per-project)
  await stubDialogForPath(FIXTURE_PROJECT);
  const navAddBtn = window.locator('[data-testid="nav-add-project"]');
  await expect(navAddBtn).toBeVisible({ timeout: 5_000 });
  await navAddBtn.click();
  await expect(window.locator(`text=${path.basename(FIXTURE_PROJECT)}`).first()).toBeVisible({
    timeout: 10_000,
  });

  // 2. Select the project's Canvas tab, distinct from the app-wide Canvas button.
  const canvasNavBtn = window.locator('[data-testid="explorer-tab-plugin:canvas"]');
  await expect(canvasNavBtn).toBeVisible({ timeout: 10_000 });
  await canvasNavBtn.click();
  const canvasPanel = window.locator('[data-testid="canvas-panel"]');
  await expect(canvasPanel).toBeVisible({ timeout: 10_000 });

  // 3. Capture the initial canvas tab count (real canvas IDs are
  //    "canvas_xxxxxxxx" so the testid prefix below excludes the tab bar
  //    wrapper, the close button, the popout button, and the rename input).
  const tabsLocator = window.locator('[data-testid^="canvas-tab-canvas_"]');
  const initialCount = await tabsLocator.count();
  expect(initialCount).toBeGreaterThanOrEqual(1);

  // 4. Click the + button. In production main.ts always provides
  //    onAddFromBlueprint, so the + button opens a dropdown.
  const addBtn = window.locator('[data-testid="canvas-add-button"]');
  await expect(addBtn).toBeVisible();
  await addBtn.click();

  // 5. The dropdown should appear and contain "New canvas".
  const addMenu = window.locator('[data-testid="canvas-add"]');
  await expect(addMenu).toBeVisible({ timeout: 2_000 });
  const addNew = window.locator('[data-testid="canvas-add-new"]');
  await expect(addNew).toBeVisible({ timeout: 5_000 });
  await addNew.click();

  // 6. A new canvas tab must now exist (count increased by exactly 1).
  await expect(tabsLocator).toHaveCount(initialCount + 1, { timeout: 5_000 });
});
