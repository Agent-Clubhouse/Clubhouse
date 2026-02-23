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

  // Verify we're in settings
  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toContainText('Settings', { timeout: 5_000 });
}

/** Navigate away from settings by clicking on the project. */
async function navigateToProject() {
  const projA = window.locator('[title="project-a"]').first();
  await projA.click();
  await window.waitForTimeout(500);

  // Verify we left settings
  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toContainText('project-a', { timeout: 5_000 });
}

/** Click the "Clubhouse" app settings context in the settings left panel. */
async function selectAppSettings() {
  const clubhouseBtn = window.locator('button:has-text("Clubhouse")').first();
  const visible = await clubhouseBtn.isVisible({ timeout: 3_000 }).catch(() => false);
  if (visible) {
    await clubhouseBtn.click();
    await window.waitForTimeout(300);
  }
}

/** Read the current CSS variable for --ctp-base (background color). */
async function getBaseColorVar(): Promise<string> {
  return window.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim();
  });
}

/** Read the localStorage theme cache. */
async function getThemeVarsFromStorage(): Promise<Record<string, string> | null> {
  return window.evaluate(() => {
    const raw = localStorage.getItem('clubhouse-theme-vars');
    return raw ? JSON.parse(raw) : null;
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
  let originalBaseColor: string;

  test('record initial theme state', async () => {
    originalBaseColor = await getBaseColorVar();
    expect(originalBaseColor.length).toBeGreaterThan(0);
  });

  test('open settings and navigate to display page', async () => {
    await openSettings();

    // The settings context picker should be visible with "Clubhouse" option
    await selectAppSettings();

    // The Display & UI settings should be the default view
    // Look for "Color Theme" heading
    const colorThemeHeading = window.locator('text=Color Theme').first();
    await expect(colorThemeHeading).toBeVisible({ timeout: 5_000 });
  });

  test('changing theme updates CSS variables immediately', async () => {
    // Record the current base color
    const beforeColor = await getBaseColorVar();

    // Find theme buttons — they are styled with backgroundColor
    // The themes are in a grid, each is a <button> with a theme name span
    const themeButtons = window.locator('.grid button');
    const buttonCount = await themeButtons.count();
    expect(buttonCount).toBeGreaterThan(1);

    // Find a theme button that is NOT currently selected (no ring-1 class)
    // Click a different theme — look for a non-selected one
    let clickedTheme = false;
    for (let i = 0; i < buttonCount; i++) {
      const btn = themeButtons.nth(i);
      const classes = await btn.getAttribute('class');
      if (classes && !classes.includes('ring-ctp-accent')) {
        await btn.click();
        clickedTheme = true;
        await window.waitForTimeout(500);
        break;
      }
    }

    expect(clickedTheme).toBe(true);

    // Verify the CSS variable changed
    const afterColor = await getBaseColorVar();
    expect(afterColor).not.toBe(beforeColor);
  });

  test('theme persists in localStorage after change', async () => {
    const themeVars = await getThemeVarsFromStorage();
    expect(themeVars).not.toBeNull();
    expect(themeVars!['--ctp-base']).toBeDefined();
  });

  test('theme persists after navigating away and back', async () => {
    // Record the current theme color
    const colorBeforeNav = await getBaseColorVar();

    // Navigate away to project view
    await navigateToProject();

    // Verify theme is still applied on the project view
    const colorOnProject = await getBaseColorVar();
    expect(colorOnProject).toBe(colorBeforeNav);

    // Navigate back to settings
    await openSettings();
    await selectAppSettings();

    // Verify theme is still the changed one
    const colorAfterReturn = await getBaseColorVar();
    expect(colorAfterReturn).toBe(colorBeforeNav);
  });

  test('selected theme button has visual indicator after returning', async () => {
    // Wait for color theme section to load
    const colorThemeHeading = window.locator('text=Color Theme').first();
    await expect(colorThemeHeading).toBeVisible({ timeout: 5_000 });

    // At least one theme button should have the selected ring
    const themeButtons = window.locator('.grid button');
    let foundSelected = false;
    const buttonCount = await themeButtons.count();
    for (let i = 0; i < buttonCount; i++) {
      const classes = await themeButtons.nth(i).getAttribute('class');
      if (classes && classes.includes('ring-ctp-accent')) {
        foundSelected = true;
        break;
      }
    }
    expect(foundSelected).toBe(true);
  });

  test('restore original theme (cleanup)', async () => {
    // Find the Catppuccin Mocha button (default theme) by its text
    const mochaBtn = window.locator('button:has-text("Catppuccin Mocha")').first();
    const visible = await mochaBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      await mochaBtn.click();
      await window.waitForTimeout(500);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Toggle Settings Persistence (Show Home)
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Show Home Toggle', () => {
  test('navigate to display settings', async () => {
    // Ensure we're in settings
    const titleBar = window.locator('[data-testid="title-bar"]');
    const inSettings = await titleBar.textContent();
    if (!inSettings?.includes('Settings')) {
      await openSettings();
    }
    await selectAppSettings();

    // Verify "Views" section is visible
    const viewsHeader = window.locator('text=Views').first();
    await expect(viewsHeader).toBeVisible({ timeout: 5_000 });
  });

  test('toggling "Home" changes its state', async () => {
    // Find the toggle button for "Home"
    const toggles = window.locator('button.toggle-track');
    const homeToggle = toggles.first();
    await expect(homeToggle).toBeVisible({ timeout: 3_000 });

    // Record current state
    const beforeState = await homeToggle.getAttribute('data-on');

    // Click to toggle
    await homeToggle.click();
    await window.waitForTimeout(300);

    // Verify state changed
    const afterState = await homeToggle.getAttribute('data-on');
    expect(afterState).not.toBe(beforeState);
  });

  test('toggle state persists after navigating away and back', async () => {
    // Record the toggle state
    const toggles = window.locator('button.toggle-track');
    const homeToggle = toggles.first();
    const stateBeforeNav = await homeToggle.getAttribute('data-on');

    // Navigate away
    await navigateToProject();

    // Navigate back to settings
    await openSettings();
    await selectAppSettings();

    // Verify state persisted
    const stateAfterReturn = await window.locator('button.toggle-track').first().getAttribute('data-on');
    expect(stateAfterReturn).toBe(stateBeforeNav);
  });

  test('restore original toggle state (cleanup)', async () => {
    // Toggle back if needed to reset to original state
    const toggles = window.locator('button.toggle-track');
    const homeToggle = toggles.first();
    const currentState = await homeToggle.getAttribute('data-on');

    // Default is "true", so restore if changed
    if (currentState === 'false') {
      await homeToggle.click();
      await window.waitForTimeout(300);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Settings Sub-Page Navigation Persistence
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Sub-Page Navigation', () => {
  test('can navigate between settings contexts', async () => {
    // Ensure we're in settings
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    if (!titleText?.includes('Settings')) {
      await openSettings();
    }

    // The settings context picker should show "Clubhouse" and project entries
    const clubhouseBtn = window.locator('button:has-text("Clubhouse")').first();
    await expect(clubhouseBtn).toBeVisible({ timeout: 3_000 });

    // Click project-a context
    const projBtn = window.locator('button:has-text("project-a")').first();
    const projVisible = await projBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (projVisible) {
      await projBtn.click();
      await window.waitForTimeout(300);

      // Verify project settings content loaded
      // (Should show project-specific settings)
      const root = window.locator('#root');
      const childCount = await root.evaluate((el) => el.children.length);
      expect(childCount).toBeGreaterThan(0);

      // Switch back to Clubhouse context
      await clubhouseBtn.click();
      await window.waitForTimeout(300);
    }
  });

  test('settings view does not blank-screen during context switches', async () => {
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
    // Open settings and change theme to something distinct
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    if (!titleText?.includes('Settings')) {
      await openSettings();
    }
    await selectAppSettings();

    // Pick Dracula theme (visually distinct)
    const draculaBtn = window.locator('button:has-text("Dracula")').first();
    const draculaVisible = await draculaBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (draculaVisible) {
      await draculaBtn.click();
      await window.waitForTimeout(300);
    }

    const colorAfterChange = await getBaseColorVar();

    // Navigate away and back multiple times
    for (let i = 0; i < 3; i++) {
      await navigateToProject();
      const colorOnProject = await getBaseColorVar();
      expect(colorOnProject).toBe(colorAfterChange);

      await openSettings();
      const colorInSettings = await getBaseColorVar();
      expect(colorInSettings).toBe(colorAfterChange);
    }

    // Restore default theme
    await selectAppSettings();
    const mochaBtn = window.locator('button:has-text("Catppuccin Mocha")').first();
    const visible = await mochaBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      await mochaBtn.click();
      await window.waitForTimeout(300);
    }
  });
});
