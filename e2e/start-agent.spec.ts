/**
 * E2E Behavioral Spec: Agent Lifecycle — Spawn, Message, Exit
 *
 * TC-CRIT-01: Core product flow had zero E2E coverage.
 *
 * Tests the full lifecycle end-to-end using IPC stubs for CI compatibility:
 *   sleeping → wake → running → send message → response in feed → exit → sleeping
 *
 * Uses structuredMode agents because they expose deterministic, testid-addressable
 * UI for both message input and response rendering — no PTY canvas interaction needed.
 *
 * IPC stubs replace the real Claude CLI spawn with in-process fake events so the
 * spec runs in CI without any orchestrator installed.
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
          structuredMode: true,
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
 * agent:spawn-agent        — fires waking then awoke events; renderer transitions
 *                            through waking → running without a real Claude process.
 * agent:kill-agent         — fires sleeping; store transitions agent back to sleeping.
 * agent:send-structured-message — fires text_delta + text_done to simulate a reply.
 * agent:cancel-structured  — no-op (stop button calls this before killAgent).
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

    ipcMain.removeHandler('agent:send-structured-message');
    ipcMain.handle(
      'agent:send-structured-message',
      async (_evt, agentId: string, message: string) => {
        const win = getWin();
        if (!win) return;
        const now = Date.now();
        win.webContents.send('agent:structured-event', agentId, {
          type: 'text_delta',
          timestamp: now,
          data: { text: `Echo: ${message}` },
        });
        setTimeout(() => {
          if (win.isDestroyed()) return;
          win.webContents.send('agent:structured-event', agentId, {
            type: 'text_done',
            timestamp: Date.now(),
            data: { text: `Echo: ${message}` },
          });
        }, 80);
      },
    );

    ipcMain.removeHandler('agent:cancel-structured');
    ipcMain.handle('agent:cancel-structured', async () => {});
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let electronApp: ElectronApp;
let window: Page;

test.beforeAll(async () => {
  writeLifecycleAgent();

  // structuredMode experimental flag must be on from first mount — write before launch
  ({ electronApp, window } = await launchApp({ experimental: { structuredMode: true } }));

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
// 2. Wake → Running — click wake, assert StructuredAgentView renders
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Wake to Running', () => {
  test('clicking wake transitions agent to running state', async () => {
    const wakeBtn = window.locator('[data-testid="wake-button"]');
    await expect(wakeBtn).toBeVisible({ timeout: 5_000 });
    await wakeBtn.click();

    await expect(
      window.locator('[data-testid="structured-agent-view"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('running agent exposes message input and stop button', async () => {
    await expect(window.locator('[data-testid="message-input"]')).toBeVisible({ timeout: 5_000 });
    await expect(window.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Message exchange — send a message, assert response appears in feed
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Message Exchange', () => {
  test('sending a message produces a text response in the event feed', async () => {
    const input = window.locator('[data-testid="message-input"]');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toBeEnabled({ timeout: 5_000 });

    const TEST_MSG = 'hello lifecycle test';
    await input.fill(TEST_MSG);
    await input.press('Enter');

    // Stub fires text_delta → MessageStream renders the echoed text in the feed
    const feed = window.locator('[data-testid="event-feed"]');
    await expect(feed).toBeVisible({ timeout: 5_000 });
    await expect(feed.locator(`text=Echo: ${TEST_MSG}`)).toBeVisible({ timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. Exit → Sleeping — click stop, assert agent returns to sleeping state
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Exit to Sleeping', () => {
  test('clicking stop transitions agent back to sleeping state', async () => {
    const stopBtn = window.locator('[data-testid="stop-button"]');
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    await stopBtn.click();

    // Stub fires agent:agent-sleeping → store sets status sleeping → SleepingAgent renders
    await expect(window.locator('[data-testid="wake-button"]')).toBeVisible({ timeout: 10_000 });
  });

  test('agent list item shows sleeping status after exit', async () => {
    const item = window.locator(`[data-testid="agent-item-${AGENT_ID}"]`);
    await expect(item).toBeVisible({ timeout: 5_000 });

    const text = await item.textContent();
    expect(text?.toLowerCase()).toContain('sleeping');
  });
});
