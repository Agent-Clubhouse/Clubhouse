import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import type { ElectronApp } from '../e2e/launch';

const pw = vi.hoisted(() => {
  const toBeVisible = vi.fn().mockResolvedValue(undefined);
  return {
    toBeVisible,
    // expect(check).toPass() runs the check once; expect(locator).toBeVisible() passes.
    expect: vi.fn((value: unknown) => ({ toPass: () => (value as () => Promise<void>)(), toBeVisible })),
  };
});
vi.mock('@playwright/test', () => ({ expect: pw.expect }));
vi.mock('../e2e/renderer-diagnostics', () => ({ reportActionFailure: vi.fn() }));
vi.mock('../e2e/layout', () => ({ isNewLayout: vi.fn().mockResolvedValue(false) }));
import { clickExplorerTab } from '../e2e/smoke-helpers';
import { reportActionFailure } from '../e2e/renderer-diagnostics';
import { isNewLayout } from '../e2e/layout';

function pageWithRail(present: boolean) {
  const click = vi.fn().mockResolvedValue(undefined);
  const move = vi.fn().mockResolvedValue(undefined);
  return {
    locator: vi.fn(() => ({ count: vi.fn().mockResolvedValue(present ? 1 : 0) })),
    evaluate: vi.fn().mockResolvedValue({ x: 1399, y: 450 }),
    getByTestId: vi.fn(() => ({ click, isVisible: vi.fn().mockResolvedValue(true) })),
    mouse: { move },
    click,
  };
}

describe('explorer navigation behind the classic hover rail', () => {
  it('moves beyond the actual overlay panel before an ordinary pointer click', async () => {
    const page = pageWithRail(true);
    await clickExplorerTab({} as ElectronApp, page as unknown as Page, 'explorer-tab-plugin:canvas');
    expect(page.locator).toHaveBeenCalledWith('[data-testid="rail-container"]');
    expect(page.mouse.move).toHaveBeenCalledWith(1399, 450);
    expect(page.mouse.move.mock.invocationCallOrder[0]).toBeLessThan(page.click.mock.invocationCallOrder[0]);
    expect(page.getByTestId).toHaveBeenCalledWith('explorer-tab-plugin:canvas');
    expect(page.click).toHaveBeenCalledWith();
  });

  it('clicks normally when there is no classic rail', async () => {
    const page = pageWithRail(false);
    await clickExplorerTab({} as ElectronApp, page as unknown as Page, 'explorer-tab-plugin:files');
    expect(page.mouse.move).not.toHaveBeenCalled();
    expect(page.click).toHaveBeenCalledOnce();
  });

  it('captures evidence and preserves a failed tab click', async () => {
    const page = pageWithRail(false);
    const app = {} as ElectronApp;
    const cause = new Error('tab is still obstructed');
    page.click.mockRejectedValue(cause);
    await expect(clickExplorerTab(app, page as unknown as Page, 'explorer-tab-plugin:files')).rejects.toBe(cause);
    expect(reportActionFailure).toHaveBeenCalledWith(app, page, 'explorer-tab-plugin:files', cause);
  });

  it('on the new layout, clicks the title bar tab without moving off a rail', async () => {
    vi.mocked(isNewLayout).mockResolvedValueOnce(true);
    const page = pageWithRail(false);
    await clickExplorerTab({} as ElectronApp, page as unknown as Page, 'explorer-tab-plugin:files');
    expect(page.locator).not.toHaveBeenCalled();
    expect(page.mouse.move).not.toHaveBeenCalled();
    expect(page.click).toHaveBeenCalledWith({ timeout: 2_000 });
    expect(page.click).toHaveBeenCalledOnce();
  });
});
