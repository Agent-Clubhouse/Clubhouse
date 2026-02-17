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

  setSelectedPath(path: string | null): void {
    this.selectedPath = path;
    this.notify();
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
    this.listeners.clear();
  },
};
