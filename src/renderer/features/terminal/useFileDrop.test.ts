import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileDrop } from './useFileDrop';

function makeFileList(files: Array<{ name: string; path: string }>): FileList {
  const fileObjects = files.map(f => ({ name: f.name, __path: f.path }));
  return {
    length: files.length,
    item: (i: number) => fileObjects[i] as unknown as File,
    [Symbol.iterator]: function* () { yield* fileObjects as unknown as File[]; },
    ...fileObjects.reduce<Record<number, unknown>>((acc, f, i) => { acc[i] = f; return acc; }, {}),
  } as unknown as FileList;
}

function makeDragEvent(opts: {
  types?: string[];
  files?: Array<{ name: string; path: string }>;
  currentTargetContains?: boolean;
  relatedTarget?: Node | null;
} = {}) {
  const types = opts.types ?? ['Files'];
  const files = makeFileList(opts.files ?? []);
  const contains = vi.fn().mockReturnValue(opts.currentTargetContains ?? false);

  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      files,
      dropEffect: '' as string,
    },
    currentTarget: { contains } as unknown as EventTarget,
    relatedTarget: (opts.relatedTarget ?? null) as EventTarget | null,
  } as unknown as React.DragEvent;
}

describe('useFileDrop', () => {
  let writeToPty: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeToPty = vi.fn();
    window.clubhouse.getPathForFile = vi.fn((file: File) => (file as any).__path ?? '');
  });

  describe('handleDragOver', () => {
    it('prevents default and sets dropEffect to copy for file drags', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      const e = makeDragEvent();
      act(() => { result.current.handleDragOver(e); });
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.dataTransfer.dropEffect).toBe('copy');
    });

    it('sets isDragOver to true for file drags', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      expect(result.current.isDragOver).toBe(false);
      act(() => { result.current.handleDragOver(makeDragEvent()); });
      expect(result.current.isDragOver).toBe(true);
    });

    it('ignores non-file drags', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      const e = makeDragEvent({ types: ['text/plain'] });
      act(() => { result.current.handleDragOver(e); });
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(result.current.isDragOver).toBe(false);
    });
  });

  describe('handleDragLeave', () => {
    it('clears isDragOver when leaving the outermost element', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => { result.current.handleDragOver(makeDragEvent()); });
      expect(result.current.isDragOver).toBe(true);

      act(() => {
        result.current.handleDragLeave(makeDragEvent({ currentTargetContains: false }));
      });
      expect(result.current.isDragOver).toBe(false);
    });

    it('does not clear isDragOver when moving to a child element', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => { result.current.handleDragOver(makeDragEvent()); });

      act(() => {
        result.current.handleDragLeave(makeDragEvent({ currentTargetContains: true }));
      });
      expect(result.current.isDragOver).toBe(true);
    });
  });

  describe('handleDrop', () => {
    it('prevents default and clears isDragOver', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => { result.current.handleDragOver(makeDragEvent()); });
      const e = makeDragEvent({ files: [{ name: 'file.txt', path: '/tmp/file.txt' }] });
      act(() => { result.current.handleDrop(e); });
      expect(e.preventDefault).toHaveBeenCalled();
      expect(result.current.isDragOver).toBe(false);
    });

    it('does nothing when no files are dropped', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => { result.current.handleDrop(makeDragEvent({ files: [] })); });
      expect(writeToPty).not.toHaveBeenCalled();
    });

    it('passes a simple path as-is', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => {
        result.current.handleDrop(makeDragEvent({
          files: [{ name: 'notes.txt', path: '/home/user/notes.txt' }],
        }));
      });
      expect(writeToPty).toHaveBeenCalledWith('/home/user/notes.txt');
    });

    it('wraps paths with spaces in single quotes', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => {
        result.current.handleDrop(makeDragEvent({
          files: [{ name: 'my file.txt', path: '/home/user/my file.txt' }],
        }));
      });
      expect(writeToPty).toHaveBeenCalledWith("'/home/user/my file.txt'");
    });

    it('space-separates multiple paths', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => {
        result.current.handleDrop(makeDragEvent({
          files: [
            { name: 'a.txt', path: '/tmp/a.txt' },
            { name: 'b.txt', path: '/tmp/b.txt' },
          ],
        }));
      });
      expect(writeToPty).toHaveBeenCalledWith('/tmp/a.txt /tmp/b.txt');
    });

    it('quotes only the paths that contain spaces in a multi-drop', () => {
      const { result } = renderHook(() => useFileDrop(writeToPty));
      act(() => {
        result.current.handleDrop(makeDragEvent({
          files: [
            { name: 'plain.txt', path: '/tmp/plain.txt' },
            { name: 'has spaces.txt', path: '/tmp/has spaces.txt' },
          ],
        }));
      });
      expect(writeToPty).toHaveBeenCalledWith("/tmp/plain.txt '/tmp/has spaces.txt'");
    });
  });
});
