/**
 * E2E Behavioral Spec: Agent Lifecycle — Spawn, Run, Exit
 *
 * TC-CRIT-01: Core product flow had zero E2E coverage.
 *
 * Tests the full lifecycle end-to-end using IPC stubs for CI compatibility:
 *   sleeping → wake → running (terminal view) → exit → sleeping
 *
 * IPC stubs replace the real Claude CLI spawn with in-process fake events so the
 * spec runs in CI without any orchestrator installed. The exit is simulated with
 * the same `pty:exit` event the PTY manager sends when the CLI process ends.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { launchApp } from './launch';
import { addProject } from './smoke-helpers';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/project-lifecycle');
const AGENTS_JSON_DIR = path.join(FIXTURE_DIR, '.clubhouse');
const AGENTS_JSON = path.join(AGENTS_JSON_DIR, 'agents.json');
const AGENT_ID = 'lifecycle_test_agent_001';

// These assertions share one lifecycle. A retry must replay the wake and exit,
// rather than passing the final assertion against a newly sleeping agent.
test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeLifecycleAgent() {
  if (!fs.existsSync(AGENTS_JSON_DIR)) fs.mkdirSync(AGENTS_JSON_DIR, { recursive: true });
  fs.writeFileSync(
    AGENTS_JSON,
    JSON.stringify(
      [
        {
          id: AGENT_ID,
          name: 'lifecycle-test',
          color: 'indigo',
          createdAt: new Date().toISOString(),
        },
      ],
      null,
      2,
    ),
    'utf-8',
  );
}

function cleanupLifecycleAgent() {
  try {
    fs.rmSync(AGENTS_JSON_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// IPC stubs
// ---------------------------------------------------------------------------

/**
 * Replace real IPC handlers with CI stubs.
 *
 * agent:spawn-agent — fires waking then awoke events; renderer transitions
 *                     through waking → running without a real Claude process.
 * agent:kill-agent  — fires sleeping; store transitions agent back to sleeping.
 */
async function installLifecycleStub(app: ElectronApp) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const getWin = () =>
      BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('devtools://'),
      );

    ipcMain.removeHandler('agent:spawn-agent');
    ipcMain.handle('agent:spawn-agent', async (_evt, params: { agentId: string }) => {
      const win = getWin();
      if (!win) return;
      win.webContents.send('agent:agent-waking', params.agentId);
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send('agent:agent-awoke', params.agentId);
      }, 80);
    });

    ipcMain.removeHandler('agent:kill-agent');
    ipcMain.handle('agent:kill-agent', async (_evt, agentId: string) => {
      const win = getWin();
      if (win) win.webContents.send('agent:agent-sleeping', agentId);
    });
  });
}

/** Simulate the CLI process ending, as the PTY manager reports it. */
async function simulatePtyExit(app: ElectronApp, agentId: string) {
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pty:exit', id, 0);
    }
  }, agentId);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let electronApp: ElectronApp;
let window: Page;

test.beforeAll(async () => {
  writeLifecycleAgent();

  ({ electronApp, window } = await launchApp({ experimental: {} }));

  await installLifecycleStub(electronApp);
  await addProject(electronApp, window, FIXTURE_DIR);

  // Wait for the seeded agent to appear in the sidebar
  await expect(
    window.locator(`[data-testid="agent-item-${AGENT_ID}"]`),
  ).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  cleanupLifecycleAgent();
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Sleeping state — verify initial state before any interaction
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Sleeping State', () => {
  test('agent appears in list with sleeping status', async () => {
    const item = window.locator(`[data-testid="agent-item-${AGENT_ID}"]`);
    await expect(item).toBeVisible({ timeout: 5_000 });

    const text = await item.textContent();
    expect(text?.toLowerCase()).toContain('sleeping');
  });

  test('selecting the agent shows the wake button', async () => {
    const item = window.locator(`[data-testid="agent-item-${AGENT_ID}"]`);
    await item.click();

    await expect(window.locator('[data-testid="wake-button"]')).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 2. Wake → Running — click wake, assert the terminal view renders
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Wake to Running', () => {
  test('clicking wake transitions agent to running state', async () => {
    const wakeBtn = window.locator('[data-testid="wake-button"]');
    await expect(wakeBtn).toBeVisible({ timeout: 5_000 });
    await wakeBtn.click();

    await expect(window.locator('[data-testid="agent-terminal"]')).toBeVisible({ timeout: 10_000 });
    await expect(window.locator('[data-testid="wake-button"]')).not.toBeVisible();
  });

  test('agent list item no longer shows sleeping while running', async () => {
    const item = window.locator(`[data-testid="agent-item-${AGENT_ID}"]`);
    await expect(item).not.toContainText(/sleeping/i, { timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Exit → Sleeping — the CLI exits, assert agent returns to sleeping state
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Exit to Sleeping', () => {
  test('process exit transitions agent back to sleeping state', async () => {
    // A durable agent exiting within three seconds is intentionally treated as
    // a startup error. Model a normal run without relying on CI wall-clock speed.
    const now = await window.evaluate(() => Date.now());
    await window.clock.setFixedTime(now + 3_001);
    await simulatePtyExit(electronApp, AGENT_ID);

    // Renderer handles pty:exit → store sets status sleeping → SleepingAgent renders
    await expect(window.locator('[data-testid="wake-button"]')).toBeVisible({ timeout: 10_000 });
    await expect(window.locator('[data-testid="agent-terminal"]')).not.toBeVisible();
  });

  test('agent list item shows sleeping status after exit', async () => {
    const item = window.locator(`[data-testid="agent-item-${AGENT_ID}"]`);
    await expect(item).toBeVisible({ timeout: 5_000 });

    const text = await item.textContent();
    expect(text?.toLowerCase()).toContain('sleeping');
  });
});
