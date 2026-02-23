/**
 * E2E Smoke Test: Blank-Screen Prevention (Zustand crash prevention)
 *
 * Verifies the app does not blank-screen on common navigation flows.
 * The Zustand selector crash pattern (CRITICAL risk) is caught by unit tests,
 * but this suite exercises the actual rendered app to detect blank screens,
 * missing content, and infinite re-render console errors.
 *
 * Issue #233 — Sub-test (a)
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');

// Collect console errors throughout the entire test suite
const consoleErrors: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Assert that #root has visible children (i.e. the app did not blank-screen). */
async function assertNotBlankScreen() {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);

  // Verify there is at least *some* meaningful text rendered
  const bodyText = await root.evaluate((el) => el.innerText.trim());
  expect(bodyText.length).toBeGreaterThan(0);
}

/** Assert the title bar is visible and contains expected text. */
async function assertTitleBarContains(expected: string) {
  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toBeVisible({ timeout: 5_000 });
  await expect(titleBar).toContainText(expected, { timeout: 5_000 });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());

  // Capture console errors throughout all tests
  window.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Home view renders (no projects)
// ---------------------------------------------------------------------------

test.describe('Blank-Screen Prevention — Navigation', () => {
  test('home view renders content on initial launch', async () => {
    await assertNotBlankScreen();

    // Title bar should show "Home" or have some content
    const titleBar = window.locator('[data-testid="title-bar"]');
    await expect(titleBar).toBeVisible({ timeout: 5_000 });
    const titleText = await titleBar.textContent();
    expect(titleText!.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Add projects — verify content renders
  // ---------------------------------------------------------------------------

  test('adding project-a renders project view (not blank)', async () => {
    await addProject(FIXTURE_A);
    await assertNotBlankScreen();
    await assertTitleBarContains('project-a');
  });

  test('adding project-b renders project view (not blank)', async () => {
    await addProject(FIXTURE_B);
    await assertNotBlankScreen();
    await assertTitleBarContains('project-b');
  });

  // ---------------------------------------------------------------------------
  // 3. Navigate to each major view — verify content renders
  // ---------------------------------------------------------------------------

  test('switching to project-a renders content', async () => {
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen();
    await assertTitleBarContains('project-a');
  });

  test('settings view renders content (not blank)', async () => {
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen();
    await assertTitleBarContains('Settings');

    // Settings should show at minimum a heading or the settings context picker
    const settingsHeading = window.locator('text=Settings').first();
    await expect(settingsHeading).toBeVisible({ timeout: 5_000 });
  });

  test('help view renders content (not blank)', async () => {
    // Close settings first by toggling
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(300);

    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen();
    await assertTitleBarContains('Help');
  });

  test('returning from help to project view renders content', async () => {
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen();
    // Should be back on project view
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    expect(titleText).not.toContain('Help');
  });

  // ---------------------------------------------------------------------------
  // 4. Switch between projects — verify agent list renders
  // ---------------------------------------------------------------------------

  test('switching projects shows agent list or empty state', async () => {
    // Ensure we're on project-a
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen();

    // The agent list or the no-active-agent placeholder should be visible
    const agentList = window.locator('[data-testid="agent-list"]');
    const noAgent = window.locator('[data-testid="no-active-agent"]');

    const listVisible = await agentList.isVisible({ timeout: 3_000 }).catch(() => false);
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);
    expect(listVisible || noAgentVisible).toBe(true);

    // Now switch to project-b
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen();
    await assertTitleBarContains('project-b');
  });

  // ---------------------------------------------------------------------------
  // 5. Command palette open/close — no blank screen
  // ---------------------------------------------------------------------------

  test('opening command palette does not blank the screen', async () => {
    await window.keyboard.press('Meta+k');
    await expect(window.locator('[data-testid="command-palette-overlay"]')).toBeVisible({
      timeout: 5_000,
    });

    // The overlay should contain options
    const options = window.locator('[data-testid="command-palette-overlay"] [role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    // Background content should still exist (not destroyed)
    const root = window.locator('#root');
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);

    // Close palette
    await window.keyboard.press('Escape');
    await expect(window.locator('[data-testid="command-palette-overlay"]')).not.toBeVisible({
      timeout: 3_000,
    });
  });

  test('closing command palette restores content', async () => {
    await assertNotBlankScreen();

    // Title bar should still have project info
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    expect(titleText!.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 6. Rapid navigation — no blank screen
  // ---------------------------------------------------------------------------

  test('rapid navigation between views does not blank-screen', async () => {
    const projA = window.locator('[title="project-a"]').first();
    const projB = window.locator('[title="project-b"]').first();
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    const helpBtn = window.locator('[data-testid="nav-help"]');

    // Rapidly cycle through views
    await projA.click();
    await settingsBtn.click();
    await projB.click();
    await helpBtn.click();
    await projA.click();
    await settingsBtn.click();
    await helpBtn.click();
    await projB.click();

    // Wait for state to settle
    await window.waitForTimeout(1_000);

    await assertNotBlankScreen();
  });

  test('rapid project switching does not blank-screen', async () => {
    const projA = window.locator('[title="project-a"]').first();
    const projB = window.locator('[title="project-b"]').first();

    for (let i = 0; i < 10; i++) {
      await projA.click();
      await projB.click();
    }

    await window.waitForTimeout(1_000);
    await assertNotBlankScreen();
  });

  // ---------------------------------------------------------------------------
  // 7. Home navigation — no blank screen
  // ---------------------------------------------------------------------------

  test('navigating to home and back does not blank-screen', async () => {
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (homeVisible) {
      await homeBtn.click();
      await window.waitForTimeout(500);
      await assertNotBlankScreen();

      // Navigate back to a project
      const projA = window.locator('[title="project-a"]').first();
      await projA.click();
      await window.waitForTimeout(500);
      await assertNotBlankScreen();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Console error guard — Zustand crash detection
// ---------------------------------------------------------------------------

test.describe('Blank-Screen Prevention — Console Error Guard', () => {
  test('no "Maximum update depth" errors throughout navigation', async () => {
    const infiniteLoopErrors = consoleErrors.filter((e) =>
      e.includes('Maximum update depth') ||
      e.includes('Too many re-renders') ||
      e.includes('maximum update depth exceeded'),
    );
    expect(infiniteLoopErrors).toEqual([]);
  });

  test('no uncaught React errors throughout navigation', async () => {
    const reactErrors = consoleErrors.filter(
      (e) =>
        (e.includes('Uncaught') || e.includes('unhandled')) &&
        !e.includes('DevTools') &&
        !e.includes('source map') &&
        !e.includes('favicon') &&
        !e.includes('Autofill') &&
        !e.includes('net::ERR'),
    );
    expect(reactErrors).toEqual([]);
  });

  test('no blank screen at end of all navigation tests', async () => {
    const root = window.locator('#root');
    await expect(root).toBeVisible({ timeout: 5_000 });
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);
  });
});
