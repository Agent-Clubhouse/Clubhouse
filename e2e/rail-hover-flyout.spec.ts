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

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// Rail Hover Flyout Tests
// ---------------------------------------------------------------------------

test.describe('Rail Hover Flyout', () => {
  test('rail expands beyond collapsed width on hover', async () => {
    // Add a project so there is content to display in the flyout
    await addProject(FIXTURE_A);

    // Locate the rail outer container (parent of the inner styled rail)
    // The ProjectRail root is the first child of the grid, with class "relative"
    const railOuter = window.locator('[data-testid="nav-home"]').locator('..').locator('..');

    // Measure collapsed width of the inner rail div
    const innerRail = railOuter.locator('> div').first();
    const collapsedWidth = await innerRail.evaluate((el) => el.getBoundingClientRect().width);

    // Collapsed width should be the base width (68 or 74 depending on scroll)
    expect(collapsedWidth).toBeLessThan(100);

    // Hover over the rail to trigger expansion
    await railOuter.hover();

    // Wait for the 600ms hover delay + 200ms animation
    await window.waitForTimeout(900);

    // Measure expanded width — should be 200px
    const expandedWidth = await innerRail.evaluate((el) => el.getBoundingClientRect().width);
    expect(expandedWidth).toBeGreaterThanOrEqual(190); // ~200px, allow small rounding

    // Move mouse away to collapse
    await window.locator('[data-testid="title-bar"]').hover();
    await window.waitForTimeout(300);

    // Should return to collapsed width
    const afterWidth = await innerRail.evaluate((el) => el.getBoundingClientRect().width);
    expect(afterWidth).toBeLessThan(100);
  });

  test('project labels are visible when rail is expanded', async () => {
    // The project label spans should be visible when expanded
    const railOuter = window.locator('[data-testid="nav-home"]').locator('..').locator('..');

    // Hover to expand
    await railOuter.hover();
    await window.waitForTimeout(900);

    // The label text for project-a should be visible (not clipped)
    const label = window.locator('text=project-a').first();
    const bbox = await label.boundingBox();
    expect(bbox).not.toBeNull();
    // Label should be visible and not zero-width clipped
    expect(bbox!.width).toBeGreaterThan(10);

    // Move away
    await window.locator('[data-testid="title-bar"]').hover();
    await window.waitForTimeout(300);
  });
});
