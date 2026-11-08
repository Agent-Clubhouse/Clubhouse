/**
 * E2E: the project Terminal tab.
 *
 * Runs on the new layout, and on classic in the Classic layout E2E job
 * (#2843). On the new layout the Terminal tab is in the title bar (or its More
 * menu) and has no list of its own: the sidebar keeps the project tree, and
 * the selection there is the terminal's target (listTabs.ts, scope.ts).
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';
import {
  addProject,
  assertActiveProject,
  assertRunLayout,
  clickExplorerTab,
  getTitleBarText,
  selectProject,
} from './smoke-helpers';
import { isNewLayout } from './layout';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const TERMINAL_TAB = 'explorer-tab-plugin:terminal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  await clickExplorerTab(electronApp, window, TERMINAL_TAB);

  // Verify tab activation via title bar. The new layout's breadcrumb shows the
  // tab's title in every window width.
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
  await assertRunLayout(window);

  // Add a project so plugin tabs become available
  await addProject(electronApp, window, FIXTURE_A);

  // Ensure the project is active
  await assertActiveProject(window, 'project-a');

  // Wait for plugins and background git operations to settle
  await window.waitForTimeout(2_000);

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
    const terminalTab = window.getByTestId(TERMINAL_TAB);
    if (!(await isNewLayout(window))) {
      await expect(terminalTab).toBeVisible({ timeout: 10_000 });
      return;
    }
    // New layout: in the title bar, or in its More menu when the tabs don't
    // all fit. An overflowed tab only has its test id while More is open.
    const more = window.getByTestId('title-more');
    await expect(async () => {
      if (!(await terminalTab.isVisible()) && await more.isVisible() && await more.getAttribute('aria-expanded') !== 'true') {
        await more.click();
      }
      await expect(terminalTab).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    if (await more.isVisible() && await more.getAttribute('aria-expanded') === 'true') await more.click();
  });

  test('clicking terminal tab switches view to Terminal', async () => {
    await navigateToTerminal();
    const title = await getTitleBarText(window);
    expect(title).toContain('Terminal');
    if (await isNewLayout(window)) {
      // The active tab always stays in the title bar's row, never in More.
      await expect(window.getByTestId(TERMINAL_TAB)).toHaveAttribute('aria-selected', 'true');
    }
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
    if (await isNewLayout(window)) {
      // No targets list here: the sidebar keeps the project tree.
      await expect(window.getByTestId('project-tree')).toBeVisible({ timeout: 5_000 });
      await expect(sidebar).toHaveCount(0);
      return;
    }
    await expect(sidebar).toBeVisible({ timeout: 5_000 });
  });

  test('terminal sidebar shows Targets header and Project target', async () => {
    test.skip(await isNewLayout(window), 'The new layout has no targets list: the sidebar selection is the target (listTabs.ts SCOPE_REPLACES_LIST), covered by the next test.');
    await navigateToTerminal();

    const sidebar = window.locator('[data-testid="terminal-sidebar-panel"]');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    await expect(sidebar.locator('text=Targets')).toBeVisible({ timeout: 5_000 });
    await expect(sidebar.locator('text=Project')).toBeVisible({ timeout: 5_000 });
  });

  test('new layout: the selected project header is the target, at the project root', async () => {
    test.skip(!(await isNewLayout(window)), 'The new layout\'s scope target; classic picks targets from the terminal\'s own list, covered by the previous test.');
    await navigateToTerminal();

    // Select project-a's header in the tree, which stays beside the Terminal
    // tab, so the scope (and the terminal's target) is that project.
    await selectProject(window, 'project-a');
    await assertActiveProject(window, 'project-a');
    await expect(
      window.locator('[data-testid="project-tree"] [role="treeitem"][aria-label="project-a"]'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByTestId('explorer-tab-plugin:terminal')).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByTestId('terminal-root-note')).toHaveText('project root', { timeout: 10_000 });
    await expect(window.getByTestId('terminal-cwd')).toHaveAttribute('title', FIXTURE_A);
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
    await clickExplorerTab(electronApp, window, 'explorer-tab-agents');
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
    await clickExplorerTab(electronApp, window, 'explorer-tab-agents');
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
