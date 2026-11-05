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
}

interface ToastStoreState {
  toasts: Toast[];
  addToast: (message: string, type: Toast['type'], action?: ToastAction) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  addToast: (message, type, action) => {
    set((s) => {
      if (s.toasts.some((t) => t.message === message && t.type === type)) return s;
      const id = crypto.randomUUID();
      return { toasts: [...s.toasts, { id, message, type, ...(action && { action }) }] };
    });
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
