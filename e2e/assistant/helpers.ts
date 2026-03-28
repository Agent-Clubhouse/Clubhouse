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
 */
export async function launchAssistantInstance(): Promise<AssistantInstance> {
  const userDataDir = createTempUserData();

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
