import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileState } from './state';

describe('fileState', () => {
  beforeEach(() => {
    fileState.reset();
  });

  it('starts with null selectedPath', () => {
    expect(fileState.selectedPath).toBeNull();
  });

  it('starts with isDirty false', () => {
    expect(fileState.isDirty).toBe(false);
  });

  it('starts with refreshCount 0', () => {
    expect(fileState.refreshCount).toBe(0);
  });

  describe('setSelectedPath', () => {
    it('updates selectedPath', () => {
      fileState.setSelectedPath('src/main.ts');
      expect(fileState.selectedPath).toBe('src/main.ts');
    });

    it('notifies listeners', () => {
      const listener = vi.fn();
      fileState.subscribe(listener);
      fileState.setSelectedPath('foo.ts');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('accepts null to deselect', () => {
      fileState.setSelectedPath('foo.ts');
      fileState.setSelectedPath(null);
      expect(fileState.selectedPath).toBeNull();
    });
  });

  describe('setDirty', () => {
    it('updates isDirty', () => {
      fileState.setDirty(true);
      expect(fileState.isDirty).toBe(true);
    });

    it('notifies listeners', () => {
      const listener = vi.fn();
      fileState.subscribe(listener);
      fileState.setDirty(true);
      expect(listener).toHaveBeenCalledOnce();
    });
  });

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
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('returns an unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = fileState.subscribe(listener);
      fileState.setDirty(true);
      expect(listener).toHaveBeenCalledOnce();

      unsub();
      fileState.setDirty(false);
      expect(listener).toHaveBeenCalledOnce(); // not called again
    });

    it('supports multiple listeners', () => {
      const a = vi.fn();
      const b = vi.fn();
      fileState.subscribe(a);
      fileState.subscribe(b);
      fileState.triggerRefresh();
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });
  });

  describe('reset', () => {
    it('clears all state and listeners', () => {
      const listener = vi.fn();
      fileState.subscribe(listener);
      fileState.setSelectedPath('foo.ts');
      fileState.setDirty(true);
      fileState.triggerRefresh();

      fileState.reset();

      expect(fileState.selectedPath).toBeNull();
      expect(fileState.isDirty).toBe(false);
      expect(fileState.refreshCount).toBe(0);

      // Listener should be cleared
      fileState.triggerRefresh();
      expect(listener).toHaveBeenCalledTimes(3); // from before reset, not after
    });
  });
});
