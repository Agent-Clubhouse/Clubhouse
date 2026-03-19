/**
 * Shared module-level state for the browser plugin.
 *
 * SidebarPanel and MainPanel are rendered in separate React trees,
 * so we use a lightweight pub/sub to coordinate navigation state.
 */

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

export type BrowserCommand = 'reload' | 'devtools' | 'back' | 'forward';

type CommandHandler = (cmd: BrowserCommand) => void;

export const browserState = {
  currentUrl: '' as string,
  currentTitle: '' as string,
  history: [] as HistoryEntry[],
  listeners: new Set<() => void>(),
  commandHandlers: new Set<CommandHandler>(),

  setCurrentPage(url: string, title: string): void {
    this.currentUrl = url;
    this.currentTitle = title || url;

    // Add to history (dedup consecutive same-URL entries)
    const lastEntry = this.history[0];
    if (!lastEntry || lastEntry.url !== url) {
      this.history = [
        { url, title: title || url, visitedAt: Date.now() },
        ...this.history.slice(0, 49), // keep last 50
      ];
    }
    this.notify();
  },

  dispatchCommand(cmd: BrowserCommand): void {
    for (const handler of this.commandHandlers) {
      try {
        handler(cmd);
      } catch {
        // swallow — a failing handler should not break others
      }
    }
  },

  onCommand(handler: CommandHandler): () => void {
    this.commandHandlers.add(handler);
    return () => {
      this.commandHandlers.delete(handler);
    };
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // swallow
      }
    }
  },

  reset(): void {
    this.currentUrl = '';
    this.currentTitle = '';
    this.history = [];
    this.listeners.clear();
    this.commandHandlers.clear();
  },
};
