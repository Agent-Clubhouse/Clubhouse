import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';

const APP_PATH = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

/**
 * Launch the app with a clean onboarding state (not completed).
 * This intentionally does NOT call the shared launchApp helper because
 * that helper marks onboarding as completed.
 */
async function launchFresh() {
  electronApp = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: APP_PATH,
  });

  // Find renderer window — DevTools may briefly have a non-devtools:// URL,
  // so after the URL check we verify the page has <div id="root">.
  type PageType = Awaited<ReturnType<typeof electronApp.firstWindow>>;
  const seen = new Set<PageType>();

  for (const page of electronApp.windows()) {
    if (page.url().startsWith('devtools://')) { seen.add(page); continue; }
    try {
      await page.waitForLoadState('load');
      if (await page.evaluate(() => !!document.getElementById('root'))) { window = page; break; }
    } catch { /* not ready */ }
    seen.add(page);
  }

  if (!window) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const page: PageType = await electronApp.waitForEvent('window', {
        timeout: Math.max(1_000, deadline - Date.now()),
      });
      if (seen.has(page) || page.url().startsWith('devtools://')) { seen.add(page); continue; }
      seen.add(page);
      try {
        await page.waitForLoadState('load');
        if (await page.evaluate(() => !!document.getElementById('root'))) { window = page; break; }
      } catch { /* not ready */ }
    }
  }
  if (!window) throw new Error('Timed out waiting for renderer window (30 s)');

  await window.waitForLoadState('load');

  // Ensure onboarding state is cleared so modal appears
  await window.evaluate(() => {
    localStorage.removeItem('clubhouse_onboarding');
  });

  // Reload to pick up the clean state
  await window.reload();
  await window.waitForLoadState('load');
}

test.beforeAll(async () => {
  await launchFresh();
});

test.afterAll(async () => {
  // Clean up: mark onboarding as completed so other test suites aren't affected
  if (window) {
    await window.evaluate(() => {
      localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: null }));
    });
  }
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// Onboarding Flow
// ---------------------------------------------------------------------------

test.describe('Onboarding Flow', () => {
  test('onboarding modal appears on first launch', async () => {
    const modal = window.locator('[data-testid="onboarding-modal"]');
    await expect(modal).toBeVisible({ timeout: 5_000 });
  });

  test('cohort selection screen shows three options', async () => {
    const cohortSelection = window.locator('[data-testid="cohort-selection"]');
    await expect(cohortSelection).toBeVisible({ timeout: 5_000 });

    await expect(window.locator('[data-testid="cohort-new-dev"]')).toBeVisible();
    await expect(window.locator('[data-testid="cohort-experienced-dev"]')).toBeVisible();
    await expect(window.locator('[data-testid="cohort-seasoned-dev"]')).toBeVisible();
  });

  test('selecting a cohort advances to highlight carousel', async () => {
    await window.locator('[data-testid="cohort-new-dev"]').click();

    const carousel = window.locator('[data-testid="highlight-carousel"]');
    await expect(carousel).toBeVisible({ timeout: 3_000 });
  });

  test('carousel shows dot indicators', async () => {
    const dots = window.locator('[data-testid="carousel-dots"]');
    await expect(dots).toBeVisible();

    await expect(window.locator('[data-testid="carousel-dot-0"]')).toBeVisible();
    await expect(window.locator('[data-testid="carousel-dot-1"]')).toBeVisible();
    await expect(window.locator('[data-testid="carousel-dot-2"]')).toBeVisible();
  });

  test('next button advances through slides', async () => {
    const nextBtn = window.locator('[data-testid="carousel-next"]');

    // Advance to slide 2
    await nextBtn.click();
    await window.waitForTimeout(200);

    // Advance to slide 3
    await nextBtn.click();
    await window.waitForTimeout(200);

    // Next from slide 3 should go to get-started
    await nextBtn.click();

    const getStarted = window.locator('[data-testid="get-started-screen"]');
    await expect(getStarted).toBeVisible({ timeout: 3_000 });
  });

  test('get started screen shows help and extensibility buttons', async () => {
    await expect(window.locator('[data-testid="onboarding-help-btn"]')).toBeVisible();
    await expect(window.locator('[data-testid="onboarding-extensibility-btn"]')).toBeVisible();
    await expect(window.locator('[data-testid="onboarding-get-started-btn"]')).toBeVisible();
  });

  test('get started button closes onboarding', async () => {
    await window.locator('[data-testid="onboarding-get-started-btn"]').click();

    const modal = window.locator('[data-testid="onboarding-modal"]');
    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });

  test('onboarding does not reappear after completion', async () => {
    // Reload the page
    await window.reload();
    await window.waitForLoadState('load');
    await window.waitForTimeout(1_500);

    const modal = window.locator('[data-testid="onboarding-modal"]');
    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// Skip Button
// ---------------------------------------------------------------------------

test.describe('Onboarding Skip', () => {
  test('skip button dismisses onboarding at any point', async () => {
    // Reset onboarding state
    await window.evaluate(() => {
      localStorage.removeItem('clubhouse_onboarding');
    });
    await window.reload();
    await window.waitForLoadState('load');

    const modal = window.locator('[data-testid="onboarding-modal"]');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Click skip
    await window.locator('[data-testid="onboarding-skip"]').click();
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Verify it's persisted as completed
    const completed = await window.evaluate(() => {
      const raw = localStorage.getItem('clubhouse_onboarding');
      return raw ? JSON.parse(raw).completed : false;
    });
    expect(completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Back Button Navigation
// ---------------------------------------------------------------------------

test.describe('Onboarding Back Navigation', () => {
  test('back button returns from highlights to cohort selection', async () => {
    // Reset onboarding state
    await window.evaluate(() => {
      localStorage.removeItem('clubhouse_onboarding');
    });
    await window.reload();
    await window.waitForLoadState('load');

    const modal = window.locator('[data-testid="onboarding-modal"]');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Select a cohort
    await window.locator('[data-testid="cohort-experienced-dev"]').click();
    await expect(window.locator('[data-testid="highlight-carousel"]')).toBeVisible({ timeout: 3_000 });

    // Click back
    await window.locator('[data-testid="carousel-prev"]').click();

    // Should be back on cohort selection
    await expect(window.locator('[data-testid="cohort-selection"]')).toBeVisible({ timeout: 3_000 });

    // Clean up
    await window.locator('[data-testid="onboarding-skip"]').click();
  });
});
