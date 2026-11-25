import { describe, it, expect, beforeEach } from 'vitest';
import { removeHomeViewData, SHORTCUT_OVERRIDES_KEY, VIEW_PREFS_KEY } from './removed-home-data';

describe('removeHomeViewData', () => {
  beforeEach(() => localStorage.clear());

  it('removes the Home display preference and the Go to Home binding, keeping other bindings', () => {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify({ showHome: true }));
    localStorage.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify({ 'go-home': 'Meta+H', 'command-palette': 'Meta+P' }));

    expect(removeHomeViewData()).toEqual([VIEW_PREFS_KEY, SHORTCUT_OVERRIDES_KEY]);
    expect(localStorage.getItem(VIEW_PREFS_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SHORTCUT_OVERRIDES_KEY)!)).toEqual({ 'command-palette': 'Meta+P' });
  });

  it('writes nothing when there is nothing to remove', () => {
    localStorage.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify({ 'command-palette': 'Meta+P' }));
    expect(removeHomeViewData()).toEqual([]);
    expect(localStorage.getItem(SHORTCUT_OVERRIDES_KEY)).toBe(JSON.stringify({ 'command-palette': 'Meta+P' }));
  });

  it('leaves a corrupt overrides value alone', () => {
    localStorage.setItem(SHORTCUT_OVERRIDES_KEY, '{not json');
    expect(removeHomeViewData()).toEqual([]);
    expect(localStorage.getItem(SHORTCUT_OVERRIDES_KEY)).toBe('{not json');
  });
});
