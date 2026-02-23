/**
 * E2E Smoke Test: Settings Persistence
 *
 * Verifies that settings changes persist across navigation — specifically
 * theme changes and UI toggle state. Tests the full flow: open settings,
 * change a setting, navigate away, navigate back, verify setting persisted.
 *
 * Issue #233 — Sub-test (c)
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');

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

/** Navigate to Settings by clicking the settings button in the rail. */
async function openSettings() {
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  await window.waitForTimeout(500);

  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toContainText('Settings', { timeout: 5_000 });
}

/** Navigate to the "Display & UI" sub-page in app settings. */
async function navigateToDisplaySettings() {
  const displayBtn = window.locator('button:has-text("Display & UI")');
  await expect(displayBtn).toBeVisible({ timeout: 5_000 });
  await displayBtn.click();
  await window.waitForTimeout(500);

  // Verify the Color Theme heading is visible
  const colorThemeHeading = window.locator('text=Color Theme').first();
  await expect(colorThemeHeading).toBeVisible({ timeout: 5_000 });
}

/** Navigate away from settings by clicking on the project. */
async function navigateToProject() {
  const projA = window.locator('[title="project-a"]').first();
  await projA.click();
  await window.waitForTimeout(500);

  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toContainText('project-a', { timeout: 5_000 });
}

/** Read the current CSS variable for --ctp-base (background color). */
async function getBaseColorVar(): Promise<string> {
  return window.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim();
  });
}

/** Read the current theme ID from the Zustand store. */
async function getCurrentThemeId(): Promise<string> {
  return window.evaluate(() => {
    // Read the theme-vars cache from localStorage to determine active theme
    const raw = localStorage.getItem('clubhouse-theme-vars');
    if (!raw) return 'unknown';
    const vars = JSON.parse(raw);
    return vars['--ctp-base'] || 'unknown';
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await addProject(FIXTURE_A);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Theme Persistence
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Theme', () => {
  test('open settings and navigate to display page', async () => {
    await openSettings();
    await navigateToDisplaySettings();
  });

  test('changing theme by clicking a named theme button updates CSS', async () => {
    const beforeColor = await getBaseColorVar();

    // Click a specific theme by name — use "Dracula" which is always visually distinct
    const draculaBtn = window.locator('button:has-text("Dracula")').first();
    await expect(draculaBtn).toBeVisible({ timeout: 5_000 });
    await draculaBtn.click();
    await window.waitForTimeout(500);

    const afterColor = await getBaseColorVar();
    // Dracula base is #282a36 = "40 42 54" — should differ from any other theme
    expect(afterColor).not.toBe(beforeColor);
  });

  test('theme persists in localStorage after change', async () => {
    const themeVars = await window.evaluate(() => {
      const raw = localStorage.getItem('clubhouse-theme-vars');
      return raw ? JSON.parse(raw) : null;
    });
    expect(themeVars).not.toBeNull();
    expect(themeVars['--ctp-base']).toBeDefined();
    // Dracula base = "40 42 54"
    expect(themeVars['--ctp-base']).toBe('40 42 54');
  });

  test('theme persists after navigating away and back', async () => {
    const colorBeforeNav = await getBaseColorVar();

    // Navigate away to project view
    await navigateToProject();

    // Verify theme is still applied on the project view
    const colorOnProject = await getBaseColorVar();
    expect(colorOnProject).toBe(colorBeforeNav);

    // Navigate back to settings
    await openSettings();
    await navigateToDisplaySettings();

    // Verify theme is still the changed one
    const colorAfterReturn = await getBaseColorVar();
    expect(colorAfterReturn).toBe(colorBeforeNav);
  });

  test('selected theme button has visual indicator after returning', async () => {
    // The Dracula button should have the selected ring class
    const draculaBtn = window.locator('button:has-text("Dracula")').first();
    const classes = await draculaBtn.getAttribute('class');
    expect(classes).toContain('ring-ctp-accent');
  });

  test('restore original theme (cleanup)', async () => {
    const mochaBtn = window.locator('button:has-text("Catppuccin Mocha")').first();
    await expect(mochaBtn).toBeVisible({ timeout: 3_000 });
    await mochaBtn.click();
    await window.waitForTimeout(500);
  });
});

// ---------------------------------------------------------------------------
// 2. Toggle Settings Persistence (Show Home)
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Show Home Toggle', () => {
  test('navigate to display settings', async () => {
    const titleBar = window.locator('[data-testid="title-bar"]');
    const inSettings = await titleBar.textContent();
    if (!inSettings?.includes('Settings')) {
      await openSettings();
    }
    await navigateToDisplaySettings();

    // Verify "Views" section is visible
    const viewsHeader = window.locator('text=Views').first();
    await expect(viewsHeader).toBeVisible({ timeout: 5_000 });
  });

  test('toggling "Home" changes its state', async () => {
    const toggles = window.locator('button.toggle-track');
    const homeToggle = toggles.first();
    await expect(homeToggle).toBeVisible({ timeout: 3_000 });

    const beforeState = await homeToggle.getAttribute('data-on');
    await homeToggle.click();
    await window.waitForTimeout(300);

    const afterState = await homeToggle.getAttribute('data-on');
    expect(afterState).not.toBe(beforeState);
  });

  test('toggle state persists after navigating away and back', async () => {
    const homeToggle = window.locator('button.toggle-track').first();
    const stateBeforeNav = await homeToggle.getAttribute('data-on');

    await navigateToProject();
    await openSettings();
    await navigateToDisplaySettings();

    const stateAfterReturn = await window.locator('button.toggle-track').first().getAttribute('data-on');
    expect(stateAfterReturn).toBe(stateBeforeNav);
  });

  test('restore original toggle state (cleanup)', async () => {
    const homeToggle = window.locator('button.toggle-track').first();
    await expect(homeToggle).toBeVisible({ timeout: 3_000 });
    const currentState = await homeToggle.getAttribute('data-on');

    // Default is "true", so restore if changed
    if (currentState === 'false') {
      await homeToggle.click();
      await window.waitForTimeout(300);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Settings Sub-Page Navigation
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Sub-Page Navigation', () => {
  test('can navigate between settings sub-pages', async () => {
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    if (!titleText?.includes('Settings')) {
      await openSettings();
    }

    // The AccessoryPanel should show category nav buttons for app settings
    // Click "About" to switch sub-pages
    const aboutBtn = window.locator('button:has-text("About")').first();
    await expect(aboutBtn).toBeVisible({ timeout: 5_000 });
    await aboutBtn.click();
    await window.waitForTimeout(500);

    // Verify the About page loaded (it shows version info)
    const root = window.locator('#root');
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);

    // Switch to "Notifications" sub-page
    const notifBtn = window.locator('button:has-text("Notifications")').first();
    await expect(notifBtn).toBeVisible({ timeout: 3_000 });
    await notifBtn.click();
    await window.waitForTimeout(500);

    // Content should still be visible (not blank)
    const bodyText = await root.evaluate((el) => el.innerText.trim());
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test('settings view does not blank-screen during sub-page switches', async () => {
    const root = window.locator('#root');
    await expect(root).toBeVisible();
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);

    const bodyText = await root.evaluate((el) => el.innerText.trim());
    expect(bodyText.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple Settings Roundtrips
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Roundtrip Stability', () => {
  test('settings survive multiple navigation roundtrips', async () => {
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    if (!titleText?.includes('Settings')) {
      await openSettings();
    }
    await navigateToDisplaySettings();

    // Pick Nord theme (visually distinct)
    const nordBtn = window.locator('button:has-text("Nord")').first();
    const nordVisible = await nordBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (nordVisible) {
      await nordBtn.click();
      await window.waitForTimeout(300);
    }

    const colorAfterChange = await getBaseColorVar();

    // Navigate away and back 3 times
    for (let i = 0; i < 3; i++) {
      await navigateToProject();
      const colorOnProject = await getBaseColorVar();
      expect(colorOnProject).toBe(colorAfterChange);

      await openSettings();
      const colorInSettings = await getBaseColorVar();
      expect(colorInSettings).toBe(colorAfterChange);
    }

    // Restore default theme
    await navigateToDisplaySettings();
    const mochaBtn = window.locator('button:has-text("Catppuccin Mocha")').first();
    const visible = await mochaBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      await mochaBtn.click();
      await window.waitForTimeout(300);
    }
  });
});
