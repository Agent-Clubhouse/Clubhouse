/**
 * Core E2E Smoke Test Suite
 * GitHub Issue #233: blank-screen prevention, agent lifecycle, settings persistence
 *
 * These tests run on every PR to guard against:
 * - Blank-screen regressions from Zustand selector crashes
 * - Agent lifecycle bugs (create / display / delete)
 * - Settings persistence failures across navigation
 *
 * Uses a dedicated fixture (project-smoke) to avoid conflicts with other
 * parallel E2E test files that share project-a / project-b fixtures.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

// Dedicated fixtures for smoke tests — not shared with other spec files
const FIXTURE_SMOKE = path.resolve(__dirname, 'fixtures/project-smoke');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');
const AGENTS_JSON_DIR = path.join(FIXTURE_SMOKE, '.clubhouse');
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

/** Write durable agents to agents.json in the smoke fixture project. */
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
  if (fs.existsSync(AGENTS_JSON_DIR)) {
    fs.rmSync(AGENTS_JSON_DIR, { recursive: true, force: true });
  }
}

/** Verify the page has meaningful content (not blank-screened). */
async function assertNotBlankScreen() {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);
}

/**
 * Navigate to the Display & UI settings sub-page.
 * Settings must already be open (explorerTab === 'settings').
 * The category nav is in the AccessoryPanel, using plain buttons.
 */
async function navigateToDisplaySettings() {
  const displayBtn = window.locator('button:has-text("Display & UI")');
  await expect(displayBtn).toBeVisible({ timeout: 5_000 });
  await displayBtn.click();
  await window.waitForTimeout(500);
}

/**
 * Ensure we're on the agents tab for the smoke project.
 * Clicks the project in the rail and waits for the agents tab.
 */
async function navigateToSmokeProject() {
  const proj = window.locator('[title="project-smoke"]').first();
  await proj.click();
  await window.waitForTimeout(500);
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
    await addProject(FIXTURE_SMOKE);
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('project-smoke');
    await assertNotBlankScreen();
  });

  test('agent list or no-agent placeholder renders in project view', async () => {
    // The app should show either the agent list (with durable agents) or
    // the no-active-agent placeholder — never a blank screen.
    const agentList = window.locator('[data-testid="agent-list"]');
    const noAgent = window.locator('[data-testid="no-active-agent"]');

    const listVisible = await agentList.isVisible({ timeout: 5_000 }).catch(() => false);
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);

    // Either the agent list or the no-agent placeholder must be visible
    expect(listVisible || noAgentVisible).toBe(true);
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

    // Switch back to smoke project
    await navigateToSmokeProject();

    const titleAfter = await getTitleBarText();
    expect(titleAfter).toContain('project-smoke');
    await assertNotBlankScreen();
  });

  test('rapid project switching does not cause blank screen', async () => {
    const projSmoke = window.locator('[title="project-smoke"]').first();
    const projB = window.locator('[title="project-b"]').first();

    // Rapidly switch 5 times
    for (let i = 0; i < 5; i++) {
      await projSmoke.click();
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
    await navigateToSmokeProject();
    await assertNotBlankScreen();

    // Settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen();

    // Help (while settings is open — tests the toggle-off-settings + toggle-on-help path)
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);
    await assertNotBlankScreen();

    // Back to project
    await navigateToSmokeProject();
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
    // Navigate to smoke project (which has our pre-written agents.json)
    await navigateToSmokeProject();

    // Wait for durable agents to render
    await expect(
      window.locator('[data-testid^="durable-drag-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Verify both smoke agents appear via their data-agent-id attributes
    const order = await window.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
      return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
    });

    expect(order).toContain('smoke_agent_1');
    expect(order).toContain('smoke_agent_2');
  });

  test('agent names are visible in the list', async () => {
    // Agent names are set as data-agent-name on the AgentListItem elements
    await expect(
      window.locator('[data-agent-name="smoke-alpha"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      window.locator('[data-agent-name="smoke-beta"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('agent status displays correctly (sleeping for unstarted durable agents)', async () => {
    // Durable agents that haven't been started should show "sleeping" status
    // The AgentListItem renders a status label span below the name
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_1"]');
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    // Check that the agent item contains status text indicating sleeping state
    const itemText = await agentItem.textContent();
    // Sleeping durable agents display "Sleeping" as their status label
    expect(itemText?.toLowerCase()).toContain('sleeping');
  });

  test('clicking an agent selects it and updates the main content area', async () => {
    // Click the first smoke agent
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_1"]');
    await agentItem.click();
    await window.waitForTimeout(500);

    // After clicking a sleeping durable agent, the main content should show
    // either the SleepingAgent view or the no-active-agent placeholder
    // (depending on whether the store accepts the selection)
    await assertNotBlankScreen();

    // Verify the clicked agent is marked as active in the DOM
    const isActive = await agentItem.getAttribute('data-active');
    expect(isActive).toBe('true');
  });

  test('agent delete button is visible for sleeping durable agents', async () => {
    // The delete action button should be visible for sleeping durable agents
    // It's rendered inside the agent item's action bar
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_2"]');
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    // Hover over the agent to ensure action buttons are visible
    await agentItem.hover();
    await window.waitForTimeout(300);

    // Check for the delete action button or the overflow menu
    const deleteBtn = agentItem.locator('[data-testid="action-delete"]');
    const overflowBtn = agentItem.locator('[data-testid="action-overflow"]');

    const deleteVisible = await deleteBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    const overflowVisible = await overflowBtn.isVisible({ timeout: 2_000 }).catch(() => false);

    // Delete button should be directly visible OR in the overflow menu
    expect(deleteVisible || overflowVisible).toBe(true);
  });

  test('completed agents section is present in agent view', async () => {
    // Ensure we're on the agents tab for the smoke project
    await navigateToSmokeProject();
    await window.waitForTimeout(500);

    // The completed footer should always be present when viewing agents
    const footer = window.locator('[data-testid="completed-footer"]');
    await expect(footer).toBeVisible({ timeout: 5_000 });

    // Verify the completed toggle button shows a count
    const toggle = window.locator('[data-testid="completed-toggle"]');
    const text = await toggle.textContent();
    expect(text).toMatch(/Completed \(\d+\)/);
  });

  test('switching projects preserves per-project agent view', async () => {
    // Switch to project-b (no agents)
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    // project-b should show no-active-agent or an empty agent list
    const noAgent = window.locator('[data-testid="no-active-agent"]');
    const agentItem = window.locator('[data-testid^="agent-item-smoke"]');
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);
    const smokeAgentVisible = await agentItem.isVisible({ timeout: 1_000 }).catch(() => false);

    // Smoke agents should NOT be visible in project-b (cross-project guard)
    expect(smokeAgentVisible).toBe(false);

    // Switch back to smoke project — agents should reappear
    await navigateToSmokeProject();
    await window.waitForTimeout(500);

    await expect(
      window.locator('[data-testid^="durable-drag-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    const order = await window.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
      return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
    });

    expect(order).toContain('smoke_agent_1');
    expect(order).toContain('smoke_agent_2');
  });
});

// ===========================================================================
// PART C: Settings Persistence
// ===========================================================================

test.describe('Settings Persistence', () => {
  test('can navigate to settings and display sub-page', async () => {
    // Open settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Settings');
    await assertNotBlankScreen();

    // Navigate to Display & UI sub-page via the category nav
    await navigateToDisplaySettings();
  });

  test('theme selection is visible in display settings', async () => {
    // Verify theme section exists — look for "Color Theme" heading
    const themeHeading = window.locator('text=Color Theme');
    await expect(themeHeading).toBeVisible({ timeout: 5_000 });
  });

  test('changing theme applies immediately', async () => {
    // Find theme buttons in the grid
    const themeButtons = window.locator('.grid.grid-cols-2 button');
    const count = await themeButtons.count();
    expect(count).toBeGreaterThan(1);

    // Click the second theme (different from default catppuccin-mocha)
    await themeButtons.nth(1).click();
    await window.waitForTimeout(500);

    // Verify the theme changed — check for the selected ring on the new button
    const secondButtonClasses = await themeButtons.nth(1).getAttribute('class');
    expect(secondButtonClasses).toContain('border-ctp-accent');
  });

  test('theme persists after navigating away and back to settings', async () => {
    // Get the currently selected theme button text
    const selectedThemeName = await window.evaluate(() => {
      const buttons = document.querySelectorAll('.grid.grid-cols-2 button');
      for (const btn of buttons) {
        if (btn.className.includes('border-ctp-accent') || btn.className.includes('ring-1')) {
          return btn.textContent?.trim() || '';
        }
      }
      return '';
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

    // Go to Display & UI sub-page
    await navigateToDisplaySettings();

    // Verify the same theme is still selected
    const currentThemeName = await window.evaluate(() => {
      const buttons = document.querySelectorAll('.grid.grid-cols-2 button');
      for (const btn of buttons) {
        if (btn.className.includes('border-ctp-accent') || btn.className.includes('ring-1')) {
          return btn.textContent?.trim() || '';
        }
      }
      return '';
    });
    expect(currentThemeName).toBe(selectedThemeName);
  });

  test('theme persists after switching projects', async () => {
    // Get the currently selected theme name
    const selectedThemeName = await window.evaluate(() => {
      const buttons = document.querySelectorAll('.grid.grid-cols-2 button');
      for (const btn of buttons) {
        if (btn.className.includes('border-ctp-accent') || btn.className.includes('ring-1')) {
          return btn.textContent?.trim() || '';
        }
      }
      return '';
    });

    // Close settings first
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Switch to project-b
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    // Switch back to smoke project
    await navigateToSmokeProject();

    // Re-open settings
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Go to Display & UI sub-page
    await navigateToDisplaySettings();

    // Verify theme is still the same
    const currentThemeName = await window.evaluate(() => {
      const buttons = document.querySelectorAll('.grid.grid-cols-2 button');
      for (const btn of buttons) {
        if (btn.className.includes('border-ctp-accent') || btn.className.includes('ring-1')) {
          return btn.textContent?.trim() || '';
        }
      }
      return '';
    });
    expect(currentThemeName).toBe(selectedThemeName);

    // Toggle settings off
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });

  test('Home view toggle persists in localStorage', async () => {
    // Open settings and go to Display & UI
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    await navigateToDisplaySettings();

    // Read the current Home toggle state — it's the first toggle-track button
    const homeToggle = window.locator('button.toggle-track').first();
    await expect(homeToggle).toBeVisible({ timeout: 5_000 });
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
    // Navigate to smoke project to see the agent list
    await navigateToSmokeProject();
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

  test('settings navigation does not cause blank screen', async () => {
    // Open settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    // Click through several settings sub-pages via category nav buttons
    const subPages = ['Notifications', 'Logging', 'About', 'Display & UI'];
    for (const pageName of subPages) {
      const btn = window.locator(`button:has-text("${pageName}")`);
      const visible = await btn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (visible) {
        await btn.click();
        await window.waitForTimeout(300);
        await assertNotBlankScreen();
      }
    }

    // Close settings
    await settingsBtn.click();
    await window.waitForTimeout(500);
  });
});
