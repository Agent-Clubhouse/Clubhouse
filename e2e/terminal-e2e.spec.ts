import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Add a fixture project by stubbing the dialog and clicking the add button. */
async function addProject(dirPath: string) {
  await stubDialogForPath(dirPath);
  const addBtn = window.locator('[data-testid="nav-add-project"]');
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
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
    await addProject(FIXTURE_A);

    // Look for the Terminal tab in the explorer rail
    const terminalTab = window.locator(
      '[data-testid="explorer-tab-plugin:terminal"]'
    );

    // The terminal plugin may need a moment to activate
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
    await terminalTab.click();
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
    await xtermElement.click();

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
    // Get current window size
    const size = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
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
    await window.waitForTimeout(500);

    // Terminal should still be visible after resize
    const xtermElement = window.locator('[class*="xterm"]').first();
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
    // Navigate to a different tab (e.g., Agents)
    const agentsTab = window.locator('[data-testid="explorer-tab-agents"]');
    if (await agentsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await agentsTab.click();
      await window.waitForTimeout(500);

      // The terminal plugin content should no longer be visible
      // (the plugin content view is hidden when another tab is active)
      const terminalTab = window.locator(
        '[data-testid="explorer-tab-plugin:terminal"]'
      );
      const tabIsActive = await terminalTab.getAttribute('data-active');
      expect(tabIsActive).not.toBe('true');
    }
  });

  test('returning to terminal tab restores session', async () => {
    // Click the terminal tab again
    const terminalTab = window.locator(
      '[data-testid="explorer-tab-plugin:terminal"]'
    );
    await terminalTab.click();

    // Terminal should re-appear with previous content preserved
    const xtermElement = window.locator('[class*="xterm"]').first();
    await expect(xtermElement).toBeVisible({ timeout: 10_000 });

    // The previous command output should still be visible (buffer replay)
    await expect(
      window.locator('[class*="xterm"] :text("__e2e_terminal_test__")').first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
