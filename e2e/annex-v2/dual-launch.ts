/**
 * Dual-launch harness for Annex V2 E2E tests.
 *
 * Launches two isolated Clubhouse Electron instances with separate userData
 * directories, allowing end-to-end testing of the desktop-to-desktop remote
 * control protocol.
 */
import { _electron as electron } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const APP_PATH = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

export interface InstanceHandle {
  electronApp: Awaited<ReturnType<typeof electron.launch>>;
  window: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
  userDataDir: string;
}

export interface DualInstanceHandles {
  satellite: InstanceHandle;
  controller: InstanceHandle;
}

/**
 * Create a temporary userData directory with a unique name.
 */
function createTempUserData(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clubhouse-e2e-${label}-`));
  return dir;
}

/**
 * Find the renderer window (skip DevTools windows).
 */
async function findRendererWindow(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
) {
  const seen = new Set<Awaited<ReturnType<typeof electronApp.firstWindow>>>();

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
 * Launch a single Electron instance with an isolated userData directory.
 */
async function launchInstance(label: string): Promise<InstanceHandle> {
  const userDataDir = createTempUserData(label);

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
 * Launch two isolated Clubhouse instances (satellite + controller).
 */
export async function launchDual(): Promise<DualInstanceHandles> {
  const [satellite, controller] = await Promise.all([
    launchInstance('satellite'),
    launchInstance('controller'),
  ]);

  return { satellite, controller };
}

/**
 * Clean up an instance: close the app and remove its temp userData directory.
 */
export async function cleanupInstance(handle: InstanceHandle): Promise<void> {
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
 * Clean up both instances.
 */
export async function cleanupDual(handles: DualInstanceHandles): Promise<void> {
  await Promise.all([
    cleanupInstance(handles.satellite),
    cleanupInstance(handles.controller),
  ]);
}
