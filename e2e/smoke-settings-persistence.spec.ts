/**
 * E2E Smoke Test: Settings Persistence
 *
 * Verifies that theme and toggle settings persist across navigation,
 * project switches, and multiple roundtrips. Tests settings sub-page
 * navigation and completed-section collapse persistence.
 *
 * Issue #233 — Consolidated from smoke.spec.ts + PR #257. Runs on the new
 * layout, and on classic in the Classic layout E2E job (#2843).
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  FIXTURE_SMOKE,
  FIXTURE_B,
  addProject,
  assertNotBlankScreen,
  assertRunLayout,
  openSettings,
  closeSettings,
  openSettingsPage,
  navigateToDisplaySettings,
  navigateToSmokeProject,
  selectProject,
  getBaseColorVar,
} from './smoke-helpers';
import { isNewLayout } from './layout';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await assertRunLayout(window);

  await addProject(electronApp, window, FIXTURE_SMOKE);
  await addProject(electronApp, window, FIXTURE_B);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// Theme persistence
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Theme', () => {
  test('open settings and navigate to display page', async () => {
    await openSettings(window);
    await navigateToDisplaySettings(window);
  });

  test('theme selection heading is visible', async () => {
    const themeHeading = window.locator('text=Color theme');
    await expect(themeHeading).toBeVisible({ timeout: 5_000 });
  });

  test('changing theme by clicking named theme (Dracula) updates CSS variables', async () => {
    const beforeColor = await getBaseColorVar(window);

    const draculaBtn = window.locator('button:has-text("Dracula")').first();
    await expect(draculaBtn).toBeVisible({ timeout: 5_000 });
    await draculaBtn.click();
    await window.waitForTimeout(500);

    const afterColor = await getBaseColorVar(window);
    expect(afterColor).not.toBe(beforeColor);
  });

  test('theme persists in localStorage after change (clubhouse-theme-vars key)', async () => {
    const themeVars = await window.evaluate(() => {
      const raw = localStorage.getItem('clubhouse-theme-vars');
      return raw ? JSON.parse(raw) : null;
    });
    expect(themeVars).not.toBeNull();
    expect(themeVars['--ctp-base']).toBeDefined();
    // Dracula base = "40 42 54"
    expect(themeVars['--ctp-base']).toBe('40 42 54');
  });

  test('theme persists after navigating away and back (CSS variable check)', async () => {
    const colorBeforeNav = await getBaseColorVar(window);

    // Navigate away to project view
    await navigateToSmokeProject(window);
    const colorOnProject = await getBaseColorVar(window);
    expect(colorOnProject).toBe(colorBeforeNav);

    // Navigate back to settings
    await openSettings(window);
    await navigateToDisplaySettings(window);
    const colorAfterReturn = await getBaseColorVar(window);
    expect(colorAfterReturn).toBe(colorBeforeNav);
  });

  test('selected theme button has visual indicator after returning', async () => {
    const draculaBtn = window.locator('button:has-text("Dracula")').first();
    await expect(draculaBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('theme persists after switching projects (project-b roundtrip)', async () => {
    const colorBefore = await getBaseColorVar(window);

    await closeSettings(window);

    // Switch to project-b
    await selectProject(window, 'project-b');
    await window.waitForTimeout(500);

    // Switch back to smoke project
    await navigateToSmokeProject(window);

    // Re-open settings
    await openSettings(window);
    await navigateToDisplaySettings(window);

    const colorAfter = await getBaseColorVar(window);
    expect(colorAfter).toBe(colorBefore);
  });

  test('restore original theme (cleanup)', async () => {
    const mochaBtn = window.locator('button:has-text("Catppuccin Mocha")').first();
    await expect(mochaBtn).toBeVisible({ timeout: 3_000 });
    await mochaBtn.click();
    await window.waitForTimeout(500);
  });
});

// ---------------------------------------------------------------------------
// Display settings (the Home toggle was removed for v1)
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Display', () => {
  test('Display settings have the Classic layout switch and no Home toggle', async () => {
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    if (!titleText?.includes('Settings')) {
      await openSettings(window);
    }
    await navigateToDisplaySettings(window);

    await expect(window.locator('[role="switch"][aria-label="Classic layout"]').first()).toBeVisible({ timeout: 5_000 });
    await expect(window.locator('[role="switch"][aria-label="Home"]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Navigation & stability
// ---------------------------------------------------------------------------

test.describe('Settings Persistence — Navigation & Stability', () => {
  test('settings sub-page navigation (Notifications, Logging, About, Display & UI)', async () => {
    const titleBar = window.locator('[data-testid="title-bar"]');
    const titleText = await titleBar.textContent();
    if (!titleText?.includes('Settings')) {
      await openSettings(window);
    }

    const subPages: Array<[string, string]> = [['notifications', 'Notifications'], ['logging', 'Logging'], ['about', 'About'], ['display', 'Display & UI']];
    if (await isNewLayout(window)) {
      // Every page is in the sidebar's settings list.
      for (const [page, label] of subPages) {
        await openSettingsPage(window, page, label);
        await expect(window.getByTestId(`settings-nav-app-${page}`)).toHaveAttribute('aria-current', 'page');
        await assertNotBlankScreen(window);
      }
    } else {
      for (const [, pageName] of subPages) {
        const btn = window.locator(`button:has-text("${pageName}")`);
        const visible = await btn.isVisible({ timeout: 2_000 }).catch(() => false);
        if (visible) {
          await btn.click();
          await window.waitForTimeout(300);
          await assertNotBlankScreen(window);
        }
      }
    }

    await closeSettings(window);
  });

  test('completed section collapse persists in localStorage', async () => {
    test.skip(await isNewLayout(window), 'The Completed footer is classic only; the new layout lists finished quick agents in its tree.');
    await navigateToSmokeProject(window);
    await window.waitForTimeout(500);

    const toggle = window.locator('[data-testid="completed-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });

    const items = window.locator('[data-testid="completed-items"]');
    const initialMaxHeight = await items.evaluate((el) => el.style.maxHeight);
    const wasCollapsed = initialMaxHeight === '0px' || initialMaxHeight === '0';

    // Toggle collapse state
    await toggle.click();
    await window.waitForTimeout(400);

    const storedValue = await window.evaluate(() =>
      localStorage.getItem('clubhouse_completed_collapsed'),
    );
    const isNowCollapsed = storedValue === 'true';
    expect(isNowCollapsed).not.toBe(wasCollapsed);

    // Toggle back to restore
    await toggle.click();
    await window.waitForTimeout(400);

    const restoredValue = await window.evaluate(() =>
      localStorage.getItem('clubhouse_completed_collapsed'),
    );
    expect(restoredValue === 'true').toBe(wasCollapsed);
  });

  test('3x roundtrip stability test (Nord theme)', async () => {
    await openSettings(window);
    await navigateToDisplaySettings(window);

    // Pick Nord theme
    const nordBtn = window.locator('button:has-text("Nord")').first();
    const nordVisible = await nordBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (nordVisible) {
      await nordBtn.click();
      await window.waitForTimeout(300);
    }

    const colorAfterChange = await getBaseColorVar(window);

    // Navigate away and back 3 times
    for (let i = 0; i < 3; i++) {
      await navigateToSmokeProject(window);
      const colorOnProject = await getBaseColorVar(window);
      expect(colorOnProject).toBe(colorAfterChange);

      await openSettings(window);
      const colorInSettings = await getBaseColorVar(window);
      expect(colorInSettings).toBe(colorAfterChange);
    }

    // Restore default theme
    await navigateToDisplaySettings(window);
    const mochaBtn = window.locator('button:has-text("Catppuccin Mocha")').first();
    const visible = await mochaBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      await mochaBtn.click();
      await window.waitForTimeout(300);
    }
  });
});
