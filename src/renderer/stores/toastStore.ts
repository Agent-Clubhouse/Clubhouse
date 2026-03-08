import { create } from 'zustand';

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'info';
}

interface ToastStoreState {
  toasts: Toast[];
  addToast: (message: string, type: Toast['type']) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  addToast: (message, type) => {
    set((s) => {
      if (s.toasts.some((t) => t.message === message && t.type === type)) return s;
      const id = crypto.randomUUID();
      return { toasts: [...s.toasts, { id, message, type }] };
    });
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
