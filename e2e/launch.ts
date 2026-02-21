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
    // Wait until the backdrop is actually gone before returning.
    await onboardingBackdrop.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }

  return { electronApp, window: rendererWindow };
}

async function findRendererWindow(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
) {
  // Check windows already open
  for (const page of electronApp.windows()) {
    if (!page.url().startsWith('devtools://')) return page;
  }

  // Wait for the renderer window to appear
  return electronApp.waitForEvent('window', {
    predicate: (page) => !page.url().startsWith('devtools://'),
  });
}
