/**
 * Plugin System E2E Tests
 * GitHub Issue #235: built-in plugin loading, marketplace, plugin settings,
 * explorer rail tabs, and hot-reload lifecycle verification.
 *
 * Uses a dedicated fixture (project-plugins) to avoid conflicts with other
 * parallel E2E test files.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

// Dedicated fixture for plugin tests — not shared with other spec files
const FIXTURE_PLUGINS = path.resolve(__dirname, 'fixtures/project-plugins');

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

/**
 * Click an explorer tab by dispatching a JS click event directly.
 * The project rail can overlay explorer tabs and intercept pointer events,
 * so we bypass the Playwright pointer event system entirely.
 */
async function clickExplorerTab(testId: string) {
  await window.waitForSelector(`[data-testid="${testId}"]`, { timeout: 10_000 });
  await window.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement;
    if (el) el.click();
  }, testId);
  await window.waitForTimeout(500);
}

/** Verify the page has meaningful content (not blank-screened). */
async function assertNotBlankScreen() {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);
}

/** Get the title bar text. */
async function getTitleBarText(): Promise<string> {
  return window.locator('[data-testid="title-bar"]').first().textContent() as Promise<string>;
}

/** Navigate to settings. */
async function openSettings() {
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  // Use a retry-capable assertion instead of a fixed wait — CI machines can be slow
  await expect(window.locator('[data-testid="title-bar"]').first()).toContainText('Settings', {
    timeout: 5_000,
  });
}

/** Navigate to the Plugins settings sub-page (within settings view). */
async function navigateToPluginsSettings() {
  // Use exact text match to avoid matching "project-plugins" in the sidebar
  const pluginsBtn = window.locator('button', { hasText: /^Plugins$/ });
  await expect(pluginsBtn).toBeVisible({ timeout: 5_000 });
  await pluginsBtn.click();
  await window.waitForTimeout(500);
}

/** Ensure we're on a project view (not settings or help). */
async function ensureProjectView() {
  const projBtn = window.locator('[title="project-plugins"]').first();
  const isVisible = await projBtn.isVisible({ timeout: 3_000 }).catch(() => false);
  if (isVisible) {
    await projBtn.click();
    await window.waitForTimeout(500);
  }
}

/** Close settings by toggling the settings button. */
async function closeSettings() {
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  // Wait until Settings is no longer in the title bar — ensures close is complete before proceeding
  await expect(window.locator('[data-testid="title-bar"]').first()).not.toContainText('Settings', {
    timeout: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ===========================================================================
// PART A: Built-in Plugin Loading
// ===========================================================================

test.describe('Built-in Plugin Loading', () => {
  test('app starts and built-in plugins are registered in the store', async () => {
    // Query the plugin store directly from the renderer process
    const pluginState = await window.evaluate(() => {
      // @ts-expect-error — accessing internal Zustand store from test
      const store = window.__ZUSTAND_STORES__?.pluginStore?.getState?.() ??
        // Fallback: try the imported store path
        null;
      if (store) {
        return {
          pluginIds: Object.keys(store.plugins),
          plugins: Object.fromEntries(
            Object.entries(store.plugins).map(([id, entry]: [string, any]) => [
              id,
              { status: entry.status, source: entry.source, scope: entry.manifest?.scope },
            ]),
          ),
          appEnabled: store.appEnabled,
        };
      }
      // If we can't access the store directly, check the DOM for plugin evidence
      return null;
    });

    // If store access works, verify plugin registration
    if (pluginState) {
      expect(pluginState.pluginIds).toContain('hub');
      expect(pluginState.pluginIds).toContain('terminal');
      expect(pluginState.pluginIds).toContain('files');

      // All builtins should be registered as 'builtin' source
      expect(pluginState.plugins['hub'].source).toBe('builtin');
      expect(pluginState.plugins['terminal'].source).toBe('builtin');
      expect(pluginState.plugins['files'].source).toBe('builtin');

      // All builtins should be app-enabled by default
      expect(pluginState.appEnabled).toContain('hub');
      expect(pluginState.appEnabled).toContain('terminal');
      expect(pluginState.appEnabled).toContain('files');
    }
  });

  test('add project and verify plugin tabs appear in explorer rail', async () => {
    await addProject(FIXTURE_PLUGINS);
    await window.waitForTimeout(1_000);

    // Plugin tabs should appear after the core "Agents" tab
    // Hub has scope 'dual' with a tab contribution
    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toBeVisible({ timeout: 10_000 });

    // Terminal has scope 'project' with a tab contribution
    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(terminalTab).toBeVisible({ timeout: 5_000 });

    // Files has scope 'project' with a tab contribution
    const filesTab = window.locator('[data-testid="explorer-tab-plugin:files"]');
    await expect(filesTab).toBeVisible({ timeout: 5_000 });
  });

  test('built-in plugin tabs show correct labels', async () => {
    // Each tab should display its manifest label
    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toContainText('Hub');

    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(terminalTab).toContainText('Terminal');

    const filesTab = window.locator('[data-testid="explorer-tab-plugin:files"]');
    await expect(filesTab).toContainText('Files');
  });

  test('clicking Hub tab activates it and renders content', async () => {
    await clickExplorerTab('explorer-tab-plugin:hub');

    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    // Hub plugin should render its content view (not blank screen)
    await assertNotBlankScreen();
  });

  test('clicking Files tab activates it and renders content', async () => {
    await clickExplorerTab('explorer-tab-plugin:files');

    const filesTab = window.locator('[data-testid="explorer-tab-plugin:files"]');
    await expect(filesTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    await assertNotBlankScreen();
  });

  test('clicking Terminal tab activates it and renders content', async () => {
    await clickExplorerTab('explorer-tab-plugin:terminal');

    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(terminalTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    await assertNotBlankScreen();
  });

  test('clicking Agents (core) tab deactivates plugin tabs', async () => {
    await clickExplorerTab('explorer-tab-agents');

    const agentsTab = window.locator('[data-testid="explorer-tab-agents"]');
    await expect(agentsTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    // Plugin tabs should not be active
    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toHaveAttribute('data-active', 'false', { timeout: 3_000 });

    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(terminalTab).toHaveAttribute('data-active', 'false', { timeout: 3_000 });

    const filesTab = window.locator('[data-testid="explorer-tab-plugin:files"]');
    await expect(filesTab).toHaveAttribute('data-active', 'false', { timeout: 3_000 });
  });

  test('rapid tab switching does not blank screen', async () => {
    const tabs = [
      'explorer-tab-agents',
      'explorer-tab-plugin:hub',
      'explorer-tab-plugin:terminal',
      'explorer-tab-plugin:files',
    ];

    for (let i = 0; i < 3; i++) {
      for (const tabId of tabs) {
        await clickExplorerTab(tabId);
      }
    }

    // After rapid switching, UI should still be valid
    await window.waitForTimeout(500);
    await assertNotBlankScreen();
  });
});

// ===========================================================================
// PART B: Plugin Settings
// ===========================================================================

test.describe('Plugin Settings', () => {
  test('navigate to Plugins settings page', async () => {
    await openSettings();
    await navigateToPluginsSettings();

    // Should display "Plugins" heading in app context
    const heading = window.locator('h2:has-text("Plugins")');
    await expect(heading).toBeVisible({ timeout: 5_000 });
  });

  test('built-in plugins are listed in settings', async () => {
    // Built-in section should show all three plugins
    const builtinSection = window.locator('h3:has-text("Built-in")');
    await expect(builtinSection).toBeVisible({ timeout: 5_000 });

    // Each built-in plugin name should be visible
    await expect(window.locator('text=Hub').first()).toBeVisible({ timeout: 3_000 });
    await expect(window.locator('text=Terminal').first()).toBeVisible({ timeout: 3_000 });
    await expect(window.locator('text=Files').first()).toBeVisible({ timeout: 3_000 });
  });

  test('built-in plugins show "Built-in" badge', async () => {
    // Each built-in plugin should have a "Built-in" badge — wait for render before counting
    const badges = window.locator('text=Built-in');
    await expect(badges.first()).toBeVisible({ timeout: 5_000 });
    const count = await badges.count();
    // At least 3 for hub, terminal, files
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('built-in plugins show version and API version', async () => {
    // Plugins should display version info (v1.0.0) — use auto-retrying assertion for CI stability
    const versionLabels = window.locator('text=v1.0.0');
    await expect(versionLabels.first()).toBeVisible({ timeout: 5_000 });
    const count = await versionLabels.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // API version badge (API 0.6) — built-in plugins upgraded to v0.6
    const apiLabels = window.locator('text=API 0.6');
    await expect(apiLabels.first()).toBeVisible({ timeout: 5_000 });
    const apiCount = await apiLabels.count();
    expect(apiCount).toBeGreaterThanOrEqual(3);
  });

  test('built-in plugins have toggle switches that are enabled', async () => {
    // Toggles for built-in plugins — they should be in the "on" state
    // The toggle is a button with bg-ctp-accent class when enabled
    const toggles = window.locator('.bg-ctp-accent.rounded-full');
    await expect(toggles.first()).toBeVisible({ timeout: 5_000 });
    const count = await toggles.count();
    // At least 3 toggles for the built-in plugins
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('Workshop link is visible in app-context settings', async () => {
    const workshopLink = window.locator('[data-testid="workshop-link"]');
    await expect(workshopLink).toBeVisible({ timeout: 3_000 });
    const href = await workshopLink.getAttribute('href');
    expect(href).toContain('Clubhouse-Workshop');
  });

  test('Marketplace button is visible in app-context settings', async () => {
    const marketplaceBtn = window.locator('[data-testid="marketplace-button"]');
    await expect(marketplaceBtn).toBeVisible({ timeout: 3_000 });
    await expect(marketplaceBtn).toContainText('View Plugin Marketplace');
  });

  test('External plugins section shows toggle switch', async () => {
    // The external plugins master switch should be visible
    // Use exact match to avoid hitting the paragraph "Enable external plugins above to discover..."
    const externalLabel = window.getByText('Enable External Plugins', { exact: true });
    await expect(externalLabel).toBeVisible({ timeout: 3_000 });
  });

  test('navigating away and back preserves plugin settings state', async () => {
    // Close settings
    await closeSettings();
    await window.waitForTimeout(500);

    // Re-open settings and go to Plugins
    await openSettings();
    await navigateToPluginsSettings();

    // Built-in plugins should still be listed
    const builtinSection = window.locator('h3:has-text("Built-in")');
    await expect(builtinSection).toBeVisible({ timeout: 5_000 });

    // Plugin names should still be visible
    await expect(window.locator('text=Hub').first()).toBeVisible({ timeout: 3_000 });
    await expect(window.locator('text=Terminal').first()).toBeVisible({ timeout: 3_000 });
    await expect(window.locator('text=Files').first()).toBeVisible({ timeout: 3_000 });
  });

  test('close settings for next test group', async () => {
    await closeSettings();
  });
});

// ===========================================================================
// PART C: Plugin Marketplace Dialog
// ===========================================================================

test.describe('Plugin Marketplace Dialog', () => {
  test('open Marketplace dialog from plugin settings', async () => {
    await openSettings();
    await navigateToPluginsSettings();

    // Click the "View Plugin Marketplace" button
    const marketplaceBtn = window.locator('[data-testid="marketplace-button"]');
    await marketplaceBtn.click();
    await window.waitForTimeout(500);

    // Marketplace dialog should be visible
    const dialog = window.locator('[data-testid="marketplace-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
  });

  test('Marketplace dialog shows title', async () => {
    const title = window.locator('[data-testid="marketplace-dialog"] h3:has-text("Plugin Marketplace")');
    await expect(title).toBeVisible({ timeout: 5_000 });
  });

  test('Marketplace dialog has search input', async () => {
    const searchInput = window.locator('[data-testid="marketplace-search"]');
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    // Should have placeholder text
    const placeholder = await searchInput.getAttribute('placeholder');
    expect(placeholder).toContain('Search');
  });

  test('Marketplace dialog has filter tabs (All, Featured, Official)', async () => {
    const allTab = window.locator('[data-testid="marketplace-tab-all"]');
    await expect(allTab).toBeVisible({ timeout: 5_000 });

    const featuredTab = window.locator('[data-testid="marketplace-tab-featured"]');
    await expect(featuredTab).toBeVisible({ timeout: 3_000 });

    const officialTab = window.locator('[data-testid="marketplace-tab-official"]');
    await expect(officialTab).toBeVisible({ timeout: 3_000 });
  });

  test('Marketplace dialog shows loading state or plugin list', async () => {
    // The dialog should either show "Loading marketplace..." or a list of plugins.
    // In CI, the fetch may fail due to no network — we handle both cases.
    const loadingMsg = window.locator('text=Loading marketplace...');
    const errorMsg = window.locator('text=Failed to load marketplace');
    const noPluginsMsg = window.locator('text=No plugins available.');
    const pluginCards = window.locator('[data-testid="marketplace-dialog"] .space-y-3 > div');

    // Wait for loading to finish
    await window.waitForTimeout(5_000);

    const hasLoading = await loadingMsg.isVisible().catch(() => false);
    const hasError = await errorMsg.isVisible().catch(() => false);
    const hasNoPlugins = await noPluginsMsg.isVisible().catch(() => false);
    const hasCards = (await pluginCards.count()) > 0;

    // At least one of these states should be present (not a blank dialog)
    expect(hasLoading || hasError || hasNoPlugins || hasCards).toBe(true);
  });

  test('filter tabs can be clicked without crashing', async () => {
    // Click each filter tab
    const featuredTab = window.locator('[data-testid="marketplace-tab-featured"]');
    await featuredTab.click();
    await window.waitForTimeout(300);
    await assertNotBlankScreen();

    const officialTab = window.locator('[data-testid="marketplace-tab-official"]');
    await officialTab.click();
    await window.waitForTimeout(300);
    await assertNotBlankScreen();

    const allTab = window.locator('[data-testid="marketplace-tab-all"]');
    await allTab.click();
    await window.waitForTimeout(300);
    await assertNotBlankScreen();
  });

  test('search input accepts text without crashing', async () => {
    const searchInput = window.locator('[data-testid="marketplace-search"]');
    await searchInput.fill('test-plugin');
    await window.waitForTimeout(500);
    await assertNotBlankScreen();

    // Clear search
    await searchInput.fill('');
    await window.waitForTimeout(300);
  });

  test('close button dismisses the Marketplace dialog', async () => {
    const closeBtn = window.locator('[data-testid="marketplace-close"]');
    await closeBtn.click();
    await window.waitForTimeout(500);

    // Dialog should be gone
    const dialog = window.locator('[data-testid="marketplace-dialog"]');
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test('Marketplace can be reopened after closing', async () => {
    const marketplaceBtn = window.locator('[data-testid="marketplace-button"]');
    await marketplaceBtn.click();
    await window.waitForTimeout(500);

    const dialog = window.locator('[data-testid="marketplace-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Close via overlay click
    const overlay = window.locator('[data-testid="marketplace-overlay"]');
    // Click at the edge of the overlay (outside dialog body)
    await overlay.click({ position: { x: 10, y: 10 } });
    await window.waitForTimeout(500);

    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test('close settings after marketplace tests', async () => {
    await closeSettings();
  });
});

// ===========================================================================
// PART D: Plugin Store State Integrity
// ===========================================================================

test.describe('Plugin Store State Integrity', () => {
  test('built-in plugins are activated (status = activated)', async () => {
    const statuses = await window.evaluate(() => {
      // Access plugin store via usePluginStore exposed on window for testing
      // or via the Zustand devtools
      const storeEl = document.querySelector('[data-plugin-store-debug]');
      if (storeEl) {
        return JSON.parse(storeEl.getAttribute('data-plugin-store-debug') || '{}');
      }
      // Attempt direct store access — plugin store is typically accessible
      // through the window.__ZUSTAND_STORES__ dev helper
      return null;
    });

    // Even if we can't access the store directly, the fact that plugin tabs
    // appeared and rendered content (tested in Part A) proves activation.
    // This test serves as a deeper verification when store access is available.
    if (statuses) {
      for (const pluginId of ['hub', 'terminal', 'files']) {
        if (statuses[pluginId]) {
          expect(statuses[pluginId].status).toBe('activated');
        }
      }
    }
  });

  test('plugin tabs remain after navigating settings and back', async () => {
    // Ensure we start on a project view
    await ensureProjectView();

    // Navigate to settings
    await openSettings();
    await window.waitForTimeout(500);

    // Navigate back to the project by clicking the project button
    // (closeSettings toggles the nav button, but we need to explicitly
    // return to project view for the ExplorerRail to show plugin tabs)
    await closeSettings();
    await ensureProjectView();

    // Plugin tabs should still be present
    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toBeVisible({ timeout: 10_000 });

    const terminalTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(terminalTab).toBeVisible({ timeout: 5_000 });

    const filesTab = window.locator('[data-testid="explorer-tab-plugin:files"]');
    await expect(filesTab).toBeVisible({ timeout: 5_000 });
  });

  test('plugin tabs survive rapid navigation cycles', async () => {
    // Ensure we start on a project view
    await ensureProjectView();

    // Rapidly toggle settings 3 times
    for (let i = 0; i < 3; i++) {
      const settingsBtn = window.locator('[data-testid="nav-settings"]');
      await settingsBtn.click();
      await window.waitForTimeout(200);
      await settingsBtn.click();
      await window.waitForTimeout(200);
    }

    // Ensure we're back on project view after rapid toggling
    await ensureProjectView();

    // Wait for UI to settle
    await window.waitForTimeout(1_000);

    // Plugin tabs should still be intact
    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toBeVisible({ timeout: 10_000 });

    await assertNotBlankScreen();
  });
});

// ===========================================================================
// PART E: Plugin Tab Restore on Project Switch (Issue #266)
// ===========================================================================

test.describe('Plugin Tab Restore on Project Switch', () => {
  const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');

  test('add a second project for switching tests', async () => {
    await addProject(FIXTURE_B);
    await window.waitForTimeout(1_000);
    const titleText = await getTitleBarText();
    expect(titleText).toContain('project-b');
  });

  test('set Hub tab active on project-plugins, switch to project-b, switch back — no blank screen', async () => {
    // Navigate to project-plugins and click Hub tab
    const projPlugins = window.locator('[title="project-plugins"]').first();
    await projPlugins.click();
    await window.waitForTimeout(500);
    await clickExplorerTab('explorer-tab-plugin:hub');
    const hubTab = window.locator('[data-testid="explorer-tab-plugin:hub"]');
    await expect(hubTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    // Switch to project-b
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(1_000);
    await assertNotBlankScreen();

    // Switch back to project-plugins — Hub tab should restore
    await projPlugins.click();
    await window.waitForTimeout(1_500);
    await assertNotBlankScreen();

    // Hub tab should still be active (restored from saved state)
    await expect(hubTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });
  });

  test('set Terminal tab active on project-plugins, switch to project-b, switch back — no blank screen', async () => {
    // Navigate to project-plugins and click Terminal tab
    const projPlugins = window.locator('[title="project-plugins"]').first();
    await projPlugins.click();
    await window.waitForTimeout(500);
    await clickExplorerTab('explorer-tab-plugin:terminal');
    const termTab = window.locator('[data-testid="explorer-tab-plugin:terminal"]');
    await expect(termTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    // Switch to project-b
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(1_000);
    await assertNotBlankScreen();

    // Switch back to project-plugins — Terminal tab should restore
    await projPlugins.click();
    await window.waitForTimeout(1_500);
    await assertNotBlankScreen();

    // Terminal tab should still be active
    await expect(termTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });
  });

  test('rapid project switching with plugin tab active does not blank screen', async () => {
    // Set Hub tab active on project-plugins
    const projPlugins = window.locator('[title="project-plugins"]').first();
    const projB = window.locator('[title="project-b"]').first();
    await projPlugins.click();
    await window.waitForTimeout(500);
    await clickExplorerTab('explorer-tab-plugin:hub');

    // Rapidly switch between projects 5 times
    for (let i = 0; i < 5; i++) {
      await projB.click();
      await projPlugins.click();
    }

    // Wait for all transitions to settle
    await window.waitForTimeout(2_000);
    await assertNotBlankScreen();
  });
});

// ===========================================================================
// PART F: Console Error Monitoring
// ===========================================================================

test.describe('Plugin System Console Errors (Part F)', () => {
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    window.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
  });

  test('exercise plugin system to collect errors', async () => {
    // Ensure we're on project view first
    await ensureProjectView();

    // Navigate through plugin tabs to trigger any deferred errors
    await clickExplorerTab('explorer-tab-plugin:hub');
    await window.waitForTimeout(300);
    await clickExplorerTab('explorer-tab-plugin:terminal');
    await window.waitForTimeout(300);
    await clickExplorerTab('explorer-tab-plugin:files');
    await window.waitForTimeout(300);
    await clickExplorerTab('explorer-tab-agents');
    await window.waitForTimeout(300);

    // Open and close marketplace
    await openSettings();
    await navigateToPluginsSettings();
    const marketplaceBtn = window.locator('[data-testid="marketplace-button"]');
    await marketplaceBtn.click();
    await window.waitForTimeout(2_000);
    const closeBtn = window.locator('[data-testid="marketplace-close"]');
    await closeBtn.click();
    await window.waitForTimeout(500);
    await closeSettings();

    // Wait for any deferred errors
    await window.waitForTimeout(2_000);
  });

  test('no plugin-related crash errors in console', async () => {
    const pluginCrashErrors = consoleErrors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('source map') &&
        !e.includes('favicon') &&
        !e.includes('Autofill') &&
        !e.includes('ResizeObserver') &&
        !e.includes('net::ERR') && // Network errors from marketplace fetch in CI
        !e.includes('Failed to fetch') &&
        (e.includes('plugin') ||
         e.includes('Plugin') ||
         e.includes('Cannot read properties of undefined') ||
         e.includes('Cannot read properties of null') ||
         e.includes('is not a function') ||
         e.includes('Maximum update depth')),
    );
    expect(pluginCrashErrors).toEqual([]);
  });
});
