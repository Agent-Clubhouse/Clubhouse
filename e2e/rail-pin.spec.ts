import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stubDialogForPath(dirPath: string) {
  await electronApp.evaluate(
    async ({ dialog, BrowserWindow }, fixturePath) => {
      const win =
        BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().startsWith('devtools://'),
        ) ?? BrowserWindow.getAllWindows()[0] ?? null;
      BrowserWindow.getFocusedWindow = () => win;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fixturePath],
      });
    },
    dirPath,
  );
}

async function addProject(dirPath: string) {
  await stubDialogForPath(dirPath);
  const addBtn = window.locator('[data-testid="nav-add-project"]');
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

/** Hover rail until it expands (600ms delay + animation) */
async function hoverRailUntilExpanded() {
  const railOuter = window.locator('[data-testid="project-rail"]');
  await railOuter.hover();
  const innerRail = railOuter.locator('> div').first();
  await expect(async () => {
    const w = await innerRail.evaluate((el) => el.getBoundingClientRect().width);
    expect(w).toBeGreaterThanOrEqual(140);
  }).toPass({ timeout: 5_000 });
}

/** Move mouse away from rail to trigger collapse */
async function moveMouseAway() {
  await window.locator('[data-testid="title-bar"]').hover();
}

/** Get current inner rail width */
async function getInnerRailWidth(): Promise<number> {
  const railOuter = window.locator('[data-testid="project-rail"]');
  const innerRail = railOuter.locator('> div').first();
  return innerRail.evaluate((el) => el.getBoundingClientRect().width);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await window.waitForLoadState('load');
  await expect(window.locator('[data-testid="nav-add-project"]')).toBeVisible({
    timeout: 30_000,
  });
  // Add a project so the rail has content
  await addProject(FIXTURE_A);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// Rail Pin Tests
// ---------------------------------------------------------------------------

test.describe('Rail Pin Feature', () => {
  // Ensure rail is unpinned before each test
  test.beforeEach(async () => {
    // Reset pin state via localStorage
    await window.evaluate(() => {
      const raw = localStorage.getItem('clubhouse_panel_sizes');
      if (raw) {
        const parsed = JSON.parse(raw);
        parsed.railPinned = false;
        localStorage.setItem('clubhouse_panel_sizes', JSON.stringify(parsed));
      }
    });
    // Reload the store state to pick up the reset
    await window.evaluate(() => {
      // Directly update the zustand store if accessible
      (window as unknown as { __zustand_panelStore?: { setState: (s: Record<string, unknown>) => void } }).__zustand_panelStore?.setState?.({
        railPinned: false,
      });
    });
  });

  test('pin button is visible when rail is hover-expanded', async () => {
    await hoverRailUntilExpanded();

    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await expect(pinBtn).toBeVisible();

    // Verify it has opacity-100 (visible)
    const opacity = await pinBtn.evaluate((el) => {
      return window.getComputedStyle(el).opacity;
    });
    expect(Number(opacity)).toBeGreaterThan(0);

    await moveMouseAway();
    await window.waitForTimeout(300);
  });

  test('clicking pin keeps rail expanded after mouse leaves', async () => {
    // Hover to expand
    await hoverRailUntilExpanded();

    // Click the pin button
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();

    // Move mouse away
    await moveMouseAway();
    await window.waitForTimeout(500);

    // Rail should still be expanded (>= 140px, the minimum pinned width)
    const width = await getInnerRailWidth();
    expect(width).toBeGreaterThanOrEqual(140);
  });

  test('pinned rail shows project labels', async () => {
    // Hover and pin
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();

    // Move away — labels should still be visible
    await moveMouseAway();
    await window.waitForTimeout(300);

    const label = window.locator('text=project-a').first();
    const bbox = await label.boundingBox();
    expect(bbox).not.toBeNull();
    expect(bbox!.width).toBeGreaterThan(10);
  });

  test('resize divider appears when rail is pinned', async () => {
    // Hover and pin
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();
    await moveMouseAway();
    await window.waitForTimeout(300);

    // A resize divider should now be in the DOM adjacent to the rail
    const dividers = window.locator('[data-testid="resize-divider"]');
    const count = await dividers.count();
    // At least one divider should exist (the rail one)
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('pinned rail is resizable by dragging divider', async () => {
    // Hover and pin
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();
    await moveMouseAway();
    await window.waitForTimeout(300);

    const widthBefore = await getInnerRailWidth();

    // Find the first resize divider (which should be the rail divider)
    const divider = window.locator('[data-testid="resize-divider"]').first();
    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();

    // Drag the divider to the right by 80px
    const startX = dividerBox!.x + dividerBox!.width / 2;
    const startY = dividerBox!.y + dividerBox!.height / 2;
    await window.mouse.move(startX, startY);
    await window.mouse.down();
    await window.mouse.move(startX + 80, startY, { steps: 5 });
    await window.mouse.up();

    await window.waitForTimeout(200);
    const widthAfter = await getInnerRailWidth();

    // Width should have increased
    expect(widthAfter).toBeGreaterThan(widthBefore);
  });

  test('unpinning restores hover collapse behavior', async () => {
    // Pin the rail
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();
    await moveMouseAway();
    await window.waitForTimeout(300);

    // Verify it stays open
    let width = await getInnerRailWidth();
    expect(width).toBeGreaterThanOrEqual(140);

    // Now unpin by hovering back and clicking pin again
    const railOuter = window.locator('[data-testid="project-rail"]');
    await railOuter.hover();
    await window.waitForTimeout(200);
    await pinBtn.click();

    // Move mouse away — rail should collapse
    await moveMouseAway();
    await window.waitForTimeout(500);

    width = await getInnerRailWidth();
    expect(width).toBeLessThan(100);
  });

  test('pin state persists in localStorage', async () => {
    // Pin the rail
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();
    await window.waitForTimeout(200);

    // Check localStorage
    const persisted = await window.evaluate(() => {
      const raw = localStorage.getItem('clubhouse_panel_sizes');
      return raw ? JSON.parse(raw) : null;
    });

    expect(persisted).not.toBeNull();
    expect(persisted.railPinned).toBe(true);
  });

  test('pinned rail does not use overlay positioning', async () => {
    // Pin the rail
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();
    await moveMouseAway();
    await window.waitForTimeout(300);

    // The inner rail should not have position: absolute
    const railOuter = window.locator('[data-testid="project-rail"]');
    const innerRail = railOuter.locator('> div').first();
    const position = await innerRail.evaluate((el) => {
      return window.getComputedStyle(el).position;
    });
    expect(position).not.toBe('absolute');
  });

  test('pin button shows filled icon when pinned', async () => {
    // Pin the rail
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    await pinBtn.click();
    await window.waitForTimeout(200);

    // Check SVG fill attribute
    const svg = pinBtn.locator('svg');
    const fill = await svg.getAttribute('fill');
    expect(fill).toBe('currentColor');
  });

  test('pin button shows outline icon when unpinned', async () => {
    await hoverRailUntilExpanded();
    const pinBtn = window.locator('[data-testid="rail-pin-button"]');
    const svg = pinBtn.locator('svg');
    const fill = await svg.getAttribute('fill');
    expect(fill).toBe('none');
    await moveMouseAway();
    await window.waitForTimeout(300);
  });
});
