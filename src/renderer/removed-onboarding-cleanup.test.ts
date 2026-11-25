import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./plugins/renderer-logger', () => ({ rendererLog: vi.fn() }));

import { rendererLog } from './plugins/renderer-logger';
import { cleanupRemovedOnboardingState, REMOVED_ONBOARDING_STORAGE_KEY } from './removed-onboarding-cleanup';

function snapshot(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    out[key] = localStorage.getItem(key);
  }
  return out;
}

describe('cleanupRemovedOnboardingState', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(rendererLog).mockClear();
  });

  it('deletes the saved onboarding state and touches no other key', () => {
    localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: 'experienced-dev' }));
    // Neighbours, including look-alikes, that must stay.
    localStorage.setItem('clubhouse_onboarding_v2', 'keep');
    localStorage.setItem('clubhouse_chrome_v2', '{"x":1}');
    localStorage.setItem('clubhouse_whats_new_seen', '1.0.0');
    localStorage.setItem('onboarding', 'keep');
    const before = snapshot();

    expect(cleanupRemovedOnboardingState()).toBe(true);

    const { [REMOVED_ONBOARDING_STORAGE_KEY]: removed, ...rest } = before;
    expect(removed).not.toBeNull();
    expect(snapshot()).toEqual(rest);
    expect(rendererLog).toHaveBeenCalledWith('core:startup', 'info', expect.any(String), expect.anything());
  });

  it('is idempotent: a second run (or a fresh install) does nothing and logs nothing', () => {
    localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: false, cohort: null }));
    expect(cleanupRemovedOnboardingState()).toBe(true);
    vi.mocked(rendererLog).mockClear();

    localStorage.setItem('clubhouse_chrome_v2', '{}');
    expect(cleanupRemovedOnboardingState()).toBe(false);
    expect(snapshot()).toEqual({ clubhouse_chrome_v2: '{}' });
    expect(rendererLog).not.toHaveBeenCalled();
  });

  it('never throws when storage fails', () => {
    const storage = {
      getItem: vi.fn(() => '{}'),
      removeItem: vi.fn(() => { throw new Error('SecurityError'); }),
    };
    expect(() => cleanupRemovedOnboardingState(storage)).not.toThrow();
    expect(cleanupRemovedOnboardingState(storage)).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith('clubhouse_onboarding');
    expect(rendererLog).toHaveBeenCalledWith('core:startup', 'warn', expect.any(String), expect.anything());
  });

  it('never throws even when logging itself fails', () => {
    vi.mocked(rendererLog).mockImplementation(() => { throw new Error('logger down'); });
    const storage = {
      getItem: vi.fn(() => '{}'),
      removeItem: vi.fn(() => { throw new Error('SecurityError'); }),
    };
    expect(() => cleanupRemovedOnboardingState(storage)).not.toThrow();
    localStorage.setItem('clubhouse_onboarding', '{}');
    expect(cleanupRemovedOnboardingState()).toBe(true);
    expect(localStorage.getItem('clubhouse_onboarding')).toBeNull();
  });
});
