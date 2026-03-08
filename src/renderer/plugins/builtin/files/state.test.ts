import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileState } from './state';
import type { PersistedTabState } from './state';

describe('fileState — tab management', () => {
  beforeEach(() => {
    fileState.reset();
  });

  // ── openTab ──────────────────────────────────────────────────────

  describe('openTab', () => {
    it('opens a new tab and makes it active', () => {
      const tab = fileState.openTab('src/index.ts');
      expect(tab.filePath).toBe('src/index.ts');
      expect(tab.isDirty).toBe(false);
      expect(tab.isPinned).toBe(false);
      expect(tab.isPreview).toBe(false);
      expect(fileState.activeTabId).toBe(tab.id);
      expect(fileState.selectedPath).toBe('src/index.ts');
      expect(fileState.openTabs).toHaveLength(1);
    });

    it('opens a preview tab', () => {
      const tab = fileState.openTab('README.md', { preview: true });
      expect(tab.isPreview).toBe(true);
    });

    it('activates existing tab if same file is opened', () => {
      const tab1 = fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');
      const tab3 = fileState.openTab('src/a.ts');
      expect(tab3.id).toBe(tab1.id);
      expect(fileState.activeTabId).toBe(tab1.id);
      expect(fileState.openTabs).toHaveLength(2);
    });

    it('replaces preview tab when opening another file in preview mode', () => {
      const preview1 = fileState.openTab('src/a.ts', { preview: true });
      const preview2 = fileState.openTab('src/b.ts', { preview: true });
      expect(preview2.id).toBe(preview1.id); // Same tab reused
      expect(preview2.filePath).toBe('src/b.ts');
      expect(fileState.openTabs).toHaveLength(1);
    });

    it('does not replace preview tab when opening permanently', () => {
      fileState.openTab('src/a.ts', { preview: true });
      fileState.openTab('src/b.ts', { preview: false });
      expect(fileState.openTabs).toHaveLength(2);
    });

    it('promotes preview tab to permanent when opening same file non-preview', () => {
      const preview = fileState.openTab('src/a.ts', { preview: true });
      expect(preview.isPreview).toBe(true);
      const promoted = fileState.openTab('src/a.ts', { preview: false });
      expect(promoted.id).toBe(preview.id);
      expect(promoted.isPreview).toBe(false);
    });
  });

  // ── closeTab ─────────────────────────────────────────────────────

  describe('closeTab', () => {
    it('closes a tab', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.closeTab(tab.id);
      expect(fileState.openTabs).toHaveLength(0);
      expect(fileState.activeTabId).toBeNull();
    });

    it('activates adjacent tab when closing active tab', () => {
      fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      fileState.openTab('src/c.ts');
      // Active is c.ts; close it
      fileState.closeTab(fileState.activeTabId!);
      // Should activate b.ts (adjacent)
      expect(fileState.activeTabId).toBe(tab2.id);
    });

    it('adds closed file to recentlyClosed', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.closeTab(tab.id);
      expect(fileState.recentlyClosed).toContain('src/a.ts');
    });

    it('returns true on successful close', () => {
      const tab = fileState.openTab('src/a.ts');
      expect(fileState.closeTab(tab.id)).toBe(true);
    });

    it('returns false for unknown tab', () => {
      expect(fileState.closeTab('nonexistent')).toBe(false);
    });

    it('caps recentlyClosed at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        const tab = fileState.openTab(`file${i}.ts`);
        fileState.closeTab(tab.id);
      }
      expect(fileState.recentlyClosed.length).toBeLessThanOrEqual(20);
    });
  });

  // ── closeOtherTabs ───────────────────────────────────────────────

  describe('closeOtherTabs', () => {
    it('closes all tabs except the specified one', () => {
      fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      fileState.openTab('src/c.ts');
      fileState.closeOtherTabs(tab2.id);
      expect(fileState.openTabs).toHaveLength(1);
      expect(fileState.openTabs[0].id).toBe(tab2.id);
      expect(fileState.activeTabId).toBe(tab2.id);
    });
  });

  // ── closeTabsToRight ─────────────────────────────────────────────

  describe('closeTabsToRight', () => {
    it('closes tabs to the right of the specified tab', () => {
      const tab1 = fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      fileState.openTab('src/c.ts');
      fileState.closeTabsToRight(tab2.id);
      expect(fileState.openTabs).toHaveLength(2);
      expect(fileState.openTabs.map(t => t.id)).toContain(tab1.id);
      expect(fileState.openTabs.map(t => t.id)).toContain(tab2.id);
    });

    it('switches active to kept tab if active was closed', () => {
      const tab1 = fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');
      const tab3 = fileState.openTab('src/c.ts');
      fileState.activateTab(tab3.id);
      fileState.closeTabsToRight(tab1.id);
      expect(fileState.activeTabId).toBe(tab1.id);
    });
  });

  // ── closeAllTabs ─────────────────────────────────────────────────

  describe('closeAllTabs', () => {
    it('closes all tabs', () => {
      fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');
      fileState.closeAllTabs();
      expect(fileState.openTabs).toHaveLength(0);
      expect(fileState.activeTabId).toBeNull();
      expect(fileState.selectedPath).toBeNull();
    });
  });

  // ── activateTab ──────────────────────────────────────────────────

  describe('activateTab', () => {
    it('sets the active tab', () => {
      const tab1 = fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');
      fileState.activateTab(tab1.id);
      expect(fileState.activeTabId).toBe(tab1.id);
      expect(fileState.selectedPath).toBe('src/a.ts');
    });

    it('does nothing for unknown tab', () => {
      fileState.openTab('src/a.ts');
      const activeId = fileState.activeTabId;
      fileState.activateTab('nonexistent');
      expect(fileState.activeTabId).toBe(activeId);
    });
  });

  // ── reopenLastClosed ─────────────────────────────────────────────

  describe('reopenLastClosed', () => {
    it('reopens the last closed file', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.closeTab(tab.id);
      const path = fileState.reopenLastClosed();
      expect(path).toBe('src/a.ts');
      expect(fileState.openTabs).toHaveLength(1);
      expect(fileState.openTabs[0].filePath).toBe('src/a.ts');
    });

    it('returns null when no tabs to reopen', () => {
      expect(fileState.reopenLastClosed()).toBeNull();
    });

    it('activates existing tab if the file is already open', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');
      // Close b, then push a.ts onto recentlyClosed
      fileState.closeTab(fileState.getTabByPath('src/b.ts')!.id);
      fileState.recentlyClosed.push('src/a.ts');
      fileState.reopenLastClosed();
      expect(fileState.activeTabId).toBe(tab.id);
      expect(fileState.openTabs).toHaveLength(1); // No duplicate
    });
  });

  // ── Dirty state ──────────────────────────────────────────────────

  describe('dirty state', () => {
    it('tracks per-tab dirty state', () => {
      const tab1 = fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      fileState.setTabDirty(tab1.id, true);
      expect(fileState.getTab(tab1.id)!.isDirty).toBe(true);
      expect(fileState.getTab(tab2.id)!.isDirty).toBe(false);
      expect(fileState.hasDirtyTabs()).toBe(true);
    });

    it('promotes preview tab when dirty', () => {
      const tab = fileState.openTab('src/a.ts', { preview: true });
      expect(tab.isPreview).toBe(true);
      fileState.setTabDirty(tab.id, true);
      expect(fileState.getTab(tab.id)!.isPreview).toBe(false);
    });

    it('aggregates dirty state', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.setTabDirty(tab.id, true);
      expect(fileState.isDirty).toBe(true);
      fileState.setTabDirty(tab.id, false);
      expect(fileState.isDirty).toBe(false);
    });
  });

  // ── Scroll state ─────────────────────────────────────────────────

  describe('scroll state', () => {
    it('stores scroll state per tab', () => {
      const tab = fileState.openTab('src/a.ts');
      const scroll = { scrollTop: 100, scrollLeft: 0, cursorLine: 10, cursorColumn: 5 };
      fileState.setTabScrollState(tab.id, scroll);
      expect(fileState.getTab(tab.id)!.scrollState).toEqual(scroll);
    });
  });

  // ── Pin/Unpin ────────────────────────────────────────────────────

  describe('pin tabs', () => {
    it('pins a tab', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.pinTab(tab.id);
      expect(fileState.getTab(tab.id)!.isPinned).toBe(true);
    });

    it('promotes preview to permanent when pinned', () => {
      const tab = fileState.openTab('src/a.ts', { preview: true });
      fileState.pinTab(tab.id);
      expect(fileState.getTab(tab.id)!.isPinned).toBe(true);
      expect(fileState.getTab(tab.id)!.isPreview).toBe(false);
    });

    it('moves pinned tabs to front of tabOrder', () => {
      fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');
      const tab3 = fileState.openTab('src/c.ts');
      fileState.pinTab(tab3.id);
      const ordered = fileState.getOrderedTabs();
      expect(ordered[0].id).toBe(tab3.id);
    });

    it('unpins a tab', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.pinTab(tab.id);
      fileState.unpinTab(tab.id);
      expect(fileState.getTab(tab.id)!.isPinned).toBe(false);
    });
  });

  // ── Reorder ──────────────────────────────────────────────────────

  describe('reorderTab', () => {
    it('reorders a tab', () => {
      const tab1 = fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      const tab3 = fileState.openTab('src/c.ts');
      fileState.reorderTab(tab3.id, 0);
      const ordered = fileState.getOrderedTabs();
      expect(ordered[0].id).toBe(tab3.id);
      expect(ordered[1].id).toBe(tab1.id);
      expect(ordered[2].id).toBe(tab2.id);
    });

    it('does not reorder unpinned tab before pinned tabs', () => {
      const tab1 = fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      fileState.pinTab(tab1.id);
      fileState.reorderTab(tab2.id, 0);
      const ordered = fileState.getOrderedTabs();
      expect(ordered[0].id).toBe(tab1.id); // Pinned stays first
    });
  });

  // ── getOrderedTabs ───────────────────────────────────────────────

  describe('getOrderedTabs', () => {
    it('returns tabs in display order', () => {
      const tab1 = fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts');
      const tab3 = fileState.openTab('src/c.ts');
      const ordered = fileState.getOrderedTabs();
      expect(ordered.map(t => t.id)).toEqual([tab1.id, tab2.id, tab3.id]);
    });
  });

  // ── Preview tab ──────────────────────────────────────────────────

  describe('preview mode', () => {
    it('getPreviewTab returns the preview tab', () => {
      fileState.openTab('src/a.ts', { preview: true });
      const preview = fileState.getPreviewTab();
      expect(preview).toBeDefined();
      expect(preview!.isPreview).toBe(true);
    });

    it('promotePreview makes a preview tab permanent', () => {
      const tab = fileState.openTab('src/a.ts', { preview: true });
      fileState.promotePreview(tab.id);
      expect(fileState.getTab(tab.id)!.isPreview).toBe(false);
    });
  });

  // ── Persistence ──────────────────────────────────────────────────

  describe('serialize / restore', () => {
    it('serializes tab state', () => {
      const tab1 = fileState.openTab('src/a.ts');
      const tab2 = fileState.openTab('src/b.ts', { preview: true });
      fileState.pinTab(tab1.id);

      const data = fileState.serialize();
      expect(data.tabs).toHaveLength(2);
      expect(data.activeTabId).toBe(tab2.id);
      expect(data.tabs[0].isPinned).toBe(true); // Pinned first
      expect(data.tabs[1].isPreview).toBe(true);
    });

    it('restores tab state', () => {
      const data: PersistedTabState = {
        tabs: [
          { id: 'tab-100-123', filePath: 'src/a.ts', isPinned: true, isPreview: false },
          { id: 'tab-101-124', filePath: 'src/b.ts', isPinned: false, isPreview: true },
        ],
        activeTabId: 'tab-100-123',
      };

      fileState.restore(data);
      expect(fileState.openTabs).toHaveLength(2);
      expect(fileState.activeTabId).toBe('tab-100-123');
      expect(fileState.getTab('tab-100-123')!.isPinned).toBe(true);
      expect(fileState.getTab('tab-101-124')!.isPreview).toBe(true);
      expect(fileState.selectedPath).toBe('src/a.ts');
    });

    it('round-trips serialize/restore', () => {
      const tab1 = fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts', { preview: true });
      fileState.pinTab(tab1.id);

      const serialized = fileState.serialize();
      fileState.reset();
      fileState.restore(serialized);

      expect(fileState.openTabs).toHaveLength(2);
      expect(fileState.getTab(tab1.id)!.isPinned).toBe(true);
    });
  });

  // ── Subscribe / notify ───────────────────────────────────────────

  describe('subscribe', () => {
    it('notifies listeners on state changes', () => {
      const listener = vi.fn();
      fileState.subscribe(listener);
      fileState.openTab('src/a.ts');
      expect(listener).toHaveBeenCalled();
    });

    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = fileState.subscribe(listener);
      unsub();
      fileState.openTab('src/a.ts');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Legacy compat ────────────────────────────────────────────────

  describe('legacy setSelectedPath', () => {
    it('opens a preview tab when called with a path', () => {
      fileState.setSelectedPath('src/a.ts');
      expect(fileState.openTabs).toHaveLength(1);
      expect(fileState.openTabs[0].isPreview).toBe(true);
      expect(fileState.selectedPath).toBe('src/a.ts');
    });

    it('clears selection when called with null', () => {
      fileState.openTab('src/a.ts');
      fileState.setSelectedPath(null);
      expect(fileState.selectedPath).toBeNull();
    });
  });

  describe('legacy setDirty', () => {
    it('sets dirty on active tab', () => {
      const tab = fileState.openTab('src/a.ts');
      fileState.setDirty(true);
      expect(fileState.getTab(tab.id)!.isDirty).toBe(true);
    });
  });

  // ── triggerRefresh ───────────────────────────────────────────────

  describe('triggerRefresh', () => {
    it('increments refreshCount', () => {
      fileState.triggerRefresh();
      expect(fileState.refreshCount).toBe(1);
      fileState.triggerRefresh();
      expect(fileState.refreshCount).toBe(2);
    });

    it('notifies listeners', () => {
      const listener = vi.fn();
      fileState.subscribe(listener);
      fileState.triggerRefresh();
      expect(listener).toHaveBeenCalled();
    });
  });

  // ── Reset ────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state and listeners', () => {
      const listener = vi.fn();
      fileState.subscribe(listener);
      fileState.openTab('src/a.ts');
      fileState.openTab('src/b.ts');

      fileState.reset();

      expect(fileState.openTabs).toHaveLength(0);
      expect(fileState.tabOrder).toHaveLength(0);
      expect(fileState.activeTabId).toBeNull();
      expect(fileState.recentlyClosed).toHaveLength(0);
      expect(fileState.selectedPath).toBeNull();
      expect(fileState.isDirty).toBe(false);
      expect(fileState.refreshCount).toBe(0);

      // Listeners should be cleared
      listener.mockClear();
      fileState.triggerRefresh();
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
