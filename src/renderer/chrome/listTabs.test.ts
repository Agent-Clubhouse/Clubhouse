import { describe, it, expect } from 'vitest';
import { isListTab } from './listTabs';

describe('isListTab', () => {
  it('is true for project tabs with the sidebar-content layout (the default)', () => {
    expect(isListTab('plugin:files', undefined)).toBe(true);
    expect(isListTab('plugin:github-issues', 'sidebar-content')).toBe(true);
  });

  it('is false for full-layout tabs, Terminal, app views and core tabs', () => {
    expect(isListTab('plugin:canvas', 'full')).toBe(false);
    expect(isListTab('plugin:terminal', 'sidebar-content')).toBe(false);
    expect(isListTab('plugin:app:goobers', undefined)).toBe(false);
    expect(isListTab('agents', undefined)).toBe(false);
    expect(isListTab('settings', undefined)).toBe(false);
  });
});
