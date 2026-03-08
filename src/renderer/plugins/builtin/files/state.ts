/**
 * Tab-aware state for the files plugin.
 *
 * Both SidebarPanel (FileTree) and MainPanel (FileViewer) are rendered in
 * separate React trees, so we use a lightweight pub/sub to coordinate
 * tab state, dirty state, and refresh signals.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ScrollState {
  scrollTop: number;
  scrollLeft: number;
  cursorLine: number;
  cursorColumn: number;
}

export interface Tab {
  id: string;
  filePath: string;          // Relative path
  isDirty: boolean;
  scrollState: ScrollState | null;
  isPinned: boolean;
  isPreview: boolean;        // Italic title, replaced on next single-click
}

// ── Helpers ──────────────────────────────────────────────────────────

let nextId = 1;
export function generateTabId(): string {
  return `tab-${nextId++}-${Date.now()}`;
}

// ── Serialization types (for persistence) ────────────────────────────

export interface PersistedTabState {
  tabs: Array<{
    id: string;
    filePath: string;
    isPinned: boolean;
    isPreview: boolean;
  }>;
  activeTabId: string | null;
}

// ── File State (singleton) ───────────────────────────────────────────

export const fileState = {
  // Tab state
  openTabs: [] as Tab[],
  activeTabId: null as string | null,
  recentlyClosed: [] as string[],     // Stack of file paths for reopen
  tabOrder: [] as string[],           // Tab IDs in display order (for drag-reorder)

  // Legacy compat — still used for FileTree highlighting
  selectedPath: null as string | null,

  // Signals
  isDirty: false,                     // Aggregate: any tab dirty?
  refreshCount: 0,
  searchMode: false,
  /** When set, FileViewer should navigate to this line and highlight it */
  scrollToLine: null as number | null,
  listeners: new Set<() => void>(),

  // ── Tab queries ──────────────────────────────────────────────────

  getTab(tabId: string): Tab | undefined {
    return this.openTabs.find((t: Tab) => t.id === tabId);
  },

  getActiveTab(): Tab | undefined {
    return this.activeTabId ? this.getTab(this.activeTabId) : undefined;
  },

  getTabByPath(filePath: string): Tab | undefined {
    return this.openTabs.find((t: Tab) => t.filePath === filePath);
  },

  getPreviewTab(): Tab | undefined {
    return this.openTabs.find((t: Tab) => t.isPreview);
  },

  getOrderedTabs(): Tab[] {
    // Return tabs in tabOrder sequence
    const map = new Map<string, Tab>(this.openTabs.map((t: Tab) => [t.id, t] as [string, Tab]));
    const ordered: Tab[] = [];
    for (const id of this.tabOrder) {
      const tab = map.get(id);
      if (tab) ordered.push(tab);
    }
    // Append any tabs not in tabOrder (shouldn't happen, but safety)
    for (const tab of this.openTabs) {
      if (!this.tabOrder.includes(tab.id)) {
        ordered.push(tab);
      }
    }
    return ordered;
  },

  hasDirtyTabs(): boolean {
    return this.openTabs.some((t: Tab) => t.isDirty);
  },

  // ── Tab mutations ────────────────────────────────────────────────

  /**
   * Open a file in a tab.
   * - If already open, activate it.
   * - If preview=true and a preview tab exists, replace it.
   * - Otherwise, add a new tab.
   * Returns the tab that was opened/activated.
   */
  openTab(filePath: string, options?: { preview?: boolean }): Tab {
    const preview = options?.preview ?? false;

    // Already open? Activate it.
    const existing = this.getTabByPath(filePath);
    if (existing) {
      // If it was a preview tab and we're opening permanently, pin it
      if (existing.isPreview && !preview) {
        existing.isPreview = false;
      }
      this.activeTabId = existing.id;
      this.selectedPath = filePath;
      this.notify();
      return existing;
    }

    // Preview mode: replace existing preview tab
    if (preview) {
      const existingPreview = this.getPreviewTab();
      if (existingPreview) {
        // Replace the preview tab in-place
        existingPreview.filePath = filePath;
        existingPreview.isDirty = false;
        existingPreview.scrollState = null;
        existingPreview.isPreview = true;
        existingPreview.isPinned = false;
        this.activeTabId = existingPreview.id;
        this.selectedPath = filePath;
        this.notify();
        return existingPreview;
      }
    }

    // New tab
    const tab: Tab = {
      id: generateTabId(),
      filePath,
      isDirty: false,
      scrollState: null,
      isPinned: false,
      isPreview: preview,
    };

    this.openTabs.push(tab);
    this.tabOrder.push(tab.id);
    this.activeTabId = tab.id;
    this.selectedPath = filePath;
    this.notify();
    return tab;
  },

  /**
   * Close a tab by ID. Returns true if closed, false if cancelled (dirty).
   * Caller should handle dirty confirmation before calling this.
   */
  closeTab(tabId: string): boolean {
    const idx = this.openTabs.findIndex((t: Tab) => t.id === tabId);
    if (idx === -1) return false;

    const tab = this.openTabs[idx];

    // Track for reopen
    if (this.recentlyClosed.length >= 20) {
      this.recentlyClosed.shift();
    }
    this.recentlyClosed.push(tab.filePath);

    // Remove from arrays
    this.openTabs.splice(idx, 1);
    this.tabOrder = this.tabOrder.filter((id: string) => id !== tabId);

    // If we closed the active tab, activate an adjacent one
    if (this.activeTabId === tabId) {
      if (this.openTabs.length > 0) {
        // Prefer the tab at the same index, or the one before
        const newIdx = Math.min(idx, this.openTabs.length - 1);
        // Use tabOrder to find the neighbor
        const orderedTabs = this.getOrderedTabs();
        const orderIdx = Math.min(idx, orderedTabs.length - 1);
        this.activeTabId = orderedTabs[orderIdx]?.id ?? this.openTabs[newIdx].id;
        this.selectedPath = this.getActiveTab()?.filePath ?? null;
      } else {
        this.activeTabId = null;
        this.selectedPath = null;
      }
    }

    this.isDirty = this.hasDirtyTabs();
    this.notify();
    return true;
  },

  closeOtherTabs(tabId: string): void {
    const keep = this.getTab(tabId);
    if (!keep) return;

    // Track closed tabs for reopen
    for (const tab of this.openTabs) {
      if (tab.id !== tabId && !tab.isDirty) {
        this.recentlyClosed.push(tab.filePath);
      }
    }
    if (this.recentlyClosed.length > 20) {
      this.recentlyClosed = this.recentlyClosed.slice(-20);
    }

    this.openTabs = [keep];
    this.tabOrder = [keep.id];
    this.activeTabId = keep.id;
    this.selectedPath = keep.filePath;
    this.isDirty = keep.isDirty;
    this.notify();
  },

  closeTabsToRight(tabId: string): void {
    const orderedTabs = this.getOrderedTabs();
    const idx = orderedTabs.findIndex((t: Tab) => t.id === tabId);
    if (idx === -1) return;

    const toClose = orderedTabs.slice(idx + 1);
    for (const tab of toClose) {
      if (!tab.isDirty) {
        this.recentlyClosed.push(tab.filePath);
      }
    }
    if (this.recentlyClosed.length > 20) {
      this.recentlyClosed = this.recentlyClosed.slice(-20);
    }

    const keepIds = new Set(orderedTabs.slice(0, idx + 1).map((t: Tab) => t.id));
    this.openTabs = this.openTabs.filter((t: Tab) => keepIds.has(t.id));
    this.tabOrder = this.tabOrder.filter((id: string) => keepIds.has(id));

    // If active tab was closed, switch to the kept tab
    if (this.activeTabId && !keepIds.has(this.activeTabId)) {
      this.activeTabId = tabId;
      this.selectedPath = this.getTab(tabId)?.filePath ?? null;
    }

    this.isDirty = this.hasDirtyTabs();
    this.notify();
  },

  closeAllTabs(): void {
    for (const tab of this.openTabs) {
      if (!tab.isDirty) {
        this.recentlyClosed.push(tab.filePath);
      }
    }
    if (this.recentlyClosed.length > 20) {
      this.recentlyClosed = this.recentlyClosed.slice(-20);
    }

    this.openTabs = [];
    this.tabOrder = [];
    this.activeTabId = null;
    this.selectedPath = null;
    this.isDirty = false;
    this.notify();
  },

  activateTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    this.activeTabId = tabId;
    this.selectedPath = tab.filePath;
    this.notify();
  },

  /** Reopen the most recently closed tab */
  reopenLastClosed(): string | null {
    const path = this.recentlyClosed.pop();
    if (!path) return null;

    // Don't reopen if already open
    if (this.getTabByPath(path)) {
      this.openTab(path);
      return path;
    }

    this.openTab(path, { preview: false });
    this.notify();
    return path;
  },

  // ── Tab property updates ─────────────────────────────────────────

  setTabDirty(tabId: string, dirty: boolean): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.isDirty = dirty;
    // Editing a preview tab promotes it to permanent
    if (dirty && tab.isPreview) {
      tab.isPreview = false;
    }
    this.isDirty = this.hasDirtyTabs();
    this.notify();
  },

  setTabScrollState(tabId: string, scrollState: ScrollState): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.scrollState = scrollState;
    // Don't notify for scroll updates — too frequent
  },

  pinTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.isPinned = true;
    tab.isPreview = false;

    // Move pinned tabs to the front of tabOrder
    this.tabOrder = this.tabOrder.filter((id: string) => id !== tabId);
    const lastPinnedIdx = this.tabOrder.findIndex((id: string) => {
      const t = this.getTab(id);
      return t && !t.isPinned;
    });
    if (lastPinnedIdx === -1) {
      this.tabOrder.push(tabId);
    } else {
      this.tabOrder.splice(lastPinnedIdx, 0, tabId);
    }

    this.notify();
  },

  unpinTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.isPinned = false;
    this.notify();
  },

  promotePreview(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.isPreview = false;
    this.notify();
  },

  // ── Drag reorder ─────────────────────────────────────────────────

  reorderTab(tabId: string, newIndex: number): void {
    const oldIndex = this.tabOrder.indexOf(tabId);
    if (oldIndex === -1) return;

    // Don't allow reordering past pinned tabs boundary
    const tab = this.getTab(tabId);
    if (!tab) return;

    const orderedTabs = this.getOrderedTabs();
    const firstUnpinnedIdx = orderedTabs.findIndex((t: Tab) => !t.isPinned);
    const lastPinnedIdx = firstUnpinnedIdx > 0 ? firstUnpinnedIdx - 1 : -1;

    if (tab.isPinned && newIndex > lastPinnedIdx + 1) {
      newIndex = lastPinnedIdx + 1;
    } else if (!tab.isPinned && lastPinnedIdx >= 0 && newIndex <= lastPinnedIdx) {
      newIndex = lastPinnedIdx + 1;
    }

    // Remove from old position and insert at new
    this.tabOrder.splice(oldIndex, 1);
    this.tabOrder.splice(newIndex, 0, tabId);
    this.notify();
  },

  // ── Legacy / compat ──────────────────────────────────────────────

  setSelectedPath(path: string | null): void {
    if (path) {
      this.openTab(path, { preview: true });
    } else {
      this.selectedPath = null;
      this.notify();
    }
  },

  setDirty(dirty: boolean): void {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      this.setTabDirty(activeTab.id, dirty);
    } else {
      this.isDirty = dirty;
      this.notify();
    }
  },

  // ── Signals ──────────────────────────────────────────────────────

  triggerRefresh(): void {
    this.refreshCount++;
    this.notify();
  },

  setSearchMode(enabled: boolean): void {
    this.searchMode = enabled;
    this.notify();
  },

  navigateToMatch(filePath: string, line: number): void {
    this.openTab(filePath, { preview: false });
    this.scrollToLine = line;
    this.notify();
  },

  clearScrollToLine(): void {
    this.scrollToLine = null;
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  },

  // ── Persistence ──────────────────────────────────────────────────

  serialize(): PersistedTabState {
    return {
      tabs: this.getOrderedTabs().map((t: Tab) => ({
        id: t.id,
        filePath: t.filePath,
        isPinned: t.isPinned,
        isPreview: t.isPreview,
      })),
      activeTabId: this.activeTabId,
    };
  },

  restore(data: PersistedTabState): void {
    this.openTabs = data.tabs.map((t): Tab => ({
      id: t.id,
      filePath: t.filePath,
      isDirty: false,
      scrollState: null as ScrollState | null,
      isPinned: t.isPinned,
      isPreview: t.isPreview,
    }));
    this.tabOrder = data.tabs.map((t) => t.id);
    this.activeTabId = data.activeTabId;

    const activeTab = this.getActiveTab();
    this.selectedPath = activeTab?.filePath ?? null;

    // Ensure nextId doesn't collide with restored IDs
    for (const tab of this.openTabs) {
      const match = tab.id.match(/^tab-(\d+)-/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= nextId) nextId = num + 1;
      }
    }

    this.notify();
  },

  // ── Reset ────────────────────────────────────────────────────────

  reset(): void {
    this.openTabs = [];
    this.tabOrder = [];
    this.activeTabId = null;
    this.recentlyClosed = [];
    this.selectedPath = null;
    this.isDirty = false;
    this.refreshCount = 0;
    this.searchMode = false;
    this.scrollToLine = null;
    this.listeners.clear();
  },
};
