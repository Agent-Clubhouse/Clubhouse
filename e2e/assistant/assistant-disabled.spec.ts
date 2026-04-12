/**
 * E2E tests for the assistant when the experimental flag is DISABLED.
 *
 * Mission 73 — Assistant visual crash on view (P1).
 *
 * Before the fix, the assistant page was wrapped in `{assistantEnabled && ...}`
 * in App.tsx. When the flag was off — the default in stable builds — the
 * assistant tab rendered only the title bar and banners with no main content,
 * which Mason reported as a "visual crash on view".
 *
 * These tests verify the fix end-to-end by reaching the assistant tab from
 * a stable-build-like state (flag explicitly disabled) via the rail button,
 * and asserting:
 *   1. The page resolves to the disabled placeholder, not a blank content area.
 *   2. The recovery button ("Open Experimental Settings") is present and routes
 *      back to the settings page.
 *   3. No JS errors are emitted on navigation.
 *
 * Uses an isolated Electron instance with a clean user data dir so no state
 * leaks from the main `assistant.spec.ts` file (which intentionally enables
 * the flag in its launch helper).
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
 * EXPLICITLY disabled (default for stable builds).
 */
async function launchDisabledInstance(): Promise<DisabledInstance> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-assistant-disabled-'));

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

  // Explicitly DISABLE the assistant flag to simulate a stable build's default state.
  await window.evaluate(async () => {
    const w = window as unknown as {
      clubhouse?: {
        app?: {
          getExperimentalSettings?: () => Promise<Record<string, boolean>>;
          saveExperimentalSettings?: (s: Record<string, boolean>) => Promise<void>;
        };
      };
    };
    if (w.clubhouse?.app?.getExperimentalSettings && w.clubhouse?.app?.saveExperimentalSettings) {
      const expSettings = await w.clubhouse.app.getExperimentalSettings();
      await w.clubhouse.app.saveExperimentalSettings({ ...expSettings, assistant: false });
    }
  });

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

test('clicking nav-assistant when flag is disabled shows placeholder, not blank page', async () => {
  const { window } = instance;

  // Wait for the rail to mount
  const assistantBtn = window.locator('[data-testid="nav-assistant"]');
  await expect(assistantBtn).toBeVisible({ timeout: 10_000 });

  // Click the assistant rail button — same flow as a stable-build user would take
  await assistantBtn.click();

  // The assistant view should mount and resolve to the disabled state.
  // Before the Mission 73 fix, this navigation produced an empty content area
  // (the title bar would render but the assistant view itself was gated out
  // of the JSX entirely by `{assistantEnabled && ...}`).
  const assistantView = window.locator('[data-testid="assistant-view"]');
  await expect(assistantView).toBeVisible({ timeout: 10_000 });

  // The data attribute should resolve away from "loading" to "disabled".
  await expect(assistantView).toHaveAttribute('data-assistant-state', 'disabled', {
    timeout: 10_000,
  });

  // The recovery button should be present.
  await expect(window.locator('[data-testid="assistant-open-settings-button"]')).toBeVisible();

  // The chat UI elements should NOT be present (the bug they replaced).
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="assistant-message-input"]')).toHaveCount(0);

  // No JS errors on navigation — the original bug was visual emptiness, but
  // we want this guard so a future regression that throws is caught here too.
  expect(instance.pageErrors).toHaveLength(0);
});

test('clicking "Open Experimental Settings" routes to settings page', async () => {
  const { window } = instance;

  // The previous test left us on the assistant tab in the disabled state.
  // Re-open if we got navigated away.
  const assistantView = window.locator('[data-testid="assistant-view"]');
  if (!(await assistantView.isVisible().catch(() => false))) {
    await window.locator('[data-testid="nav-assistant"]').click();
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
