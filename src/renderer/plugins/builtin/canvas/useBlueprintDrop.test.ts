import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlueprintDrop } from './useBlueprintDrop';

// Valid blueprint fixture
const VALID_BLUEPRINT = {
  version: 1,
  name: 'Test Blueprint',
  views: [
    { type: 'agent', title: 'Agent 1', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, metadata: {} },
    { type: 'anchor', title: 'Anchor 1', position: { x: 400, y: 0 }, size: { width: 250, height: 100 }, metadata: {}, label: 'My Anchor' },
  ],
};

const VALID_BLUEPRINT_JSON = JSON.stringify(VALID_BLUEPRINT);

/** Create a mock File with the given name and text content. */
function createMockFile(name: string, content: string, type = 'application/json'): File {
  return new File([content], name, { type });
}

/** Create a mock DragEvent with the given files. */
function createDragEvent(type: string, files: File[] = [], items?: DataTransferItem[]): DragEvent {
  const dataTransfer: Partial<DataTransfer> = {
    files: files as unknown as FileList,
    dropEffect: 'none' as DataTransfer['dropEffect'],
    items: (items ?? files.map((f) => ({
      kind: 'file' as const,
      type: f.type,
      getAsFile: () => f,
    }))) as unknown as DataTransferItemList,
  };

  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, writable: false });
  Object.defineProperty(event, 'preventDefault', { value: vi.fn(), writable: false });
  Object.defineProperty(event, 'stopPropagation', { value: vi.fn(), writable: false });
  return event;
}

/** Create a mock ClipboardEvent with the given text data. */
function createPasteEvent(text: string): ClipboardEvent {
  const clipboardData = { getData: vi.fn(() => text) };
  const event = new Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: clipboardData, writable: false });
  Object.defineProperty(event, 'preventDefault', { value: vi.fn(), writable: false });
  return event;
}

describe('useBlueprintDrop', () => {
  let container: HTMLDivElement;
  let containerRef: React.RefObject<HTMLDivElement | null>;
  let onImport: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    containerRef = { current: container };
    onImport = vi.fn();
    onError = vi.fn();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function renderDropHook() {
    return renderHook(() => useBlueprintDrop({ containerRef, onImport, onError }));
  }

  describe('drag-over visual feedback', () => {
    it('sets isDragOver to true when dragging .json file over', () => {
      const { result } = renderDropHook();
      expect(result.current.isDragOver).toBe(false);

      const file = createMockFile('blueprint.json', VALID_BLUEPRINT_JSON);
      act(() => {
        container.dispatchEvent(createDragEvent('dragenter', [file]));
      });

      expect(result.current.isDragOver).toBe(true);
    });

    it('sets isDragOver to false on dragleave', () => {
      const { result } = renderDropHook();

      const file = createMockFile('blueprint.json', VALID_BLUEPRINT_JSON);
      act(() => {
        container.dispatchEvent(createDragEvent('dragenter', [file]));
      });
      expect(result.current.isDragOver).toBe(true);

      act(() => {
        container.dispatchEvent(createDragEvent('dragleave', [file]));
      });
      expect(result.current.isDragOver).toBe(false);
    });

    it('handles nested dragenter/dragleave from child elements', () => {
      const { result } = renderDropHook();

      const file = createMockFile('blueprint.json', VALID_BLUEPRINT_JSON);
      // Enter parent, then enter child (two enters before one leave)
      act(() => {
        container.dispatchEvent(createDragEvent('dragenter', [file]));
        container.dispatchEvent(createDragEvent('dragenter', [file]));
      });
      expect(result.current.isDragOver).toBe(true);

      // Leave child (one leave, but still inside parent)
      act(() => {
        container.dispatchEvent(createDragEvent('dragleave', [file]));
      });
      expect(result.current.isDragOver).toBe(true);

      // Leave parent
      act(() => {
        container.dispatchEvent(createDragEvent('dragleave', [file]));
      });
      expect(result.current.isDragOver).toBe(false);
    });

    it('resets isDragOver on drop', async () => {
      const { result } = renderDropHook();

      const file = createMockFile('blueprint.json', VALID_BLUEPRINT_JSON);
      act(() => {
        container.dispatchEvent(createDragEvent('dragenter', [file]));
      });
      expect(result.current.isDragOver).toBe(true);

      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });
      expect(result.current.isDragOver).toBe(false);
    });
  });

  describe('file drop import', () => {
    it('imports valid .json blueprint file on drop', async () => {
      renderDropHook();

      const file = createMockFile('blueprint.json', VALID_BLUEPRINT_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
      const imported = onImport.mock.calls[0][0];
      expect(imported.name).toBe('Test Blueprint');
      expect(imported.views).toHaveLength(2);
      expect(imported.views[0].type).toBe('agent');
      expect(imported.views[1].type).toBe('anchor');
    });

    it('calls onError for invalid JSON in .json file', async () => {
      renderDropHook();

      const file = createMockFile('bad.json', 'not valid json');
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBe('Not a valid JSON file');
    });

    it('calls onError for JSON that is not a valid blueprint', async () => {
      renderDropHook();

      const file = createMockFile('notblueprint.json', JSON.stringify({ foo: 'bar' }));
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('silently ignores non-.json files', async () => {
      renderDropHook();

      const file = createMockFile('image.png', 'binary data', 'image/png');
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('only imports the first .json file when multiple dropped', async () => {
      renderDropHook();

      const file1 = createMockFile('first.json', VALID_BLUEPRINT_JSON);
      const file2 = createMockFile('second.json', VALID_BLUEPRINT_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file1, file2]));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
    });

    it('filters .json files from mixed file drops', async () => {
      renderDropHook();

      const pngFile = createMockFile('image.png', 'binary', 'image/png');
      const jsonFile = createMockFile('blueprint.json', VALID_BLUEPRINT_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [pngFile, jsonFile]));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onImport.mock.calls[0][0].name).toBe('Test Blueprint');
    });
  });

  describe('clipboard paste', () => {
    it('imports valid blueprint JSON from clipboard paste', async () => {
      renderDropHook();

      await act(async () => {
        container.dispatchEvent(createPasteEvent(VALID_BLUEPRINT_JSON));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
      const imported = onImport.mock.calls[0][0];
      expect(imported.name).toBe('Test Blueprint');
    });

    it('prevents default on successful blueprint paste', async () => {
      renderDropHook();

      const event = createPasteEvent(VALID_BLUEPRINT_JSON);
      await act(async () => {
        container.dispatchEvent(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('ignores non-JSON clipboard text', async () => {
      renderDropHook();

      await act(async () => {
        container.dispatchEvent(createPasteEvent('Hello, world!'));
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('ignores JSON that does not look like a blueprint', async () => {
      renderDropHook();

      // Has JSON structure but missing "version" and "views" fields
      await act(async () => {
        container.dispatchEvent(createPasteEvent('{"name": "test"}'));
      });

      expect(onImport).not.toHaveBeenCalled();
    });

    it('does not prevent default for invalid blueprint JSON', async () => {
      renderDropHook();

      // Has "version" and "views" keywords but is actually invalid
      const badBlueprint = JSON.stringify({ version: 999, views: 'not-an-array' });
      const event = createPasteEvent(badBlueprint);
      await act(async () => {
        container.dispatchEvent(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(onImport).not.toHaveBeenCalled();
    });

    it('ignores empty clipboard', async () => {
      renderDropHook();

      await act(async () => {
        container.dispatchEvent(createPasteEvent(''));
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('event handling', () => {
    it('prevents default on dragover for .json files', () => {
      renderDropHook();

      const file = createMockFile('blueprint.json', '', 'application/json');
      const event = createDragEvent('dragover', [file]);
      act(() => {
        container.dispatchEvent(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('cleans up event listeners on unmount', () => {
      const spy = vi.spyOn(container, 'removeEventListener');
      const { unmount } = renderDropHook();
      unmount();

      const removedEvents = spy.mock.calls.map((c) => c[0]);
      expect(removedEvents).toContain('dragenter');
      expect(removedEvents).toContain('dragover');
      expect(removedEvents).toContain('dragleave');
      expect(removedEvents).toContain('drop');
      expect(removedEvents).toContain('paste');
    });
  });
});
