/**
 * E2E tests for the assistant when the experimental flag is DISABLED.
 *
 * Originally written for Mission 73 (Assistant visual crash on view P1) when
 * the rail's Assistant button was always visible regardless of flag state and
 * clicking it produced a blank page. That gap has since been closed: the rail
 * now hides the Assistant button entirely when the flag is off, and the Help
 * button takes its place. These tests cover the new gating contract:
 *
 *   1. With the flag disabled, the rail shows the Help button (not Assistant).
 *   2. The placeholder still renders as defense-in-depth — if the user reaches
 *      the assistant tab via the keyboard shortcut (which is not gated), the
 *      AssistantView's internal flag check shows the disabled placeholder
 *      with a recovery button rather than a blank content area.
 *
 * Uses an isolated Electron instance with a clean user data dir.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const APP_PATH = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

interface DisabledInstance {
  electronApp: Awaited<ReturnType<typeof electron.launch>>;
  window: Page;
  userDataDir: string;
  pageErrors: Error[];
}

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
 * Launch a clean Clubhouse instance with the assistant experimental flag
 * EXPLICITLY disabled (default for stable builds). Pre-writes the settings
 * file before launch so the rail's mount-time flag fetch sees the disabled
 * value (writing via IPC after mount would not retroactively re-render the
 * rail's gated button).
 */
async function launchDisabledInstance(): Promise<DisabledInstance> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-assistant-disabled-'));

  fs.writeFileSync(
    path.join(userDataDir, 'experimental-settings.json'),
    JSON.stringify({ assistant: false }, null, 2),
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

  const pageErrors: Error[] = [];
  window.on('pageerror', (error) => pageErrors.push(error));

  // Skip onboarding so we can interact with the chrome
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

  return { electronApp, window, userDataDir, pageErrors };
}

async function cleanupInstance(handle: DisabledInstance): Promise<void> {
  try { await handle.electronApp.close(); } catch { /* ok */ }
  try { fs.rmSync(handle.userDataDir, { recursive: true, force: true }); } catch { /* ok */ }
}

let instance: DisabledInstance;

test.beforeAll(async () => {
  instance = await launchDisabledInstance();
});

test.afterAll(async () => {
  await cleanupInstance(instance);
});

test.beforeEach(() => {
  instance.pageErrors.length = 0;
});

test('rail shows Help button (not Assistant) when assistant flag is disabled', async () => {
  const { window } = instance;

  // The Help button — the pre-experiment default — should be visible.
  const helpBtn = window.locator('[data-testid="nav-help"]');
  await expect(helpBtn).toBeVisible({ timeout: 10_000 });

  // The Assistant button must not be in the DOM at all when the flag is off.
  await expect(window.locator('[data-testid="nav-assistant"]')).toHaveCount(0);

  expect(instance.pageErrors).toHaveLength(0);
});

/**
 * Dispatch the toggle-assistant keyboard event directly. Playwright's
 * keyboard.press() goes through OS-level key translation, which on macOS
 * turns Shift+`.` into `>` and would not match the binding `Meta+Shift+.`.
 * Synthesizing the KeyboardEvent locally with the literal key the
 * eventToBinding() handler expects sidesteps that translation.
 */
async function fireToggleAssistantShortcut(window: Page): Promise<void> {
  await window.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '.',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    }));
  });
}

test('keyboard shortcut to assistant shows disabled placeholder, not blank page', async () => {
  const { window } = instance;

  // The toggle-assistant keyboard shortcut (Meta+Shift+.) is registered
  // independently of the rail button gating, so a user who memorized it can
  // still trigger navigation to the assistant tab. The AssistantView's own
  // flag check should then render the disabled placeholder — never a blank
  // content area (the original Mission 73 bug).
  await fireToggleAssistantShortcut(window);

  const assistantView = window.locator('[data-testid="assistant-view"]');
  await expect(assistantView).toBeVisible({ timeout: 10_000 });
  await expect(assistantView).toHaveAttribute('data-assistant-state', 'disabled', {
    timeout: 10_000,
  });

  // The recovery button should be present.
  await expect(window.locator('[data-testid="assistant-open-settings-button"]')).toBeVisible();

  // The chat UI must not appear in the disabled state.
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="assistant-message-input"]')).toHaveCount(0);

  expect(instance.pageErrors).toHaveLength(0);
});

test('clicking "Open Experimental Settings" routes to settings page', async () => {
  const { window } = instance;

  // The previous test left us on the assistant tab in the disabled state.
  // Re-open via the synthesized keyboard shortcut if we got navigated away.
  const assistantView = window.locator('[data-testid="assistant-view"]');
  if (!(await assistantView.isVisible().catch(() => false))) {
    await fireToggleAssistantShortcut(window);
    await expect(assistantView).toBeVisible({ timeout: 10_000 });
  }
  await expect(assistantView).toHaveAttribute('data-assistant-state', 'disabled', {
    timeout: 10_000,
  });

  const settingsBtn = window.locator('[data-testid="assistant-open-settings-button"]');
  await expect(settingsBtn).toBeVisible();
  await settingsBtn.click();

  // After clicking, the assistant view should no longer be on screen
  // (we navigated away to the settings page).
  await expect(assistantView).toHaveCount(0, { timeout: 5_000 });

  expect(instance.pageErrors).toHaveLength(0);
});
