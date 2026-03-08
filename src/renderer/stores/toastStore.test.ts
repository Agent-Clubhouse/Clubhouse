import { describe, it, expect, beforeEach } from 'vitest';
import { useToastStore } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    // Clear all toasts between tests
    useToastStore.setState({ toasts: [] });
  });

  it('starts with an empty toast list', () => {
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('addToast appends a toast with a unique id', () => {
    useToastStore.getState().addToast('Something went wrong', 'error');
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Something went wrong');
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].id).toBeTruthy();
  });

  it('addToast supports info type', () => {
    useToastStore.getState().addToast('All good', 'info');
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('info');
  });

  it('addToast assigns unique ids to multiple toasts', () => {
    useToastStore.getState().addToast('Error 1', 'error');
    useToastStore.getState().addToast('Error 2', 'error');
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(2);
    expect(toasts[0].id).not.toBe(toasts[1].id);
  });

  it('removeToast removes only the specified toast', () => {
    useToastStore.getState().addToast('First', 'error');
    useToastStore.getState().addToast('Second', 'info');
    const first = useToastStore.getState().toasts[0];
    useToastStore.getState().removeToast(first.id);
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Second');
  });

  it('removeToast is a no-op for unknown id', () => {
    useToastStore.getState().addToast('Only', 'error');
    useToastStore.getState().removeToast('nonexistent');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
