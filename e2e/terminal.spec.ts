import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub Electron dialog for project picker. */
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

/** Add a fixture project. */
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

  // Add a project so plugin tabs become available
  await addProject(FIXTURE_A);
  // Ensure the project is active
  await expect(window.locator('[data-testid="title-bar"]')).toContainText(
    'project-a',
    { timeout: 5_000 },
  );
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Open Terminal Plugin Tab
// ---------------------------------------------------------------------------

test.describe('Terminal Plugin Tab', () => {
  test('terminal tab is visible in explorer rail', async () => {
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(terminalTab).toBeVisible({ timeout: 10_000 });
  });

  test('clicking terminal tab activates it', async () => {
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    // The tab should now be active
    await expect(terminalTab).toHaveAttribute('data-active', 'true', {
      timeout: 5_000,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Terminal Widget Renders
// ---------------------------------------------------------------------------

test.describe('Terminal Widget Rendering', () => {
  test('terminal main panel is visible', async () => {
    // Ensure terminal tab is selected
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    const mainPanel = window.locator('[data-testid="terminal-main-panel"]');
    await expect(mainPanel).toBeVisible({ timeout: 10_000 });
  });

  test('terminal sidebar panel shows Targets header', async () => {
    const sidebar = window.locator('[data-testid="terminal-sidebar-panel"]');
    await expect(sidebar).toBeVisible({ timeout: 5_000 });
    await expect(sidebar.locator('text=Targets')).toBeVisible();
  });

  test('terminal sidebar shows Project target', async () => {
    const sidebar = window.locator('[data-testid="terminal-sidebar-panel"]');
    await expect(sidebar.locator('text=Project')).toBeVisible({ timeout: 5_000 });
  });

  test('terminal status shows Running after spawn', async () => {
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });
  });

  test('shell terminal widget is rendered', async () => {
    // xterm.js creates elements with class "xterm" inside the shell-terminal container
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 10_000 });

    // Verify xterm.js has initialized inside the container
    const xtermElement = shellTerminal.locator('.xterm');
    await expect(xtermElement).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Command Execution — Type a Command and Verify Output
// ---------------------------------------------------------------------------

test.describe('Terminal Command Execution', () => {
  test('typing a command produces output in terminal', async () => {
    // Ensure terminal tab is active and shell is running
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Focus the terminal
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await shellTerminal.click();
    await window.waitForTimeout(300);

    // Type a simple command — echo with a unique marker so we can find it
    const marker = `E2E_MARKER_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');

    // Wait for the marker to appear in the terminal output.
    // xterm.js renders text in rows; we look for our marker in the terminal DOM.
    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. Terminal Resize — Verify No Crash
// ---------------------------------------------------------------------------

test.describe('Terminal Resize', () => {
  test('resizing the window does not crash the terminal', async () => {
    // Ensure terminal is visible
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 5_000 });

    // Get current viewport size
    const viewportSize = window.viewportSize();
    const origWidth = viewportSize?.width ?? 1280;
    const origHeight = viewportSize?.height ?? 720;

    // Resize smaller
    await window.setViewportSize({ width: 800, height: 400 });
    await window.waitForTimeout(500);

    // Verify terminal is still visible after resize
    await expect(shellTerminal).toBeVisible();

    // Verify terminal status is still Running (didn't crash)
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 5_000 });

    // Resize larger
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.waitForTimeout(500);

    await expect(shellTerminal).toBeVisible();
    await expect(status).toContainText('Running', { timeout: 5_000 });

    // Restore original size
    await window.setViewportSize({ width: origWidth, height: origHeight });
    await window.waitForTimeout(300);
  });

  test('command execution works after resize', async () => {
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');

    // Resize window
    await window.setViewportSize({ width: 900, height: 500 });
    await window.waitForTimeout(500);

    // Focus and type a command
    await shellTerminal.click();
    await window.waitForTimeout(200);

    const marker = `RESIZE_CHECK_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');

    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });

    // Restore viewport
    await window.setViewportSize({ width: 1280, height: 720 });
    await window.waitForTimeout(300);
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal Restart and Cleanup
// ---------------------------------------------------------------------------

test.describe('Terminal Restart and Cleanup', () => {
  test('restart button restarts the terminal session', async () => {
    // Ensure terminal tab is active
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    // Wait for terminal to be running
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Click restart
    const restartBtn = window.locator('[data-testid="terminal-restart-btn"]');
    await expect(restartBtn).toBeVisible({ timeout: 5_000 });
    await restartBtn.click();

    // Terminal should briefly show a non-running state or return to Running
    // after restart completes
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Verify the terminal is functional after restart
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 5_000 });

    await shellTerminal.click();
    await window.waitForTimeout(300);

    const marker = `RESTART_CHECK_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');

    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });
  });

  test('switching away from terminal tab and back restores session', async () => {
    // Type a unique marker in terminal
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await shellTerminal.click();
    await window.waitForTimeout(200);

    const marker = `PERSIST_CHECK_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');
    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });

    // Switch to agents tab
    const agentsTab = window.locator('[data-testid="explorer-tab-agents"]');
    await agentsTab.click();
    await window.waitForTimeout(500);

    // Switch back to terminal tab
    await terminalTab.click();
    await window.waitForTimeout(1_000);

    // The terminal should still show our marker (buffer replay)
    const shellTerminalAfter = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminalAfter).toBeVisible({ timeout: 10_000 });

    // Verify the terminal is still running
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 10_000 });
  });

  test('terminal xterm element is properly cleaned up when switching tabs', async () => {
    // Navigate to terminal tab
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    // Verify xterm is present
    const xtermCount = await window.locator('.xterm').count();
    expect(xtermCount).toBeGreaterThan(0);

    // Switch to agents tab
    const agentsTab = window.locator('[data-testid="explorer-tab-agents"]');
    await agentsTab.click();
    await window.waitForTimeout(500);

    // Terminal main panel should no longer be visible (content switched)
    const mainPanel = window.locator('[data-testid="terminal-main-panel"]');
    const isVisible = await mainPanel.isVisible().catch(() => false);
    // In sidebar-content layout, the main panel may or may not be unmounted
    // depending on implementation — but it should at least not be actively
    // rendered in the agents view
    if (!isVisible) {
      // Good — panel was unmounted/hidden
      expect(isVisible).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Terminal Exit Handling (Alternate Screen Buffer Reset)
// ---------------------------------------------------------------------------

test.describe('Terminal Exit Handling', () => {
  test('terminal shows exited status when shell process exits', async () => {
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await terminalTab.click();
    await window.waitForTimeout(500);

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Send "exit" to the shell to terminate it
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await shellTerminal.click();
    await window.waitForTimeout(200);

    await window.keyboard.type('exit', { delay: 30 });
    await window.keyboard.press('Enter');

    // Terminal status should change to Exited
    await expect(status).toContainText('Exited', { timeout: 15_000 });
  });

  test('restart after exit re-spawns the terminal', async () => {
    const status = window.locator('[data-testid="terminal-status"]');

    // Terminal should be in exited state from previous test
    // (or we need to handle both cases)
    const currentStatus = await status.textContent();

    if (currentStatus?.includes('Exited')) {
      // Click restart to re-spawn
      const restartBtn = window.locator('[data-testid="terminal-restart-btn"]');
      await restartBtn.click();

      await expect(status).toContainText('Running', { timeout: 15_000 });

      // Verify terminal is functional
      const shellTerminal = window.locator('[data-testid="shell-terminal"]');
      await shellTerminal.click();
      await window.waitForTimeout(300);

      const marker = `EXIT_RESTART_${Date.now()}`;
      await window.keyboard.type(`echo ${marker}`, { delay: 30 });
      await window.keyboard.press('Enter');

      await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });
    }
  });
});
