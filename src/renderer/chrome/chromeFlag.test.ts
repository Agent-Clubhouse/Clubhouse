import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('chromeFlag', () => {
  const original = (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = original;
  });

  it('defaults to the legacy shell when the launch flag is absent', async () => {
    (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = undefined;
    const { isNewChromeEnabled } = await import('./chromeFlag');
    expect(isNewChromeEnabled()).toBe(false);
  });

  it('reads the launch flag synchronously at module load', async () => {
    (window.clubhouse as { newChromeLayout?: boolean }).newChromeLayout = true;
    const { isNewChromeEnabled, useChromeFlagStore } = await import('./chromeFlag');
    expect(isNewChromeEnabled()).toBe(true);
    expect(useChromeFlagStore.getState().enabled).toBe(true);
  });

  it('ignores non-boolean values', async () => {
    (window.clubhouse as { newChromeLayout?: unknown }).newChromeLayout = 'yes';
    const { isNewChromeEnabled } = await import('./chromeFlag');
    expect(isNewChromeEnabled()).toBe(false);
  });
});
