import { createContext, useCallback, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';

/** Which transcript rows are open, kept above the stream's window so a row scrolled away keeps its state. */
export interface TranscriptExpansionStore {
  get: (key: string) => boolean | undefined;
  set: (key: string, open: boolean) => void;
  subscribe: (key: string, listener: () => void) => () => void;
}

export function createTranscriptExpansionStore(): TranscriptExpansionStore {
  const values = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key) => values.get(key),
    set: (key, open) => {
      if (values.get(key) === open) return;
      values.set(key, open);
      listeners.get(key)?.forEach((listener) => listener());
    },
    subscribe: (key, listener) => {
      const keyListeners = listeners.get(key) ?? new Set();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },
  };
}

const TranscriptExpansionContext = createContext<TranscriptExpansionStore | null>(null);

export function TranscriptExpansionProvider({ store, children }: { store: TranscriptExpansionStore; children: ReactNode }) {
  return <TranscriptExpansionContext.Provider value={store}>{children}</TranscriptExpansionContext.Provider>;
}

export function useOpenState(defaultOpen: boolean, expansionKey?: string): [boolean, () => void] {
  const store = useContext(TranscriptExpansionContext);
  const subscribe = useCallback((listener: () => void) => (
    store && expansionKey ? store.subscribe(expansionKey, listener) : () => undefined
  ), [store, expansionKey]);
  const getSnapshot = useCallback(() => (
    store && expansionKey ? store.get(expansionKey) : undefined
  ), [store, expansionKey]);
  const storedOpen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [localOpen, setLocalOpen] = useState<boolean | undefined>(undefined);
  const open = storedOpen ?? localOpen ?? defaultOpen;
  const toggle = useCallback(() => {
    if (store && expansionKey) store.set(expansionKey, !open);
    else setLocalOpen(!open);
  }, [store, expansionKey, open]);
  return [open, toggle];
}
