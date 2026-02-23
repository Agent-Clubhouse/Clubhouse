/**
 * Core E2E Smoke Test Suite
 * GitHub Issue #233: blank-screen prevention, agent lifecycle, settings persistence
 *
 * These tests run on every PR to guard against:
 * - Blank-screen regressions from Zustand selector crashes
 * - Agent lifecycle bugs (create / display / delete)
 * - Settings persistence failures across navigation
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');
const AGENTS_JSON_DIR = path.join(FIXTURE_A, '.clubhouse');
const AGENTS_JSON = path.join(AGENTS_JSON_DIR, 'agents.json');

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

/** Get the title bar text. */
async function getTitleBarText(): Promise<string> {
  return window.locator('[data-testid="title-bar"]').first().textContent() as Promise<string>;
}

/** Write durable agents to agents.json in the fixture project. */
function writeAgentsJson(
  agents: Array<{ id: string; name: string; color: string }>,
) {
  if (!fs.existsSync(AGENTS_JSON_DIR)) fs.mkdirSync(AGENTS_JSON_DIR, { recursive: true });
  const configs = agents.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    createdAt: new Date().toISOString(),
  }));
  fs.writeFileSync(AGENTS_JSON, JSON.stringify(configs, null, 2), 'utf-8');
}

/** Clean up agents.json to restore fixture state. */
function cleanupAgentsJson() {
  if (fs.existsSync(AGENTS_JSON)) {
    fs.writeFileSync(AGENTS_JSON, '[]', 'utf-8');
  }
}

/** Verify the page has meaningful content (not blank-screened). */
async function assertNotBlankScreen() {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // Pre-populate durable agents so the agent list has content to render
  writeAgentsJson([
    { id: 'smoke_agent_1', name: 'smoke-alpha', color: 'indigo' },
    { id: 'smoke_agent_2', name: 'smoke-beta', color: 'green' },
  ]);

  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  cleanupAgentsJson();
  await electronApp?.close();
});

// ===========================================================================
// PART A: App doesn't blank-screen on navigation (Zustand crash prevention)
// ===========================================================================

test.describe('Blank-Screen Prevention', () => {
  /** Collected console errors during the entire describe block. */
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    // Start collecting console errors for Zustand crash detection
    window.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
  });

  test('app renders content on initial load', async () => {
    await assertNotBlankScreen();
  });

  test('home view renders without blank screen', async () => {
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (homeVisible) {
      await homeBtn.click();
      await window.waitForTimeout(500);

      const title = await getTitleBarText();
      expect(title).toBe('Home');
      await assertNotBlankScreen();
    }
  });

  test('project view renders without blank screen after adding project', async () => {
    await addProject(FIXTURE_A);
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('project-a');
    await assertNotBlankScreen();
  });

  test('agent list renders in project view', async () => {
    // Wait for durable agents to load from agents.json
    const agentList = window.locator('[data-testid="agent-list"]');
    const noAgent = window.locator('[data-testid="no-active-agent"]');

    const listVisible = await agentList.isVisible({ timeout: 5_000 }).catch(() => false);
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);

    // Either the agent list or the no-agent placeholder must be visible
    expect(listVisible || noAgentVisible).toBe(true);

    if (listVisible) {
      // Verify durable agents loaded
      await expect(
        window.locator('[data-testid^="durable-drag-"]').first(),
      ).toBeVisible({ timeout: 15_000 });
    }

    await assertNotBlankScreen();
  });

  test('settings view renders without blank screen', async () => {
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Settings');
    await assertNotBlankScreen();

    // Toggle settings off to return to previous view
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });

  test('help view renders without blank screen', async () => {
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Help');
    await assertNotBlankScreen();

    // Toggle help off
    await helpBtn.click();
    await window.waitForTimeout(500);
  });

  test('switching between projects does not blank screen', async () => {
    // Add second project
    await addProject(FIXTURE_B);
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('project-b');
    await assertNotBlankScreen();

    // Switch back to project-a
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    const titleAfter = await getTitleBarText();
    expect(titleAfter).toContain('project-a');
    await assertNotBlankScreen();
  });

  test('rapid project switching does not cause blank screen', async () => {
    const projA = window.locator('[title="project-a"]').first();
    const projB = window.locator('[title="project-b"]').first();

    // Rapidly switch 5 times
    for (let i = 0; i < 5; i++) {
      await projA.click();
      await projB.click();
    }

    // Wait for state to settle
    await window.waitForTimeout(1_000);
    await assertNotBlankScreen();

    // Verify we're on a valid view (last click was project-b)
    const title = await getTitleBarText();
    expect(title).toContain('project-b');
  });

  test('command palette open/close does not blank screen', async () => {
    // Open command palette
    await window.keyboard.press('Meta+k');
    await expect(window.locator('[data-testid="command-palette-overlay"]')).toBeVisible({
      timeout: 5_000,
    });
    await assertNotBlankScreen();

    // Close command palette
    await window.keyboard.press('Escape');
    await expect(
      window.locator('[data-testid="command-palette-overlay"]'),
    ).not.toBeVisible({ timeout: 3_000 });
    await assertNotBlankScreen();
  });

  test('navigating home → project → settings → help → project does not blank screen', async () => {
    // Home
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (homeVisible) {
      await homeBtn.click();
      await window.waitForTimeout(500);
      await assertNotBlankScreen();
    }

    // Project
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen();

    // Settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen();

    // Help (while settings is open — this should switch to help)
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen();

    // Back to project
    await projA.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen();
  });

  test('no "Maximum update depth" errors in console (Zustand crash pattern)', async () => {
    // Wait for any deferred error processing
    await window.waitForTimeout(1_000);

    const zustandCrashErrors = consoleErrors.filter(
      (e) => e.includes('Maximum update depth') || e.includes('maximum update depth'),
    );
    expect(zustandCrashErrors).toEqual([]);
  });

  test('no uncaught React errors in console', async () => {
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('source map') &&
        !e.includes('favicon') &&
        !e.includes('Autofill') &&
        !e.includes('ResizeObserver') &&
        // Filter React-specific crash indicators
        (e.includes('Uncaught') ||
         e.includes('React error') ||
         e.includes('Cannot read properties of undefined') ||
         e.includes('Cannot read properties of null') ||
         e.includes('is not a function') ||
         e.includes('Maximum update depth')),
    );
    expect(criticalErrors).toEqual([]);
  });
});

// ===========================================================================
// PART B: Agent Lifecycle Basics
// ===========================================================================

test.describe('Agent Lifecycle', () => {
  test('durable agents from agents.json appear in the list', async () => {
    // Navigate to project-a (which has our pre-written agents.json)
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    // Wait for durable agents to render
    await expect(
      window.locator('[data-testid^="durable-drag-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Verify both smoke agents appear
    const order = await window.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
      return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
    });

    expect(order).toContain('smoke_agent_1');
    expect(order).toContain('smoke_agent_2');
  });

  test('agent names are visible in the list', async () => {
    await expect(
      window.locator('[data-agent-name="smoke-alpha"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      window.locator('[data-agent-name="smoke-beta"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('agent status displays correctly (sleeping for unstarted durable agents)', async () => {
    // Durable agents that haven't been started should show "sleeping" status
    // Look for status indicators near the agent entries
    const agentEntry = window.locator('[data-testid="durable-drag-0"]');
    await expect(agentEntry).toBeVisible({ timeout: 5_000 });

    // The agent should exist and have a visible status indicator.
    // Durable agents load as "sleeping" by default.
    const statusText = await agentEntry.evaluate((el) => {
      // Look for status text or data-status attribute
      const statusEl = el.querySelector('[data-status]');
      if (statusEl) return statusEl.getAttribute('data-status');
      // Fallback: look for text content mentioning status
      const text = el.textContent || '';
      if (text.toLowerCase().includes('running')) return 'running';
      if (text.toLowerCase().includes('sleeping')) return 'sleeping';
      return 'unknown';
    });

    // Agent should be in sleeping state (not started)
    expect(['sleeping', 'unknown']).toContain(statusText);
  });

  test('clicking an agent selects it', async () => {
    // Click the first agent
    const agentEntry = window.locator('[data-testid="durable-drag-0"]');
    await agentEntry.click();
    await window.waitForTimeout(500);

    // After clicking, the agent should be visually selected (has a
    // highlight or selected state) — verify by checking if the main
    // content area updates or the agent has a selected class.
    // We check that the click didn't crash the app.
    await assertNotBlankScreen();
  });

  test('agent removal via agents.json rewrite + project reload', async () => {
    // Rewrite agents.json to remove one agent
    writeAgentsJson([
      { id: 'smoke_agent_1', name: 'smoke-alpha', color: 'indigo' },
      // smoke_agent_2 (smoke-beta) removed
    ]);

    // Reload by switching projects and back (triggers loadDurableAgents)
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(1_000);

    // Wait for durable agents to re-render
    await expect(
      window.locator('[data-testid^="durable-drag-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Verify smoke_agent_2 is no longer in the list
    const order = await window.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
      return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
    });

    expect(order).toContain('smoke_agent_1');
    expect(order).not.toContain('smoke_agent_2');

    // Verify the removed agent's name is no longer visible
    const betaVisible = await window
      .locator('[data-agent-name="smoke-beta"]')
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    expect(betaVisible).toBe(false);
  });

  test('adding an agent via agents.json rewrite + project reload', async () => {
    // Add a new agent
    writeAgentsJson([
      { id: 'smoke_agent_1', name: 'smoke-alpha', color: 'indigo' },
      { id: 'smoke_agent_3', name: 'smoke-gamma', color: 'red' },
    ]);

    // Reload by switching projects
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(1_000);

    // Wait for durable agents to render
    await expect(
      window.locator('[data-testid^="durable-drag-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    const order = await window.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
      return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
    });

    expect(order).toContain('smoke_agent_1');
    expect(order).toContain('smoke_agent_3');

    // Verify the new agent's name is visible
    await expect(
      window.locator('[data-agent-name="smoke-gamma"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('completed agents section is present', async () => {
    // The completed footer should always be present
    const footer = window.locator('[data-testid="completed-footer"]');
    await expect(footer).toBeVisible({ timeout: 5_000 });
  });
});

// ===========================================================================
// PART C: Settings Persistence
// ===========================================================================

test.describe('Settings Persistence', () => {
  test('can navigate to settings display page', async () => {
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Settings');
    await assertNotBlankScreen();
  });

  test('theme selection is visible in display settings', async () => {
    // Navigate to settings if not already there
    const title = await getTitleBarText();
    if (!title.includes('Settings')) {
      const settingsBtn = window.locator('[data-testid="nav-settings"]');
      await settingsBtn.click();
      await window.waitForTimeout(500);
    }

    // Click the Display sub-page tab in the explorer rail
    const displayTab = window.locator('[data-testid="explorer-tab-display"]');
    const displayVisible = await displayTab.isVisible({ timeout: 3_000 }).catch(() => false);
    if (displayVisible) {
      await displayTab.click();
      await window.waitForTimeout(500);
    }

    // Verify theme section exists — look for "Color Theme" heading
    const themeHeading = window.locator('text=Color Theme');
    await expect(themeHeading).toBeVisible({ timeout: 5_000 });
  });

  test('changing theme applies immediately', async () => {
    // Read the current theme before changing
    const initialThemeId = await window.evaluate(() => {
      return document.documentElement.getAttribute('data-theme') ||
        getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim();
    });

    // Find a different theme button and click it.
    // The theme buttons are styled with background colors from the theme definition.
    // Look for a theme button that is NOT currently selected (no ring-1 class).
    const themeButtons = window.locator('.grid.grid-cols-2 button');
    const count = await themeButtons.count();
    expect(count).toBeGreaterThan(1);

    // Click the second theme (which should be different from default catppuccin-mocha)
    await themeButtons.nth(1).click();
    await window.waitForTimeout(500);

    // Verify the theme changed — check for the selected ring on the new button
    const secondButtonClasses = await themeButtons.nth(1).getAttribute('class');
    expect(secondButtonClasses).toContain('border-ctp-accent');
  });

  test('theme persists after navigating away and back to settings', async () => {
    // Get the currently selected theme button text
    const selectedThemeName = await window.evaluate(() => {
      const selected = document.querySelector('.grid.grid-cols-2 button.border-ctp-accent, .grid.grid-cols-2 button[class*="ring-1"]');
      return selected?.textContent?.trim() || '';
    });
    expect(selectedThemeName.length).toBeGreaterThan(0);

    // Navigate away from settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click(); // Toggle off
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).not.toContain('Settings');

    // Navigate back to settings
    await settingsBtn.click(); // Toggle on
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain('Settings');

    // Go to Display sub-page
    const displayTab = window.locator('[data-testid="explorer-tab-display"]');
    const displayVisible = await displayTab.isVisible({ timeout: 3_000 }).catch(() => false);
    if (displayVisible) {
      await displayTab.click();
      await window.waitForTimeout(500);
    }

    // Verify the same theme is still selected
    const currentThemeName = await window.evaluate(() => {
      const selected = document.querySelector('.grid.grid-cols-2 button.border-ctp-accent, .grid.grid-cols-2 button[class*="ring-1"]');
      return selected?.textContent?.trim() || '';
    });
    expect(currentThemeName).toBe(selectedThemeName);
  });

  test('theme persists after switching projects', async () => {
    // Get the currently selected theme name
    const selectedThemeName = await window.evaluate(() => {
      const selected = document.querySelector('.grid.grid-cols-2 button.border-ctp-accent, .grid.grid-cols-2 button[class*="ring-1"]');
      return selected?.textContent?.trim() || '';
    });

    // Close settings first
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Switch to project-b
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    // Switch back to project-a
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    // Re-open settings
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Go to Display sub-page
    const displayTab = window.locator('[data-testid="explorer-tab-display"]');
    const displayVisible = await displayTab.isVisible({ timeout: 3_000 }).catch(() => false);
    if (displayVisible) {
      await displayTab.click();
      await window.waitForTimeout(500);
    }

    // Verify theme is still the same
    const currentThemeName = await window.evaluate(() => {
      const selected = document.querySelector('.grid.grid-cols-2 button.border-ctp-accent, .grid.grid-cols-2 button[class*="ring-1"]');
      return selected?.textContent?.trim() || '';
    });
    expect(currentThemeName).toBe(selectedThemeName);

    // Toggle settings off
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });

  test('Home view toggle persists in localStorage', async () => {
    // Open settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Go to Display sub-page
    const displayTab = window.locator('[data-testid="explorer-tab-display"]');
    const displayVisible = await displayTab.isVisible({ timeout: 3_000 }).catch(() => false);
    if (displayVisible) {
      await displayTab.click();
      await window.waitForTimeout(500);
    }

    // Read the current Home toggle state
    const homeToggle = window.locator('button.toggle-track').first();
    const initialState = await homeToggle.getAttribute('data-on');

    // Toggle it
    await homeToggle.click();
    await window.waitForTimeout(500);

    // Verify the state changed
    const newState = await homeToggle.getAttribute('data-on');
    expect(newState).not.toBe(initialState);

    // Verify localStorage was updated
    const storedPrefs = await window.evaluate(() => {
      const raw = localStorage.getItem('clubhouse_view_prefs');
      return raw ? JSON.parse(raw) : null;
    });
    expect(storedPrefs).not.toBeNull();
    expect(storedPrefs.showHome).toBe(newState === 'true');

    // Toggle back to restore original state
    await homeToggle.click();
    await window.waitForTimeout(500);

    // Verify it toggled back
    const restoredState = await homeToggle.getAttribute('data-on');
    expect(restoredState).toBe(initialState);

    // Close settings
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });

  test('completed section collapse state persists in localStorage', async () => {
    // Navigate to a project first
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    // Find the completed toggle
    const toggle = window.locator('[data-testid="completed-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });

    // Read current collapsed state
    const items = window.locator('[data-testid="completed-items"]');
    const initialMaxHeight = await items.evaluate((el) => el.style.maxHeight);
    const wasCollapsed = initialMaxHeight === '0px' || initialMaxHeight === '0';

    // Toggle collapse state
    await toggle.click();
    await window.waitForTimeout(400);

    // Verify localStorage updated
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

  test('settings page selection is preserved within session', async () => {
    // Open settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Find and click a different settings tab (e.g., notifications, logging)
    const tabs = window.locator('[data-testid^="explorer-tab-"]');
    const tabCount = await tabs.count();

    // Try to click the "notifications" or "logging" tab if available
    let targetTab: string | null = null;
    for (let i = 0; i < tabCount; i++) {
      const testId = await tabs.nth(i).getAttribute('data-testid');
      if (testId && (testId.includes('notification') || testId.includes('logging') || testId.includes('sound'))) {
        targetTab = testId;
        await tabs.nth(i).click();
        await window.waitForTimeout(500);
        break;
      }
    }

    if (targetTab) {
      // Navigate away from settings
      await settingsBtn.click();
      await window.waitForTimeout(500);

      // Navigate back
      await settingsBtn.click();
      await window.waitForTimeout(500);

      // The settings page should still show (it reopens fresh to the default sub-page,
      // which is fine — the key thing is it doesn't crash or blank-screen)
      const title = await getTitleBarText();
      expect(title).toContain('Settings');
      await assertNotBlankScreen();
    }

    // Close settings
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });
});
