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

/** Get the title bar text. */
async function getTitleBarText(): Promise<string> {
  return window.locator('[data-testid="title-bar"]').first().textContent() as Promise<string>;
}

/** Dismiss any notification banners that may block clicks. */
async function dismissNotifications() {
  // Dismiss "No git repository" or other notifications that overlay the UI
  const closeButtons = window.locator('button:has-text("x")');
  const count = await closeButtons.count();
  for (let i = 0; i < count; i++) {
    const btn = closeButtons.nth(i);
    const isVisible = await btn.isVisible().catch(() => false);
    if (isVisible) {
      // Check if it's near a notification (not a normal UI close button)
      const parent = btn.locator('..');
      const text = await parent.textContent().catch(() => '');
      if (text?.includes('git repository') || text?.includes('not available')) {
        await btn.click().catch(() => {});
        await window.waitForTimeout(200);
      }
    }
  }
}

/** Navigate to the terminal tab and verify it's active. */
async function navigateToTerminal() {
  const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
  await terminalTab.scrollIntoViewIfNeeded();
  await terminalTab.click({ force: true });

  // Verify tab activation via title bar (proven pattern from other E2E tests)
  await expect(window.locator('[data-testid="title-bar"]')).toContainText(
    'Terminal',
    { timeout: 10_000 },
  );
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

  // Wait for plugins to fully load
  await window.waitForTimeout(1_000);

  // Dismiss notification banners that might block clicks
  await dismissNotifications();
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

  test('clicking terminal tab switches view to Terminal', async () => {
    await navigateToTerminal();
    const title = await getTitleBarText();
    expect(title).toContain('Terminal');
  });
});

// ---------------------------------------------------------------------------
// 2. Terminal Widget Renders
// ---------------------------------------------------------------------------

test.describe('Terminal Widget Rendering', () => {
  test('terminal main panel and sidebar render after tab click', async () => {
    await navigateToTerminal();

    const mainPanel = window.locator('[data-testid="terminal-main-panel"]');
    await expect(mainPanel).toBeVisible({ timeout: 15_000 });

    const sidebar = window.locator('[data-testid="terminal-sidebar-panel"]');
    await expect(sidebar).toBeVisible({ timeout: 5_000 });
  });

  test('terminal sidebar shows Targets header and Project target', async () => {
    await navigateToTerminal();

    const sidebar = window.locator('[data-testid="terminal-sidebar-panel"]');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    await expect(sidebar.locator('text=Targets')).toBeVisible({ timeout: 5_000 });
    await expect(sidebar.locator('text=Project')).toBeVisible({ timeout: 5_000 });
  });

  test('terminal spawns and shows Running status', async () => {
    await navigateToTerminal();

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });
  });

  test('shell terminal xterm widget is rendered', async () => {
    await navigateToTerminal();

    // Wait for the terminal to be in Running state first
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

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
    await navigateToTerminal();

    // Wait for terminal to be running
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Focus the terminal
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 10_000 });
    await shellTerminal.click();
    await window.waitForTimeout(500);

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
    await navigateToTerminal();

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 5_000 });

    // Get current viewport size
    const viewportSize = window.viewportSize();
    const origWidth = viewportSize?.width ?? 1280;
    const origHeight = viewportSize?.height ?? 720;

    // Resize smaller
    await window.setViewportSize({ width: 800, height: 400 });
    await window.waitForTimeout(500);

    // Verify terminal is still visible and Running after resize
    await expect(shellTerminal).toBeVisible();
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
    await navigateToTerminal();

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 5_000 });

    // Resize window
    await window.setViewportSize({ width: 900, height: 500 });
    await window.waitForTimeout(500);

    // Focus and type a command
    await shellTerminal.click();
    await window.waitForTimeout(300);

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
    await navigateToTerminal();

    // Wait for terminal to be running
    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Click restart
    const restartBtn = window.locator('[data-testid="terminal-restart-btn"]');
    await expect(restartBtn).toBeVisible({ timeout: 5_000 });
    await restartBtn.click();

    // Terminal should return to Running after restart completes
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Verify the terminal is functional after restart
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminal).toBeVisible({ timeout: 5_000 });

    await shellTerminal.click();
    await window.waitForTimeout(500);

    const marker = `RESTART_CHECK_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');

    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });
  });

  test('switching away from terminal tab and back restores session', async () => {
    await navigateToTerminal();

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Type a unique marker in terminal
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await shellTerminal.click();
    await window.waitForTimeout(300);

    const marker = `PERSIST_CHECK_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');
    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });

    // Switch to agents tab
    const agentsTab = window.locator('[data-testid="explorer-tab-agents"]');
    await agentsTab.scrollIntoViewIfNeeded();
    await agentsTab.click({ force: true });
    await expect(window.locator('[data-testid="title-bar"]')).toContainText(
      'Agents',
      { timeout: 5_000 },
    );

    // Switch back to terminal tab
    await navigateToTerminal();

    // The terminal should still be running (session persists)
    await expect(status).toContainText('Running', { timeout: 10_000 });

    // Shell terminal should be visible after reconnect
    const shellTerminalAfter = window.locator('[data-testid="shell-terminal"]');
    await expect(shellTerminalAfter).toBeVisible({ timeout: 10_000 });
  });

  test('terminal main panel is hidden when switching to agents tab', async () => {
    await navigateToTerminal();

    // Verify terminal is visible
    const mainPanel = window.locator('[data-testid="terminal-main-panel"]');
    await expect(mainPanel).toBeVisible({ timeout: 10_000 });

    // Switch to agents tab
    const agentsTab = window.locator('[data-testid="explorer-tab-agents"]');
    await agentsTab.scrollIntoViewIfNeeded();
    await agentsTab.click({ force: true });
    await expect(window.locator('[data-testid="title-bar"]')).toContainText(
      'Agents',
      { timeout: 5_000 },
    );

    // Terminal main panel should no longer be visible
    await expect(mainPanel).not.toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 6. Terminal Exit Handling (Alternate Screen Buffer Reset)
// ---------------------------------------------------------------------------

test.describe('Terminal Exit Handling', () => {
  test('terminal shows exited status when shell process exits', async () => {
    await navigateToTerminal();

    const status = window.locator('[data-testid="terminal-status"]');
    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Send "exit" to the shell to terminate it
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await shellTerminal.click();
    await window.waitForTimeout(300);

    await window.keyboard.type('exit', { delay: 30 });
    await window.keyboard.press('Enter');

    // Terminal status should change to Exited
    await expect(status).toContainText('Exited', { timeout: 15_000 });
  });

  test('restart after exit re-spawns the terminal', async () => {
    // The previous test should have left the terminal in exited state
    const status = window.locator('[data-testid="terminal-status"]');
    const currentStatus = await status.textContent().catch(() => '');

    if (!currentStatus?.includes('Exited')) {
      // Navigate to terminal and exit it first
      await navigateToTerminal();
      await expect(status).toContainText('Running', { timeout: 15_000 });

      const shellTerminal = window.locator('[data-testid="shell-terminal"]');
      await shellTerminal.click();
      await window.waitForTimeout(300);
      await window.keyboard.type('exit', { delay: 30 });
      await window.keyboard.press('Enter');
      await expect(status).toContainText('Exited', { timeout: 15_000 });
    }

    // Click restart to re-spawn
    const restartBtn = window.locator('[data-testid="terminal-restart-btn"]');
    await restartBtn.click();

    await expect(status).toContainText('Running', { timeout: 15_000 });

    // Verify terminal is functional after restart
    const shellTerminal = window.locator('[data-testid="shell-terminal"]');
    await shellTerminal.click();
    await window.waitForTimeout(500);

    const marker = `EXIT_RESTART_${Date.now()}`;
    await window.keyboard.type(`echo ${marker}`, { delay: 30 });
    await window.keyboard.press('Enter');

    await expect(shellTerminal).toContainText(marker, { timeout: 10_000 });
  });
});
