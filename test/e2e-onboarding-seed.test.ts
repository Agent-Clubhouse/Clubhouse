// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({ _electron: { launch: vi.fn() }, test: { info: vi.fn() } }));
import { seedClassicOnboarding } from '../e2e/launch';

afterEach(() => {
  localStorage.clear();
  delete (window as Window & { __clubhouseE2EOnboardingSeeded?: boolean }).__clubhouseE2EOnboardingSeeded;
});

describe('onboarding seed before app scripts', () => {
  it('makes the actual classic store read completion on its first module load', async () => {
    vi.resetModules();
    Object.defineProperty(window, 'clubhouse', { configurable: true, value: { newChromeLayout: false } });
    seedClassicOnboarding();
    const { useOnboardingStore } = await import('../src/renderer/stores/onboardingStore');
    expect(useOnboardingStore.getState().completed).toBe(true);
    expect(useOnboardingStore.getState().showOnboarding).toBe(false);
    expect((window as Window & { __clubhouseE2EOnboardingSeeded?: boolean }).__clubhouseE2EOnboardingSeeded).toBe(true);
  });

  it('does not alter default-layout onboarding or claim a seed before preload is available', () => {
    for (const value of [{ newChromeLayout: true }, undefined]) {
      Object.defineProperty(window, 'clubhouse', { configurable: true, value });
      seedClassicOnboarding();
      expect(localStorage.getItem('clubhouse_onboarding')).toBeNull();
      expect((window as Window & { __clubhouseE2EOnboardingSeeded?: boolean }).__clubhouseE2EOnboardingSeeded).toBeUndefined();
    }
  });
});
