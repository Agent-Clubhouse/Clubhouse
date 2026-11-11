import { create } from 'zustand';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'info';
  action?: ToastAction;
  /** Distinguish operations whose messages match but whose actions target different agents. */
  dedupeKey?: string;
}

interface ToastStoreState {
  toasts: Toast[];
  addToast: (message: string, type: Toast['type'], action?: ToastAction, dedupeKey?: string) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  addToast: (message, type, action, dedupeKey) => {
    set((s) => {
      if (s.toasts.some((t) => dedupeKey !== undefined
        ? t.dedupeKey === dedupeKey
        : t.dedupeKey === undefined && t.message === message && t.type === type)) return s;
      const id = crypto.randomUUID();
      return { toasts: [...s.toasts, { id, message, type, ...(action && { action }), ...(dedupeKey !== undefined && { dedupeKey }) }] };
    });
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
