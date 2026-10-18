/**
 * #2111: a wheel over a scrolling region inside a canvas card scrolls that
 * region without panning the canvas; the card header still pans.
 *
 * A live chat transcript needs a running agent, so the test puts a
 * scrolling region into an unselected agent card's content area (the same
 * shape as a transcript: overflow-y auto with more content than fits) and
 * dispatches wheel events on it and on the header. Layout and computed styles
 * are real, which the unit tests can't give.
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

  // Deselect: click empty canvas just right of the card, clear of the
  // canvas's own controls along the bottom.
  const wsBox = (await workspace.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  await workspace.click({ position: { x: Math.min(cardBox.x - wsBox.x + cardBox.width + 40, wsBox.width - 40), y: cardBox.y - wsBox.y + 20 }, force: true });
  await expect(card).not.toHaveAttribute('data-selected', 'true');

  await card.locator('[data-testid="canvas-view-content"]').evaluate((content) => {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-testid', 'e2e-scroller');
    Object.assign(scroller.style, { position: 'absolute', inset: '0', overflowY: 'auto', zIndex: '50', background: 'inherit' });
    const tall = document.createElement('div');
    tall.style.height = '3000px';
    tall.textContent = 'transcript';
    scroller.appendChild(tall);
    content.appendChild(scroller);
  });
  const scroller = card.locator('[data-testid="e2e-scroller"]');

  // A wheel event dispatched on the element itself: it bubbles through the
  // card to the canvas the same way a trackpad wheel does, without depending
  // on what CI's window happens to hit-test at a screen point.
  const wheel = (target: typeof scroller) => target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  });

  const before = await viewportTransform();
  await wheel(scroller);
  // Give a batched pan a frame to land before checking it didn't.
  await window.waitForTimeout(200);
  expect(await viewportTransform()).toBe(before);

  // The header is card chrome: a wheel there pans the canvas.
  await wheel(card.locator('[data-testid="canvas-view-titlebar"]'));
  await expect.poll(viewportTransform).not.toBe(before);
});
