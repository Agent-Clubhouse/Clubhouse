import { _electron as electron } from '@playwright/test';
import * as path from 'path';

const APP_PATH = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

/**
 * Launch the Electron app and return the renderer window (skipping DevTools).
 * DevTools opens automatically for unpackaged builds, so firstWindow() may
 * return the DevTools page instead of the renderer.
 */
export async function launchApp() {
  const electronApp = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: APP_PATH,
  });

  // Collect all windows that open, then pick the renderer (non-devtools) one.
  const rendererWindow = await findRendererWindow(electronApp);
  await rendererWindow.waitForLoadState('load');

  // Mark onboarding as completed so it doesn't appear during E2E tests.
  await rendererWindow.evaluate(() => {
    localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: null }));
  });

  // The onboarding store reads localStorage at module-load time (before our
  // evaluate runs), so a 500ms timer in App.tsx may still fire startOnboarding().
  // Wait long enough for the timer (500ms) + React render, then dismiss if
  // the modal appeared.  Use a generous timeout for slow CI runners (Ubuntu).
  const onboardingBackdrop = rendererWindow.locator('[data-testid="onboarding-backdrop"]');
  const isVisible = await onboardingBackdrop.isVisible({ timeout: 3_000 }).catch(() => false);
  if (isVisible) {
    await rendererWindow.locator('[data-testid="onboarding-skip"]').click();
    await onboardingBackdrop.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }

  return { electronApp, window: rendererWindow };
}

async function findRendererWindow(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
) {
  // Fast path: pick the first non-devtools window already open.
  // DevTools may briefly have a non-devtools:// URL on startup, so after
  // the URL check we verify the page has our renderer's <div id="root">.
  // If verification fails, we wait for the next window.
  const seen = new Set<Awaited<ReturnType<typeof electronApp.firstWindow>>>();

  for (const page of electronApp.windows()) {
    if (page.url().startsWith('devtools://')) { seen.add(page); continue; }
    // Validate: wait for load so evaluate() has a JS context, then check #root.
    try {
      await page.waitForLoadState('load');
      if (await page.evaluate(() => !!document.getElementById('root'))) return page;
    } catch { /* not ready */ }
    seen.add(page);
  }

  // Wait for new windows — the renderer hasn't appeared yet or was
  // mis-identified above.
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
