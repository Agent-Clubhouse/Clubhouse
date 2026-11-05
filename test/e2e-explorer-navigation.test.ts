import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import type { ElectronApp } from '../e2e/launch';

vi.mock('@playwright/test', () => ({ expect: vi.fn() }));
vi.mock('../e2e/renderer-diagnostics', () => ({ reportActionFailure: vi.fn() }));
import { clickExplorerTab } from '../e2e/smoke-helpers';
import { reportActionFailure } from '../e2e/renderer-diagnostics';

function pageWithRail(present: boolean) {
  const click = vi.fn().mockResolvedValue(undefined);
  const move = vi.fn().mockResolvedValue(undefined);
  return {
    locator: vi.fn(() => ({ count: vi.fn().mockResolvedValue(present ? 1 : 0) })),
    evaluate: vi.fn().mockResolvedValue({ x: 1399, y: 450 }),
    getByTestId: vi.fn(() => ({ click })),
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
});
