/**
 * E2E Smoke Test: Blank-Screen Prevention
 *
 * Verifies the app does not blank-screen on common navigation flows.
 * Guards against Zustand selector crashes, missing content, and
 * infinite re-render console errors.
 *
 * Issue #233 — Consolidated from smoke.spec.ts + PR #257
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  FIXTURE_SMOKE,
  FIXTURE_B,
  addProject,
  assertNotBlankScreen,
  assertTitleBarContains,
  getTitleBarText,
  navigateToSmokeProject,
} from './smoke-helpers';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

// Collect console errors throughout the entire test suite
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());

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
// Navigation — blank-screen prevention
// ---------------------------------------------------------------------------

test.describe('Blank-Screen Prevention — Navigation', () => {
  test('home view renders content on initial launch', async () => {
    await assertNotBlankScreen(window);

    const titleBar = window.locator('[data-testid="title-bar"]');
    await expect(titleBar).toBeVisible({ timeout: 5_000 });
    const titleText = await titleBar.textContent();
    expect(titleText!.length).toBeGreaterThan(0);
  });

  test('adding project-smoke renders project view (not blank)', async () => {
    await addProject(electronApp, window, FIXTURE_SMOKE);
    await window.waitForTimeout(500);
    await assertNotBlankScreen(window);
    await assertTitleBarContains(window, 'project-smoke');
  });

  test('adding project-b renders project view (not blank)', async () => {
    await addProject(electronApp, window, FIXTURE_B);
    await assertNotBlankScreen(window);
    await assertTitleBarContains(window, 'project-b');
  });

  test('switching to project-smoke renders content', async () => {
    await navigateToSmokeProject(window);
    await assertNotBlankScreen(window);
    await assertTitleBarContains(window, 'project-smoke');
  });

  test('agent list or no-agent placeholder renders in project view', async () => {
    const agentList = window.locator('[data-testid="agent-list"]');
    const noAgent = window.locator('[data-testid="no-active-agent"]');

    const listVisible = await agentList.isVisible({ timeout: 5_000 }).catch(() => false);
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);

    expect(listVisible || noAgentVisible).toBe(true);
    await assertNotBlankScreen(window);
  });

  test('settings view renders content (not blank)', async () => {
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen(window);
    await assertTitleBarContains(window, 'Settings');

    // Toggle settings off
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });

  test('help view renders content (not blank)', async () => {
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen(window);
    await assertTitleBarContains(window, 'Help');
  });

  test('returning from help to project view renders content', async () => {
    // Toggle help off
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen(window);
    const titleText = await getTitleBarText(window);
    expect(titleText).not.toContain('Help');
  });

  test('switching between projects does not blank screen', async () => {
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    await assertTitleBarContains(window, 'project-b');
    await assertNotBlankScreen(window);

    await navigateToSmokeProject(window);
    await assertTitleBarContains(window, 'project-smoke');
    await assertNotBlankScreen(window);
  });

  test('rapid project switching (10x) does not blank-screen', async () => {
    const projSmoke = window.locator('[title="project-smoke"]').first();
    const projB = window.locator('[title="project-b"]').first();

    for (let i = 0; i < 10; i++) {
      await projSmoke.click();
      await projB.click();
    }

    await window.waitForTimeout(1_000);
    await assertNotBlankScreen(window);
  });

  test('rapid navigation between views does not blank-screen', async () => {
    const projSmoke = window.locator('[title="project-smoke"]').first();
    const projB = window.locator('[title="project-b"]').first();
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    const helpBtn = window.locator('[data-testid="nav-help"]');

    await projSmoke.click();
    await settingsBtn.click();
    await projB.click();
    await helpBtn.click();
    await projSmoke.click();
    await settingsBtn.click();
    await helpBtn.click();
    await projB.click();

    await window.waitForTimeout(1_000);
    await assertNotBlankScreen(window);
  });

  test('navigating home → project → settings → help → project does not blank screen', async () => {
    // Home
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (homeVisible) {
      await homeBtn.click();
      await window.waitForTimeout(500);
      await assertNotBlankScreen(window);
    }

    // Project
    await navigateToSmokeProject(window);
    await assertNotBlankScreen(window);

    // Settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen(window);

    // Help (while settings is open)
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen(window);

    // Back to project
    await navigateToSmokeProject(window);
    await assertNotBlankScreen(window);
  });

  test('navigating to home and back does not blank-screen', async () => {
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (homeVisible) {
      await homeBtn.click();
      await window.waitForTimeout(500);
      await assertNotBlankScreen(window);

      await navigateToSmokeProject(window);
      await assertNotBlankScreen(window);
    }
  });

  test('command palette open/close does not blank screen', async () => {
    // Open command palette
    await window.keyboard.press('Meta+k');
    await expect(window.locator('[data-testid="command-palette-overlay"]')).toBeVisible({
      timeout: 5_000,
    });

    // The overlay should contain options
    const options = window.locator('[data-testid="command-palette-overlay"] [role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    // Background content should still exist
    const root = window.locator('#root');
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);

    // Close palette
    await window.keyboard.press('Escape');
    await expect(
      window.locator('[data-testid="command-palette-overlay"]'),
    ).not.toBeVisible({ timeout: 3_000 });

    // Verify content restored
    await assertNotBlankScreen(window);
  });
});

// ---------------------------------------------------------------------------
// Console error guards
// ---------------------------------------------------------------------------

test.describe('Blank-Screen Prevention — Console Error Guard', () => {
  test('no "Maximum update depth" errors (includes "Too many re-renders")', async () => {
    await window.waitForTimeout(1_000);

    const infiniteLoopErrors = consoleErrors.filter(
      (e) =>
        e.includes('Maximum update depth') ||
        e.includes('maximum update depth') ||
        e.includes('Too many re-renders'),
    );
    expect(infiniteLoopErrors).toEqual([]);
  });

  test('no uncaught React errors in console', async () => {
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('source map') &&
        !e.includes('favicon') &&
        !e.includes('Autofill') &&
        !e.includes('ResizeObserver') &&
        !e.includes('net::ERR') &&
        (e.includes('Uncaught') ||
         e.includes('unhandled') ||
         e.includes('React error') ||
         e.includes('Cannot read properties of undefined') ||
         e.includes('Cannot read properties of null') ||
         e.includes('is not a function') ||
         e.includes('Maximum update depth')),
    );
    expect(criticalErrors).toEqual([]);
  });

  test('no blank screen at end of all navigation tests', async () => {
    await assertNotBlankScreen(window);
  });
});
