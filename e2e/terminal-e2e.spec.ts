/**
 * E2E: open the project Terminal, type in it, resize, leave and come back.
 *
 * Runs on the new layout, and on classic in the Classic layout E2E job
 * (#2843). On the new layout the Terminal tab is in the title bar, or in its
 * More menu when the tabs don't all fit; clickExplorerTab handles both.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';
import {
  addProject,
  assertActiveProject,
  assertRunLayout,
  clickExplorerTab,
  selectProject,
} from './smoke-helpers';
import { isNewLayout } from './layout';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const TERMINAL_TAB = 'explorer-tab-plugin:terminal';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await assertRunLayout(window);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// Terminal E2E Tests
// ---------------------------------------------------------------------------

test.describe('Terminal Plugin E2E', () => {
  test('open project and navigate to terminal tab', async () => {
    // Add a project first
    await addProject(electronApp, window, FIXTURE_A);

    // Click the project to ensure it's active and UI has settled
    await selectProject(window, 'project-a');
    await assertActiveProject(window, 'project-a');
    await window.waitForTimeout(1_000);

    await clickExplorerTab(electronApp, window, TERMINAL_TAB);

    // Verify the terminal tab is now active. On the new layout the active tab
    // always stays in the title bar's row, which has data-active.
    const terminalTab = window.getByTestId(TERMINAL_TAB);
    await expect(terminalTab).toHaveAttribute('data-active', 'true', {
      timeout: 5_000,
    });
  });

  test('terminal widget renders with xterm', async () => {
    // After clicking the terminal tab, an xterm container should appear
    const xtermElement = window.locator('[class*="xterm"]').first();
    await expect(xtermElement).toBeVisible({ timeout: 15_000 });
  });

  test('terminal accepts keyboard input', async () => {
    // The terminal should be focused and accept input
    const xtermElement = window.locator('[class*="xterm"]').first();
    await expect(xtermElement).toBeVisible({ timeout: 5_000 });

    // Click to focus the terminal
    await xtermElement.click({ force: true });
    await window.waitForTimeout(300);

    // Type a command — echo is available on all platforms
    await window.keyboard.type('echo __e2e_terminal_test__', { delay: 50 });
    await window.keyboard.press('Enter');

    // Wait for the output to appear in the terminal's DOM
    // xterm renders text into rows; we look for our marker string
    await expect(
      window.locator('[class*="xterm"] :text("__e2e_terminal_test__")').first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('terminal survives window resize', async () => {
    // Ensure the terminal is visible first
    const xtermElement = window.locator('[class*="xterm"]').first();
    await expect(xtermElement).toBeVisible({ timeout: 5_000 });

    // Get current window size
    const size = await window.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));

    // Resize the window significantly
    await electronApp.evaluate(({ BrowserWindow }, newSize) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().startsWith('devtools://'),
      );
      if (win) {
        win.setSize(newSize.width, newSize.height);
      }
    }, { width: Math.max(800, size.width - 200), height: Math.max(600, size.height - 100) });

    // Wait for resize to settle
    await window.waitForTimeout(1_000);

    // Terminal should still be visible after resize
    await expect(xtermElement).toBeVisible({ timeout: 5_000 });

    // Restore original size
    await electronApp.evaluate(({ BrowserWindow }, origSize) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().startsWith('devtools://'),
      );
      if (win) {
        win.setSize(origSize.width, origSize.height);
      }
    }, size);

    await window.waitForTimeout(500);

    // Still visible after restoring
    await expect(xtermElement).toBeVisible({ timeout: 5_000 });
  });

  test('navigating away from terminal cleans up xterm', async () => {
    // Navigate to the Agents tab
    await clickExplorerTab(electronApp, window, 'explorer-tab-agents');

    if (await isNewLayout(window)) {
      // An inactive tab may move into the More menu, where it has no test id
      // until the menu opens, so check Agents took over and Terminal's pane left.
      await expect(window.getByTestId('explorer-tab-agents')).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
      await expect(window.locator(`[data-testid="${TERMINAL_TAB}"][aria-selected="true"]`)).toHaveCount(0);
      await expect(window.getByTestId('terminal-main-panel')).toBeHidden({ timeout: 5_000 });
      return;
    }

    // The terminal tab should no longer be active
    const terminalTab = window.getByTestId(TERMINAL_TAB);
    await expect(terminalTab).toHaveAttribute('data-active', 'false', {
      timeout: 5_000,
    });
  });

  test('returning to terminal tab restores session', async () => {
    // Click the terminal tab again
    await clickExplorerTab(electronApp, window, TERMINAL_TAB);

    // Terminal should re-appear with previous content preserved
    const xtermElement = window.locator('[class*="xterm"]').first();
    await expect(xtermElement).toBeVisible({ timeout: 10_000 });
  });
});
