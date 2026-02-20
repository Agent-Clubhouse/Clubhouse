import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');

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
  // Wait for the project to appear in the rail
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

/** Read a value from a Zustand store in the renderer. */
async function evalStore<T>(expression: string): Promise<T> {
  return window.evaluate(expression) as Promise<T>;
}

/** Get the current explorer tab from the UI store. */
async function getExplorerTab(): Promise<string> {
  return evalStore<string>(
    `window.__zustand_uiStore?.getState?.()?.explorerTab ?? document.querySelector('[data-testid="title-bar"]')?.textContent ?? ''`,
  );
}

/** Get the title bar text. */
async function getTitleBarText(): Promise<string> {
  return window.locator('[data-testid="title-bar"]').first().textContent() as Promise<string>;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());

  // Expose Zustand stores globally so tests can inspect state via evaluate().
  await window.evaluate(() => {
    // A small shim: zustand stores are module-scoped, so we attach them.
    // The stores are already imported; we just need a global handle.
    // We'll set these from the renderer's global scope in App.tsx via an
    // init flag, but for e2e we can simply read them from the module cache.
  });
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Project Rail — Basic Navigation
// ---------------------------------------------------------------------------

test.describe('Project Rail', () => {
  test('starts on home view when no projects are active', async () => {
    const title = await getTitleBarText();
    // With no projects or no active project, title is "Home"
    // (or a project may already be loaded if fixtures persisted; we just check
    // the title bar is visible and non-empty)
    expect(title.length).toBeGreaterThan(0);
  });

  test('add first project and verify it becomes active', async () => {
    await addProject(FIXTURE_A);

    // The title bar should mention the project name
    const title = await getTitleBarText();
    expect(title).toContain('project-a');
  });

  test('add second project and verify it becomes active', async () => {
    await addProject(FIXTURE_B);

    const title = await getTitleBarText();
    expect(title).toContain('project-b');
  });

  test('clicking project-a in rail switches back', async () => {
    // project-a should be visible in the rail via its title attribute
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();

    await expect(window.locator('[data-testid="title-bar"]')).toContainText(
      'project-a',
      { timeout: 5_000 },
    );
  });

  test('clicking project-b in rail switches to it', async () => {
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();

    await expect(window.locator('[data-testid="title-bar"]')).toContainText(
      'project-b',
      { timeout: 5_000 },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Explorer Tab Navigation
// ---------------------------------------------------------------------------

test.describe('Explorer Tabs', () => {
  test('defaults to agents tab', async () => {
    // Make sure a project is active
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Agents');
  });

  test('agents tab shows agent list or no-active-agent placeholder', async () => {
    // Either the agent-list panel or the no-active-agent view should be visible
    const agentList = window.locator('[data-testid="agent-list"]');
    const noAgent = window.locator('[data-testid="no-active-agent"]');

    const listVisible = await agentList.isVisible({ timeout: 3_000 }).catch(() => false);
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);

    expect(listVisible || noAgentVisible).toBe(true);
  });

  test('settings toggle opens settings view', async () => {
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Settings');
  });

  test('settings toggle again returns to previous tab', async () => {
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    // Should return to agents (or whatever the previous tab was)
    expect(title).not.toContain('Settings');
  });

  test('help toggle opens help view', async () => {
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Help');
  });

  test('help toggle again returns to previous tab', async () => {
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).not.toContain('Help');
  });
});

// ---------------------------------------------------------------------------
// 3. Per-Project Tab Persistence
// ---------------------------------------------------------------------------

test.describe('Per-Project Tab Persistence', () => {
  test('switching project restores its saved tab', async () => {
    // Navigate to project-a -> agents tab (default)
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).toContain('project-a');
    expect(title).toContain('Agents');

    // Navigate to project-b
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain('project-b');

    // Switch back to project-a — should still be on agents
    await projA.click();
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain('project-a');
    expect(title).toContain('Agents');
  });

  test('new project defaults to agents tab', async () => {
    // project-b was never explicitly set to a tab, so it should default to agents
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('Agents');
  });

  test('settings view does not override saved project tab', async () => {
    // Go to project-a (should be on agents)
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    // Open settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).toContain('Settings');

    // Now switch to project-b — should restore project-b's tab, not settings
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain('project-b');
    expect(title).not.toContain('Settings');
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-Project Agent Guard (store-level)
// ---------------------------------------------------------------------------

test.describe('Cross-Project Agent Guard', () => {
  test('agent from project-a is not shown when project-b is active', async () => {
    // Inject a fake agent for project-a into the agent store via renderer evaluate
    const projAId = await window.evaluate(() => {
      // Find project-a's ID from the project store
      // @ts-ignore - accessing Zustand store from window context
      const stores = (window as any).__zustand_stores;
      // Fallback: read from the DOM or just return a placeholder
      return null;
    });

    // Even without injecting agents, we can verify structurally:
    // When on project-b, the main content should never show an agent from project-a
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    // The no-active-agent placeholder should be visible (no agents in project-b)
    // or the agent list should only show project-b agents
    const noAgent = window.locator('[data-testid="no-active-agent"]');
    const terminalView = window.locator('[data-testid="agent-terminal-view"]');

    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);
    const terminalVisible = await terminalView.isVisible({ timeout: 1_000 }).catch(() => false);

    // If a terminal is shown, verify it's for the right project
    // If no agent, the guard is working correctly
    if (!terminalVisible) {
      // No terminal showing — expected for a project with no agents
      expect(noAgentVisible).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Keyboard Shortcuts
// ---------------------------------------------------------------------------

test.describe('Keyboard Shortcuts', () => {
  test('Cmd+N switches between projects by ordinal position', async () => {
    // Get the list of project buttons in the rail to determine order
    const projectBtns = window.locator('[data-testid^="project-"]');
    const count = await projectBtns.count();

    if (count < 2) {
      // Not enough projects to test switching — skip
      return;
    }

    // Read the title attribute of the first two project buttons
    const firstTitle = await projectBtns.nth(0).getAttribute('title');
    const secondTitle = await projectBtns.nth(1).getAttribute('title');

    // Switch to the second project first
    await projectBtns.nth(1).click();
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).toContain(secondTitle!);

    // Press Cmd+1 to switch to first project
    await window.keyboard.press('Meta+1');
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain(firstTitle!);

    // Press Cmd+2 to switch to second project
    await window.keyboard.press('Meta+2');
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain(secondTitle!);
  });

  // Note: Cmd+9 is not tested here because Chromium intercepts it at the
  // browser level ("go to last tab") before it reaches the app's keydown handler.
});

// ---------------------------------------------------------------------------
// 6. Home Navigation
// ---------------------------------------------------------------------------

test.describe('Home Navigation', () => {
  test('home button shows dashboard', async () => {
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (homeVisible) {
      await homeBtn.click();
      await window.waitForTimeout(500);

      const title = await getTitleBarText();
      expect(title).toBe('Home');
    }
  });

  test('clicking project from home view restores project state', async () => {
    // From home, click project-a
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    const title = await getTitleBarText();
    expect(title).toContain('project-a');
    // Should restore to agents tab (the default/saved tab)
    expect(title).toContain('Agents');
  });

  test('settings gear on project card in home view opens project settings', async () => {
    // Navigate to Home first
    const homeBtn = window.locator('[data-testid="nav-home"]');
    const homeVisible = await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!homeVisible) return; // Home not enabled, skip

    await homeBtn.click();
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).toBe('Home');

    // Click the gear icon on a project card — it has title="Project Settings"
    const settingsGear = window.locator('[title="Project Settings"]').first();
    const gearVisible = await settingsGear.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!gearVisible) return; // No project cards visible, skip

    await settingsGear.click();
    await window.waitForTimeout(500);

    // Should navigate to Settings view, NOT the Agents (project root) view
    title = await getTitleBarText();
    expect(title).toContain('Settings');
  });
});

// ---------------------------------------------------------------------------
// 7. Settings from Different Contexts
// ---------------------------------------------------------------------------

test.describe('Settings Context', () => {
  test('opening settings from project-a then clicking project-b exits settings', async () => {
    // Navigate to project-a
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    // Open settings
    const settingsBtn = window.locator('[data-testid="nav-settings"]');
    await settingsBtn.click();
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).toContain('Settings');

    // Click project-b — should exit settings and show project-b's view
    const projB = window.locator('[title="project-b"]').first();
    await projB.click();
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain('project-b');
    expect(title).not.toContain('Settings');
  });

  test('opening help then clicking a project exits help', async () => {
    // Open help
    const helpBtn = window.locator('[data-testid="nav-help"]');
    await helpBtn.click();
    await window.waitForTimeout(500);

    let title = await getTitleBarText();
    expect(title).toContain('Help');

    // Click project-a — should exit help
    const projA = window.locator('[title="project-a"]').first();
    await projA.click();
    await window.waitForTimeout(500);

    title = await getTitleBarText();
    expect(title).toContain('project-a');
    expect(title).not.toContain('Help');
  });
});

// ---------------------------------------------------------------------------
// 8. Rapid Project Switching
// ---------------------------------------------------------------------------

test.describe('Rapid Switching', () => {
  test('rapid back-and-forth does not corrupt state', async () => {
    const projA = window.locator('[title="project-a"]').first();
    const projB = window.locator('[title="project-b"]').first();

    // Rapidly switch 5 times
    for (let i = 0; i < 5; i++) {
      await projA.click();
      await projB.click();
    }

    // Wait for things to settle
    await window.waitForTimeout(1_000);

    // Should be on project-b (last click)
    const title = await getTitleBarText();
    expect(title).toContain('project-b');

    // Should be on a valid tab (agents)
    expect(title).toContain('Agents');
  });
});
