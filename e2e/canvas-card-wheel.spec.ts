/**
 * #2111: a wheel over a scrolling region inside a canvas card scrolls that
 * region without panning the canvas; the card header still pans.
 *
 * A live chat transcript needs a running agent, so the test puts a
 * scrolling region into an unselected agent card's content area (the same
 * shape as a transcript: overflow-y auto with more content than fits) and
 * uses real mouse-wheel input. It checks that the wheel reached the region and
 * the canvas didn't pan; the region's own scrolling is the browser's.
 *
 * Note: the canvas right-click flow is known to flake on macOS/Windows CI.
 */
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

const FIXTURE_PROJECT = path.resolve(__dirname, 'fixtures/project-a');

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

async function stubDialogForPath(dirPath: string) {
  await electronApp.evaluate(
    async ({ dialog, BrowserWindow }, fixturePath) => {
      const win =
        BrowserWindow.getAllWindows().find(
          (w: any) => !w.webContents.getURL().startsWith('devtools://'),
        ) ?? BrowserWindow.getAllWindows()[0] ?? null;
      (BrowserWindow as any).getFocusedWindow = () => win;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] });
    },
    dirPath,
  );
}

/** The workspace's transform container style, which changes when the canvas pans. */
async function viewportTransform(): Promise<string> {
  return window.evaluate(() => {
    const ws = document.querySelector('[data-testid="canvas-workspace"]');
    return (ws?.firstElementChild as HTMLElement | null)?.style.transform ?? '';
  });
}

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp({ experimental: {} }));
  await stubDialogForPath(FIXTURE_PROJECT);
  await expect(window.locator('[data-testid="nav-add-project"]')).toBeVisible({ timeout: 5_000 });
  await window.locator('[data-testid="nav-add-project"]').click();
  await expect(window.locator(`text=${path.basename(FIXTURE_PROJECT)}`).first()).toBeVisible({ timeout: 10_000 });
  const canvasTab = window.locator('[data-testid="explorer-tab-plugin:canvas"]');
  await expect(canvasTab).toBeVisible({ timeout: 10_000 });
  await canvasTab.click();
  await expect(window.locator('[data-testid="canvas-panel"]')).toBeVisible({ timeout: 10_000 });
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('wheel over a scrolling region in an unselected card scrolls it and does not pan; the header pans', async () => {
  const workspace = window.locator('[data-testid="canvas-workspace"]');
  await expect(workspace).toBeVisible({ timeout: 5_000 });
  await workspace.click({ button: 'right', position: { x: 150, y: 150 }, force: true });
  await expect(window.locator('[data-testid="canvas-context-menu"]')).toBeVisible({ timeout: 8_000 });
  await window.locator('[data-testid="canvas-context-menu-agent"]').click();
  const card = workspace.locator('[data-testid^="canvas-view-cv_"]').first();
  await expect(card).toBeVisible({ timeout: 8_000 });

  // Deselect: click empty canvas away from the card.
  const wsBox = (await workspace.boundingBox())!;
  await workspace.click({ position: { x: wsBox.width - 20, y: wsBox.height - 20 }, force: true });

  await card.locator('[data-testid="canvas-view-content"]').evaluate((content) => {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-testid', 'e2e-scroller');
    Object.assign(scroller.style, { position: 'absolute', inset: '0', overflowY: 'auto', zIndex: '50', background: 'inherit' });
    const tall = document.createElement('div');
    tall.style.height = '3000px';
    tall.textContent = 'transcript';
    scroller.appendChild(tall);
    // Record that the wheel really landed in the scroller, not on something beside it.
    scroller.addEventListener('wheel', () => { scroller.dataset.wheels = String(Number(scroller.dataset.wheels ?? 0) + 1); });
    content.appendChild(scroller);
  });
  const scroller = card.locator('[data-testid="e2e-scroller"]');
  const box = (await scroller.boundingBox())!;

  const before = await viewportTransform();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.wheel(0, 300);
  await expect.poll(() => scroller.getAttribute('data-wheels')).toBe('1');
  // Give a batched pan a frame to land before checking it didn't.
  await window.waitForTimeout(200);
  expect(await viewportTransform()).toBe(before);

  // The header is card chrome: a wheel there pans the canvas.
  const titlebar = card.locator('[data-testid="canvas-view-titlebar"]');
  const tb = (await titlebar.boundingBox())!;
  await window.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await window.mouse.wheel(0, 300);
  await expect.poll(viewportTransform).not.toBe(before);
});
