import { test, type Page } from '@playwright/test';
import type { ElectronApp } from './launch';

interface FrameMonitor {
  frames: number;
  startedAt: number;
  lastFrameAt: number | null;
}

/** Observe frames without changing focus, throttling, or actionability. */
export async function installFrameMonitor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & { __clubhouseE2EFrames?: FrameMonitor };
    if (target.__clubhouseE2EFrames) return;
    const monitor: FrameMonitor = { frames: 0, startedAt: performance.now(), lastFrameAt: null };
    target.__clubhouseE2EFrames = monitor;
    const frame = () => {
      monitor.frames++;
      monitor.lastFrameAt = performance.now();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// Diagnostics must never hang behind the renderer being diagnosed or replace
// the original action failure. This deadline bounds collection, not UI waits.
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostic collection timed out')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Capture the missing evidence for click stalls in the launched renderer. */
export async function reportActionFailure(app: ElectronApp, page: Page, control: string, cause: unknown): Promise<void> {
  try {
    const results = await Promise.allSettled([
      bounded(page.evaluate(() => {
        const monitor = (window as Window & { __clubhouseE2EFrames?: FrameMonitor }).__clubhouseE2EFrames;
        const now = performance.now();
        return {
          url: location.href,
          readyState: document.readyState,
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          newChrome: (window as Window & { clubhouse?: { newChromeLayout?: boolean } }).clubhouse?.newChromeLayout,
          now,
          monitor,
          lastFrameAgeMs: monitor ? now - (monitor.lastFrameAt ?? monitor.startedAt) : null,
          controls: ['nav-add-project', 'onboarding-backdrop', 'onboarding-skip'].map((id) => {
            const el = document.querySelector(`[data-testid="${id}"]`);
            if (!el) return { id, present: false };
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              id, rect: rect.toJSON(), display: style.display, visibility: style.visibility,
              pointerEvents: style.pointerEvents,
              hitTarget: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 500),
            };
          }),
        };
      })),
      bounded(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
        id: win.id, url: win.webContents.getURL(), visible: win.isVisible(),
        minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds(),
        backgroundThrottling: win.webContents.getBackgroundThrottling(),
      })))),
      bounded(page.content()),
      page.screenshot({ timeout: 1_000 }),
    ]);
    const value = (index: number) => {
      const result = results[index];
      return result.status === 'fulfilled' ? result.value : { error: String(result.reason) };
    };
    const summary = JSON.stringify({
      control, cause: String(cause), renderer: value(0), windows: value(1),
      screenshot: results[3].status,
      screenshotError: results[3].status === 'rejected' ? String(results[3].reason) : undefined,
    }, null, 2);
    console.error(`[e2e action failure] ${summary}`);
    const info = test.info();
    await info.attach(`${control}-diagnostics`, { body: summary, contentType: 'application/json' });
    if (results[2].status === 'fulfilled') {
      await info.attach(`${control}-dom`, { body: results[2].value as string, contentType: 'text/html' });
    }
    if (results[3].status === 'fulfilled') {
      await info.attach(`${control}-screenshot`, { body: results[3].value as Buffer, contentType: 'image/png' });
    }
  } catch (error) {
    console.error(`[e2e action failure] ${control}: diagnostics unavailable: ${String(error)}; original failure: ${String(cause)}`);
  }
}
