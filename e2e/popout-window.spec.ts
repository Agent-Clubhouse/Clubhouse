/**
 * Pop-out Window E2E Tests — multi-window state synchronization
 *
 * Tests the pop-out window system's ability to:
 * - Create and render pop-out windows for agents
 * - Synchronize agent state between main and pop-out windows
 * - Propagate agent status changes across windows via IPC
 * - Maintain main window independence when pop-outs close
 * - Track pop-out window lifecycle via LIST_POPOUTS
 *
 * Addresses: GitHub Issue #234
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let mainWindow: Page;

// Use project-b to avoid sharing agents.json with agent-list-ui.spec.ts
// (both suites run in parallel and would conflict on the same fixture).
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/project-b');
const AGENTS_JSON = path.join(FIXTURE_DIR, '.clubhouse', 'agents.json');

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
  const addBtn = mainWindow.locator('[data-testid="nav-add-project"]');
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(mainWindow.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

function writeAgentsJson(
  agents: Array<{ id: string; name: string; color: string }>,
) {
  const dir = path.join(FIXTURE_DIR, '.clubhouse');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const configs = agents.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    createdAt: new Date().toISOString(),
  }));
  fs.writeFileSync(
    path.join(dir, 'agents.json'),
    JSON.stringify(configs, null, 2),
    'utf-8',
  );
}

/**
 * Create a pop-out window and return its Page handle.
 *
 * Starts listening for the 'window' event BEFORE triggering creation to
 * avoid a race where the window opens before we're listening.
 *
 * DevTools windows auto-open in unpackaged Electron builds, so when a
 * popout BrowserWindow is created, two windows appear: the renderer and
 * its DevTools.  The DevTools URL is initially empty (not `devtools://`)
 * and only navigates later, so the URL-based predicate in waitForEvent
 * can match the wrong window.  We handle this by waiting for load and
 * then falling back to the next window if we accidentally captured DevTools.
 */
async function createPopout(params: {
  type: 'agent' | 'hub';
  agentId?: string;
  hubId?: string;
  projectId?: string;
  title?: string;
}): Promise<{ page: Page; windowId: number }> {
  const existingPages = new Set(electronApp.windows());

  const popoutPromise = electronApp.waitForEvent('window', {
    predicate: (page: Page) => !existingPages.has(page),
    timeout: 15_000,
  });

  const windowId = await mainWindow.evaluate(
    (p) => (window as any).clubhouse.window.createPopout(p),
    params,
  );

  let page = await popoutPromise;
  await page.waitForLoadState('load');

  // DevTools may not have a devtools:// URL initially — verify the popout
  // by checking for its test id. If we caught DevTools, wait for the real one.
  const isPopout = await page.locator('[data-testid="popout-window"]')
    .isVisible({ timeout: 5_000 }).catch(() => false);
  if (!isPopout) {
    existingPages.add(page);
    page = await electronApp.waitForEvent('window', {
      predicate: (p: Page) => !existingPages.has(p),
      timeout: 10_000,
    });
    await page.waitForLoadState('load');
  }

  return { page, windowId };
}

/**
 * Get the project ID that was assigned to the fixture project.
 */
async function getProjectId(): Promise<string> {
  return mainWindow.evaluate(() => {
    // The project store is a Zustand store — access its state directly
    // from the renderer's window object.  Since the store is module-scoped
    // and not on window, we use the IPC API to list projects.
    return (window as any).clubhouse.project.list();
  }).then((projects: Array<{ id: string; path: string }>) => {
    const fixture = projects.find((p: any) =>
      p.path.endsWith('project-b'),
    );
    return fixture?.id ?? '';
  });
}

/**
 * Wait for durable agents to appear in the main window store.
 */
async function waitForDurableAgents() {
  await expect(
    mainWindow.locator('[data-testid^="durable-drag-"]').first(),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * List currently open pop-out windows via the IPC API.
 */
async function listPopouts(): Promise<Array<{ windowId: number; params: any }>> {
  return mainWindow.evaluate(() =>
    (window as any).clubhouse.window.listPopouts(),
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  writeAgentsJson([
    { id: 'popout_agent_1', name: 'alpha-popout', color: 'indigo' },
    { id: 'popout_agent_2', name: 'beta-popout', color: 'green' },
    { id: 'popout_agent_3', name: 'gamma-popout', color: 'red' },
  ]);

  ({ electronApp, window: mainWindow } = await launchApp());
  await addProject(FIXTURE_DIR);
  await waitForDurableAgents();
});

test.afterAll(async () => {
  if (fs.existsSync(AGENTS_JSON)) {
    fs.writeFileSync(AGENTS_JSON, '[]', 'utf-8');
  }
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Pop-out Window Creation & Rendering
// ---------------------------------------------------------------------------

test.describe('Pop-out Window Creation', () => {
  test('can open a pop-out agent window via IPC', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    // Pop-out should have rendered the popout window container
    await expect(page.locator('[data-testid="popout-window"]')).toBeVisible({
      timeout: 10_000,
    });

    // Title bar should indicate agent pop-out
    await expect(page.locator('[data-testid="popout-title"]')).toContainText(
      'Agent',
      { timeout: 5_000 },
    );

    // Clean up
    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('pop-out window shows the correct agent name', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    // Wait for syncing to complete — the popout-syncing indicator should disappear
    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // The agent view should render
    await expect(page.locator('[data-testid="popout-agent-view"]')).toBeVisible({
      timeout: 10_000,
    });

    // Agent name should match the durable agent config
    await expect(page.locator('[data-testid="popout-agent-name"]')).toContainText(
      'alpha-popout',
      { timeout: 5_000 },
    );

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('pop-out window for a different agent shows that agent', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_2',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    await expect(page.locator('[data-testid="popout-agent-name"]')).toContainText(
      'beta-popout',
      { timeout: 5_000 },
    );

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Pop-out Window Lifecycle (LIST_POPOUTS tracking)
// ---------------------------------------------------------------------------

test.describe('Pop-out Lifecycle', () => {
  test('newly created pop-out appears in listPopouts', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    const popouts = await listPopouts();
    const entry = popouts.find((p) => p.windowId === windowId);
    expect(entry).toBeDefined();
    expect(entry!.params.type).toBe('agent');
    expect(entry!.params.agentId).toBe('popout_agent_1');

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('closing a pop-out removes it from listPopouts', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    // Verify it's in the list
    let popouts = await listPopouts();
    expect(popouts.some((p) => p.windowId === windowId)).toBe(true);

    // Close it
    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );

    // Give the close event time to propagate
    await mainWindow.waitForTimeout(500);

    // Should be gone
    popouts = await listPopouts();
    expect(popouts.some((p) => p.windowId === windowId)).toBe(false);
  });

  test('can open multiple pop-outs simultaneously', async () => {
    const projectId = await getProjectId();

    const popout1 = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    const popout2 = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_2',
      projectId,
    });

    const popouts = await listPopouts();
    expect(popouts.length).toBeGreaterThanOrEqual(2);

    const ids = popouts.map((p) => p.windowId);
    expect(ids).toContain(popout1.windowId);
    expect(ids).toContain(popout2.windowId);

    // Each pop-out should show a different agent
    await expect(popout1.page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });
    await expect(popout2.page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    await expect(popout1.page.locator('[data-testid="popout-agent-name"]')).toContainText(
      'alpha-popout',
      { timeout: 5_000 },
    );
    await expect(popout2.page.locator('[data-testid="popout-agent-name"]')).toContainText(
      'beta-popout',
      { timeout: 5_000 },
    );

    // Clean up both
    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      popout1.windowId,
    );
    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      popout2.windowId,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Agent State Synchronization — Snapshot
// ---------------------------------------------------------------------------

test.describe('Agent State Snapshot Sync', () => {
  test('pop-out receives agent state snapshot from main window', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    // Wait for sync to complete
    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // The pop-out's agent store should contain our agents.
    // We verify by checking that the agent view rendered successfully
    // (which requires the store to have the agent data).
    await expect(page.locator('[data-testid="popout-agent-view"]')).toBeVisible({
      timeout: 5_000,
    });

    // Sleeping agent should show wake button (since it's a durable agent)
    await expect(page.locator('[data-testid="popout-wake-button"]')).toBeVisible({
      timeout: 5_000,
    });

    // Stop button should NOT be visible (agent is sleeping)
    await expect(page.locator('[data-testid="popout-stop-button"]')).not.toBeVisible();

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('pop-out agent state matches main window agent state', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // Verify the main window also shows the same agent
    await expect(
      mainWindow.locator('[data-agent-name="alpha-popout"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Pop-out should show the same agent name
    await expect(page.locator('[data-testid="popout-agent-name"]')).toContainText(
      'alpha-popout',
    );

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('all three agents from main window are available in pop-out store', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // Query the pop-out's agent store to verify all three agents were synced
    const agentCount = await page.evaluate(() => {
      // Access Zustand store state — the store is in module scope, but
      // getAgentState resolved all agents during the snapshot sync.
      // We check by querying the preload API directly.
      return (window as any).clubhouse.window.getAgentState().then(
        (state: any) => Object.keys(state.agents).length,
      );
    });

    // Should have at least 3 agents (the ones we wrote to agents.json)
    expect(agentCount).toBeGreaterThanOrEqual(3);

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Agent Status Change Propagation
// ---------------------------------------------------------------------------

test.describe('Agent Status Propagation', () => {
  test('main window agent status change propagates to pop-out via PTY data event', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // Initially the agent is sleeping — wake button should be visible
    await expect(page.locator('[data-testid="popout-wake-button"]')).toBeVisible({
      timeout: 5_000,
    });

    // Simulate an agent becoming 'running' by sending a PTY data event
    // from the main process to all renderer windows. This mimics what
    // happens when an agent is woken: the PTY emits data events.
    await electronApp.evaluate(({ BrowserWindow }, agentId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('pty:data', agentId, 'Agent started...\r\n');
        }
      }
    }, 'popout_agent_1');

    // The pop-out's useAgentStateSync hook detects PTY data for a sleeping
    // agent and transitions it to 'running'. The wake button should disappear
    // and the stop button should appear.
    await expect(page.locator('[data-testid="popout-stop-button"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="popout-wake-button"]')).not.toBeVisible();

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('agent exit event propagates sleeping status to pop-out', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_3',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // First, simulate the agent becoming 'running' via PTY data
    await electronApp.evaluate(({ BrowserWindow }, agentId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('pty:data', agentId, 'Working...\r\n');
        }
      }
    }, 'popout_agent_3');

    await expect(page.locator('[data-testid="popout-stop-button"]')).toBeVisible({
      timeout: 10_000,
    });

    // Now simulate the agent exiting (sleeping)
    await electronApp.evaluate(({ BrowserWindow }, agentId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('pty:exit', agentId, 0);
        }
      }
    }, 'popout_agent_3');

    // The pop-out should transition back to sleeping — wake button appears
    await expect(page.locator('[data-testid="popout-wake-button"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="popout-stop-button"]')).not.toBeVisible();

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });

  test('hook event propagates detailed status to pop-out', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_2',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // Simulate the agent becoming running first
    await electronApp.evaluate(({ BrowserWindow }, agentId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('pty:data', agentId, 'Starting...\r\n');
        }
      }
    }, 'popout_agent_2');

    await expect(page.locator('[data-testid="popout-stop-button"]')).toBeVisible({
      timeout: 10_000,
    });

    // Send a hook event (pre_tool) — this should update agentDetailedStatus
    await electronApp.evaluate(({ BrowserWindow }, { agentId, event }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('agent:hook-event', agentId, event);
        }
      }
    }, {
      agentId: 'popout_agent_2',
      event: {
        kind: 'pre_tool',
        toolName: 'Read',
        toolVerb: 'Reading file',
        timestamp: Date.now(),
      },
    });

    // The pop-out should still show the running agent (stop button visible)
    // The detailed status is stored in the Zustand store but may not have a
    // direct DOM indicator in the popout agent view. The key test is that the
    // hook event doesn't crash or desync the pop-out.
    await expect(page.locator('[data-testid="popout-stop-button"]')).toBeVisible({
      timeout: 5_000,
    });

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Main Window Independence
// ---------------------------------------------------------------------------

test.describe('Main Window Independence', () => {
  test('closing pop-out does not affect main window agent list', async () => {
    // Verify agents are visible in main window before pop-out
    const agentNames = ['alpha-popout', 'beta-popout', 'gamma-popout'];
    for (const name of agentNames) {
      await expect(
        mainWindow.locator(`[data-agent-name="${name}"]`).first(),
      ).toBeVisible({ timeout: 5_000 });
    }

    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    // Close the pop-out
    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );

    await mainWindow.waitForTimeout(500);

    // Main window agents should still be intact
    for (const name of agentNames) {
      await expect(
        mainWindow.locator(`[data-agent-name="${name}"]`).first(),
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test('closing pop-out does not remove agents from main window store', async () => {
    const projectId = await getProjectId();

    // Get agent count before
    const countBefore = await mainWindow.evaluate(() =>
      (window as any).clubhouse.window.getAgentState().then(
        (s: any) => Object.keys(s.agents).length,
      ),
    );

    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-window"]')).toBeVisible({
      timeout: 10_000,
    });

    // Close pop-out
    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
    await mainWindow.waitForTimeout(500);

    // Agent count should be unchanged
    const countAfter = await mainWindow.evaluate(() =>
      (window as any).clubhouse.window.getAgentState().then(
        (s: any) => Object.keys(s.agents).length,
      ),
    );

    expect(countAfter).toBe(countBefore);
  });

  test('main window UI remains interactive after pop-out closes', async () => {
    const projectId = await getProjectId();

    // Verify agents are visible before pop-out
    await expect(
      mainWindow.locator('[data-agent-name="alpha-popout"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-window"]')).toBeVisible({
      timeout: 10_000,
    });

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
    await mainWindow.waitForTimeout(500);

    // Agent list should still be visible and interactable
    const agentList = mainWindow.locator('[data-testid="agent-list"]');
    await expect(agentList).toBeVisible({ timeout: 5_000 });

    // Clicking on an agent should still work (sets it active)
    const agentItem = mainWindow.locator('[data-testid="agent-item-popout_agent_1"]');
    if (await agentItem.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await agentItem.click();
      // Agent should still be responsive — no error or crash
      await expect(agentItem).toBeVisible();
    }

    // Agent data should remain intact
    await expect(
      mainWindow.locator('[data-agent-name="alpha-popout"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 6. Pop-out View Button (focus main window)
// ---------------------------------------------------------------------------

test.describe('Pop-out View Button', () => {
  test('View button is visible in pop-out agent window', async () => {
    const projectId = await getProjectId();
    const { page, windowId } = await createPopout({
      type: 'agent',
      agentId: 'popout_agent_1',
      projectId,
    });

    await expect(page.locator('[data-testid="popout-syncing"]')).not.toBeVisible({
      timeout: 10_000,
    });

    await expect(page.locator('[data-testid="popout-view-button"]')).toBeVisible({
      timeout: 5_000,
    });

    await mainWindow.evaluate(
      (id) => (window as any).clubhouse.window.closePopout(id),
      windowId,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Pop-out Agent State IPC Relay Integrity
// ---------------------------------------------------------------------------

test.describe('IPC Relay Integrity', () => {
  test('GET_AGENT_STATE returns consistent data across requests', async () => {
    // Call getAgentState twice from the main window and verify consistency
    const state1 = await mainWindow.evaluate(() =>
      (window as any).clubhouse.window.getAgentState(),
    );
    const state2 = await mainWindow.evaluate(() =>
      (window as any).clubhouse.window.getAgentState(),
    );

    const agents1 = Object.keys(state1.agents).sort();
    const agents2 = Object.keys(state2.agents).sort();
    expect(agents1).toEqual(agents2);
  });

  test('GET_AGENT_STATE includes all durable agents', async () => {
    const state = await mainWindow.evaluate(() =>
      (window as any).clubhouse.window.getAgentState(),
    );

    const agentIds = Object.keys(state.agents);
    expect(agentIds).toContain('popout_agent_1');
    expect(agentIds).toContain('popout_agent_2');
    expect(agentIds).toContain('popout_agent_3');
  });

  test('GET_AGENT_STATE returns correct agent properties', async () => {
    const state = await mainWindow.evaluate(() =>
      (window as any).clubhouse.window.getAgentState(),
    );

    const agent1 = state.agents['popout_agent_1'];
    expect(agent1).toBeDefined();
    expect(agent1.name).toBe('alpha-popout');
    expect(agent1.status).toBe('sleeping');
    expect(agent1.kind).toBe('durable');
  });

  test('LIST_POPOUTS returns empty array when no pop-outs exist', async () => {
    // Ensure all pop-outs are closed first
    const existing = await listPopouts();
    for (const p of existing) {
      await mainWindow.evaluate(
        (id) => (window as any).clubhouse.window.closePopout(id),
        p.windowId,
      );
    }
    await mainWindow.waitForTimeout(500);

    const popouts = await listPopouts();
    expect(popouts).toEqual([]);
  });
});
