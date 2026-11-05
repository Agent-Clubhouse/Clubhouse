// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import type { ElectronApp } from '../e2e/launch';

const { attach } = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock('@playwright/test', () => ({ test: { info: () => ({ attach }) } }));

import { installFrameMonitor, reportActionFailure } from '../e2e/renderer-diagnostics';

afterEach(() => {
  delete (window as Window & { __clubhouseE2EFrames?: unknown }).__clubhouseE2EFrames;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('renderer stall diagnostics', () => {
  it('records how long frames have stopped, without driving frames or focus', async () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const page = { evaluate: async (fn: () => unknown) => fn() } as unknown as Page;
    vi.spyOn(performance, 'now').mockReturnValue(10);
    await installFrameMonitor(page);
    await installFrameMonitor(page);
    expect(raf).toHaveBeenCalledOnce();

    vi.mocked(performance.now).mockReturnValue(20);
    raf.mock.calls[0][0]();
    const app = { evaluate: vi.fn().mockResolvedValue([{ visible: false, minimized: true }]) } as unknown as ElectronApp;
    Object.assign(page, { content: vi.fn().mockResolvedValue('<html></html>'), screenshot: vi.fn().mockRejectedValue(new Error('no paint')) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(performance.now).mockReturnValue(30_020);
    await reportActionFailure(app, page, 'nav-add-project', new Error('stable check stalled'));
    const summary = JSON.parse(attach.mock.calls[0][1].body);
    expect(summary.renderer.monitor.frames).toBe(1);
    expect(summary.renderer.lastFrameAgeMs).toBe(30_000);
    expect(summary.windows).toEqual([{ visible: false, minimized: true }]);
    expect(summary.cause).toContain('stable check stalled');
    expect(summary.screenshot).toBe('rejected');
    expect(attach).toHaveBeenCalledWith('nav-add-project-dom', { body: '<html></html>', contentType: 'text/html' });
  });

  it('bounds collection from an unresponsive renderer and preserves the original failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const never = new Promise<never>(() => {});
    const page = { evaluate: () => never, content: () => never, screenshot: vi.fn().mockRejectedValue(new Error('screenshot timeout')) } as unknown as Page;
    const app = { evaluate: () => never } as unknown as ElectronApp;
    const reporting = reportActionFailure(app, page, 'onboarding-skip', new Error('original stability failure'));
    await vi.advanceTimersByTimeAsync(1_000);
    await reporting;
    const summary = JSON.parse(attach.mock.calls[0][1].body);
    expect(summary.renderer.error).toContain('diagnostic collection timed out');
    expect(summary.windows.error).toContain('diagnostic collection timed out');
    expect(summary.cause).toContain('original stability failure');
  });
});
