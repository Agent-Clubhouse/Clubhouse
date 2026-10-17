import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isListTab, useSidebarMode } from './listTabs';
import { useUIStore } from '../stores/uiStore';

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

describe('useSidebarMode', () => {
  it('swaps the sidebar for Settings and Help, and keeps the tree for Agents', () => {
    useUIStore.setState({ explorerTab: 'settings' });
    expect(renderHook(() => useSidebarMode()).result.current).toBe('settings');
    useUIStore.setState({ explorerTab: 'help' });
    expect(renderHook(() => useSidebarMode()).result.current).toBe('help');
    useUIStore.setState({ explorerTab: 'agents' });
    expect(renderHook(() => useSidebarMode()).result.current).toBe('tree');
  });
});
