/**
 * E2E helpers for the Clubhouse Assistant feature.
 *
 * Provides isolated app launch (via CLUBHOUSE_USER_DATA), panel opening,
 * message sending, and response-waiting utilities.
 */
import { _electron as electron, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const APP_PATH = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

export interface AssistantInstance {
  electronApp: Awaited<ReturnType<typeof electron.launch>>;
  window: Page;
  userDataDir: string;
}

/**
 * Create a temporary userData directory for test isolation.
 */
function createTempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-assistant-'));
}

/**
 * Find the renderer window (skip DevTools).
 */
async function findRendererWindow(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
): Promise<Page> {
  const seen = new Set<Page>();

  for (const page of electronApp.windows()) {
    if (page.url().startsWith('devtools://')) { seen.add(page); continue; }
    try {
      await page.waitForLoadState('load');
      if (await page.evaluate(() => !!document.getElementById('root'))) return page;
    } catch { /* not ready */ }
    seen.add(page);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await electronApp.waitForEvent('window', {
      timeout: Math.max(1_000, deadline - Date.now()),
    });
    if (seen.has(page)) continue;
    seen.add(page);
    if (page.url().startsWith('devtools://')) continue;
    try {
      await page.waitForLoadState('load');
      if (await page.evaluate(() => !!document.getElementById('root'))) return page;
    } catch { /* not ready */ }
  }

  throw new Error('Timed out waiting for renderer window (30 s)');
}

/**
 * Launch an isolated Clubhouse instance for assistant E2E tests.
 * Uses a temporary CLUBHOUSE_USER_DATA directory for clean state.
 *
 * The assistant feature is gated behind `experimental.assistant` in both the
 * AssistantView and the rail's nav-assistant button. The rail reads the flag
 * once on mount, so we must pre-write the settings file BEFORE launching
 * electron — writing post-mount via IPC would leave the rail in its initial
 * (Help button) state and `nav-assistant` would never appear.
 */
export async function launchAssistantInstance(): Promise<AssistantInstance> {
  const userDataDir = createTempUserData();

  // Pre-write the experimental settings so the flag is on from the very first
  // read (settings-store reads from `userData/experimental-settings.json`).
  fs.writeFileSync(
    path.join(userDataDir, 'experimental-settings.json'),
    JSON.stringify({ assistant: true }, null, 2),
    'utf-8',
  );

  const electronApp = await electron.launch({
    args: ['--disable-gpu', MAIN_ENTRY],
    cwd: APP_PATH,
    env: {
      ...process.env,
      CLUBHOUSE_USER_DATA: userDataDir,
    },
  });

  const window = await findRendererWindow(electronApp);
  await window.waitForLoadState('load');

  // Install stub IPC handlers in CI where no real orchestrator is available
  if (process.env.CI) {
    await installAssistantStub(electronApp);
  }

  // Skip onboarding
  await window.evaluate(() => {
    localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: null }));
  });

  const onboardingBackdrop = window.locator('[data-testid="onboarding-backdrop"]');
  try {
    await onboardingBackdrop.waitFor({ state: 'visible', timeout: 3_000 });
    await window.locator('[data-testid="onboarding-skip"]').click();
    await onboardingBackdrop.waitFor({ state: 'hidden', timeout: 5_000 });
  } catch {
    // Onboarding already completed
  }

  return { electronApp, window, userDataDir };
}

/**
 * Install stub IPC handlers that replace the real orchestrator with canned
 * responses. Call this immediately after launching the app in CI so tests
 * 10-15 can run without a live orchestrator binary.
 *
 * Overrides (no fs I/O — responses stored in a closure Map):
 * - agent:check-orchestrator → always available
 * - agent:read-transcript    → returns canned JSONL from in-memory Map
 * - assistant:spawn          → stores response (headless) or emits structured events
 * - assistant:send-followup  → stores response, returns { agentId }
 * - assistant:send-structured-followup → emits structured events, returns { agentId }
 */
async function installAssistantStub(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
): Promise<void> {
  // NOTE: electronApp.evaluate() runs in a V8 sandbox that has NO access to
  // CommonJS require() or ESM import(). Only JS built-ins and the objects
  // passed as parameters are available. All state must be kept in closure.
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    // In-memory transcript store — keyed by agentId, avoids any fs I/O.
    const transcripts = new Map<string, string>();

    function broadcast(channel: string, ...args: unknown[]): void {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, ...args);
      }
    }

    // Always report an orchestrator as available so startAgent proceeds
    ipcMain.removeHandler('agent:check-orchestrator');
    ipcMain.handle('agent:check-orchestrator', () => ({ available: true }));

    // Intercept transcript reads — return the canned response stored in memory
    ipcMain.removeHandler('agent:read-transcript');
    ipcMain.handle('agent:read-transcript', (_event: Electron.IpcMainInvokeEvent, agentId: unknown) => {
      const text = transcripts.get(agentId as string) ?? '';
      return [
        JSON.stringify({ type: 'text', text }),
        JSON.stringify({ type: 'result', result: text }),
      ].join('\n') + '\n';
    });

    // Stub assistant:spawn — handles headless and structured modes
    ipcMain.removeHandler('assistant:spawn');
    ipcMain.handle('assistant:spawn', (_event: Electron.IpcMainInvokeEvent, params: Record<string, unknown>) => {
      const agentId = params['agentId'] as string;
      const executionMode = params['executionMode'] as string;
      const responseText = 'Hello! I can help you with Clubhouse.';

      if (executionMode === 'structured') {
        setTimeout(() => {
          broadcast('agent:structured-event', agentId, { type: 'text_delta', timestamp: Date.now(), data: { text: responseText } });
          broadcast('agent:structured-event', agentId, { type: 'text_done', timestamp: Date.now(), data: { text: responseText } });
          broadcast('agent:structured-event', agentId, { type: 'end', timestamp: Date.now(), data: { reason: 'done' } });
        }, 300);
      } else if (executionMode === 'headless') {
        transcripts.set(agentId, responseText);
        setTimeout(() => broadcast('assistant:result', { agentId, exitCode: 0 }), 300);
      }

      return { success: true };
    });

    // Stub assistant:send-followup — headless conversational follow-ups
    ipcMain.removeHandler('assistant:send-followup');
    ipcMain.handle('assistant:send-followup', (_event: Electron.IpcMainInvokeEvent, params: Record<string, unknown>) => {
      const message = (params['message'] as string) || '';
      const agentId = `stub_followup_${Date.now()}`;
      const responseText = /my name/i.test(message)
        ? 'Your name is TestUser.'
        : 'I understand your question.';

      transcripts.set(agentId, responseText);
      setTimeout(() => broadcast('assistant:result', { agentId, exitCode: 0 }), 300);
      return { agentId };
    });

    // Stub assistant:send-structured-followup — structured follow-ups
    ipcMain.removeHandler('assistant:send-structured-followup');
    ipcMain.handle('assistant:send-structured-followup', () => {
      const agentId = `stub_structured_followup_${Date.now()}`;
      const responseText = 'I understand your follow-up.';

      setTimeout(() => {
        broadcast('agent:structured-event', agentId, { type: 'text_delta', timestamp: Date.now(), data: { text: responseText } });
        broadcast('agent:structured-event', agentId, { type: 'text_done', timestamp: Date.now(), data: { text: responseText } });
        broadcast('agent:structured-event', agentId, { type: 'end', timestamp: Date.now(), data: { reason: 'done' } });
      }, 300);

      return { agentId };
    });
  });
}

/**
 * Clean up an assistant test instance.
 */
export async function cleanupAssistantInstance(handle: AssistantInstance): Promise<void> {
  try {
    await handle.electronApp.close();
  } catch {
    // App may have already exited
  }
  try {
    fs.rmSync(handle.userDataDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Open the assistant panel by clicking the nav rail button.
 * Idempotent — if the panel is already open, does nothing.
 * This prevents the toggle from accidentally closing the panel
 * when it's already visible (e.g., from a prior test or state).
 */
export async function openAssistantPanel(window: Page): Promise<void> {
  const assistantView = window.locator('[data-testid="assistant-view"]');

  // If panel is already open, nothing to do
  if (await assistantView.isVisible().catch(() => false)) return;

  const assistantBtn = window.locator('[data-testid="nav-assistant"]');
  await expect(assistantBtn).toBeVisible({ timeout: 10_000 });
  await assistantBtn.click();
  await expect(assistantView).toBeVisible({ timeout: 10_000 });
}

/**
 * Close the assistant panel if it's open.
 */
export async function closeAssistantPanel(window: Page): Promise<void> {
  const assistantView = window.locator('[data-testid="assistant-view"]');

  if (!(await assistantView.isVisible().catch(() => false))) return;

  const assistantBtn = window.locator('[data-testid="nav-assistant"]');
  await assistantBtn.click();
  await expect(assistantView).not.toBeVisible({ timeout: 10_000 });
}

/**
 * Reset the assistant conversation and wait for welcome state.
 * Call this at the start of each test for independence.
 */
export async function resetAssistant(window: Page): Promise<void> {
  await openAssistantPanel(window);
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });
}

/**
 * Send a message in the assistant chat input and press Enter.
 */
export async function sendAssistantMessage(window: Page, message: string): Promise<void> {
  const input = window.locator('[data-testid="assistant-message-input"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeEnabled({ timeout: 5_000 });
  await input.fill(message);
  await input.press('Enter');
}

/**
 * Wait for an assistant response message to appear in the feed.
 * Returns the text content of the first assistant message.
 */
export async function waitForAssistantResponse(window: Page, timeout = 60_000): Promise<string> {
  const assistantMsg = window.locator('[data-testid="assistant-message"]').first();
  await assistantMsg.waitFor({ state: 'visible', timeout });
  const text = await assistantMsg.textContent();
  return text?.trim() || '';
}

/**
 * Wait for an action card to appear in the feed.
 */
export async function waitForActionCard(window: Page, timeout = 60_000): Promise<void> {
  const actionCard = window.locator('[data-testid="assistant-action-card"]').first();
  await actionCard.waitFor({ state: 'visible', timeout });
}

/**
 * Switch the assistant mode via the mode toggle buttons.
 */
export async function switchMode(window: Page, mode: 'interactive' | 'headless' | 'structured'): Promise<void> {
  const modeBtn = window.locator(`[data-testid="mode-${mode}"]`);
  await expect(modeBtn).toBeVisible({ timeout: 5_000 });
  await modeBtn.click();
}

/**
 * Wait for any feed content (action card or assistant message) to appear.
 */
export async function waitForFeedContent(window: Page, timeout = 60_000): Promise<void> {
  const feedContent = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await feedContent.waitFor({ state: 'visible', timeout });
}
