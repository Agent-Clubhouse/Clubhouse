/**
 * Shared module-level state for the wiki plugin.
 *
 * Both SidebarPanel (WikiTree) and MainPanel (WikiViewer) are rendered in
 * separate React trees, so we use a lightweight pub/sub to coordinate
 * selected file, dirty state, view mode, and refresh signals.
 */

export const wikiState = {
  selectedPath: null as string | null,
  isDirty: false,
  viewMode: 'view' as 'view' | 'edit',
  refreshCount: 0,
  listeners: new Set<() => void>(),

  // Navigation history
  history: [] as string[],
  historyIndex: -1,
  _isNavigatingHistory: false,

  setSelectedPath(path: string | null): void {
    // Track navigation history for non-null paths
    if (path && !this._isNavigatingHistory) {
      // Truncate any forward history
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(path);
      this.historyIndex = this.history.length - 1;
    }
    this._isNavigatingHistory = false;
    this.selectedPath = path;
    this.notify();
  },

  goBack(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this._isNavigatingHistory = true;
      this.setSelectedPath(this.history[this.historyIndex]);
    }
  },

  canGoBack(): boolean {
    return this.historyIndex > 0;
  },

  setDirty(dirty: boolean): void {
    this.isDirty = dirty;
    this.notify();
  },

  setViewMode(mode: 'view' | 'edit'): void {
    this.viewMode = mode;
    this.notify();
  },

  triggerRefresh(): void {
    this.refreshCount++;
    this.notify();
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

  reset(): void {
    this.selectedPath = null;
    this.isDirty = false;
    this.viewMode = 'view';
    this.refreshCount = 0;
    this.history = [];
    this.historyIndex = -1;
    this._isNavigatingHistory = false;
    this.listeners.clear();
  },
};
