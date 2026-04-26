import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlueprintDrop } from './useBlueprintDrop';

// ── Fixtures ─────────────────────────────────────────────────────────

const VALID_LEGACY = {
  version: 1,
  name: 'Test Blueprint',
  views: [
    { type: 'agent', title: 'Agent 1', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, metadata: {} },
    { type: 'anchor', title: 'Anchor 1', position: { x: 400, y: 0 }, size: { width: 250, height: 100 }, metadata: {}, label: 'My Anchor' },
  ],
};
const VALID_LEGACY_JSON = JSON.stringify(VALID_LEGACY);

// Manifest format — what fresh exports look like (semver string version + schemaVersion: 1)
const VALID_MANIFEST = {
  id: 'bp-test',
  name: 'Manifest Test',
  version: '1.0.0',
  schemaVersion: 1,
  createdAt: '2026-04-25T12:00:00.000Z',
  canvas: {
    views: [
      { refId: 'v1', type: 'agent', displayName: 'Alpha', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, agentRef: 'a1' },
    ],
    wires: [],
  },
  agents: [{ refId: 'a1', name: 'Alpha', matchBy: { name: 'Alpha' } }],
};
const VALID_MANIFEST_JSON = JSON.stringify(VALID_MANIFEST);

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

      const file = createMockFile('blueprint.json', VALID_LEGACY_JSON);
      act(() => {
        container.dispatchEvent(createDragEvent('dragenter', [file]));
      });

      expect(result.current.isDragOver).toBe(true);
    });

    it('sets isDragOver to false on dragleave', () => {
      const { result } = renderDropHook();

      const file = createMockFile('blueprint.json', VALID_LEGACY_JSON);
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

      const file = createMockFile('blueprint.json', VALID_LEGACY_JSON);
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

      const file = createMockFile('blueprint.json', VALID_LEGACY_JSON);
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
    it('imports valid legacy .json blueprint file on drop', async () => {
      renderDropHook();

      const file = createMockFile('blueprint.json', VALID_LEGACY_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
      const result = onImport.mock.calls[0][0];
      expect(result.format).toBe('legacy');
      expect(result.canvas.name).toBe('Test Blueprint');
      expect(result.canvas.views).toHaveLength(2);
    });

    it('imports a manifest blueprint (semver string version) on drop', async () => {
      renderDropHook();

      const file = createMockFile('manifest.json', VALID_MANIFEST_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      // Previously this case threw "Unsupported blueprint version: 1.0.0"
      expect(onError).not.toHaveBeenCalled();
      expect(onImport).toHaveBeenCalledTimes(1);
      const result = onImport.mock.calls[0][0];
      expect(result.format).toBe('manifest');
      expect(result.canvas.name).toBe('Manifest Test');
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

      const file1 = createMockFile('first.json', VALID_LEGACY_JSON);
      const file2 = createMockFile('second.json', VALID_LEGACY_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file1, file2]));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
    });

    it('filters .json files from mixed file drops', async () => {
      renderDropHook();

      const pngFile = createMockFile('image.png', 'binary', 'image/png');
      const jsonFile = createMockFile('blueprint.json', VALID_LEGACY_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [pngFile, jsonFile]));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onImport.mock.calls[0][0].canvas.name).toBe('Test Blueprint');
    });

    it('passes parse context to manifest imports for agent matching', async () => {
      const matchedAgent: any = { id: 'agent-real', name: 'Alpha', orchestrator: null, model: null, status: 'sleeping' };
      const getParseContext = vi.fn(() => ({
        agents: [matchedAgent],
        projects: [],
        activeProjectId: 'proj-1',
      }));
      renderHook(() => useBlueprintDrop({ containerRef, onImport, onError, getParseContext }));

      const file = createMockFile('manifest.json', VALID_MANIFEST_JSON);
      await act(async () => {
        container.dispatchEvent(createDragEvent('drop', [file]));
      });

      expect(getParseContext).toHaveBeenCalled();
      const result = onImport.mock.calls[0][0];
      // Agent should match and stub binding should be populated
      expect(result.stubs).toHaveLength(1);
      expect(result.stubs[0].badge).toBe('connected');
      expect(result.stubs[0].boundAgentId).toBe('agent-real');
    });
  });

  describe('clipboard paste', () => {
    it('imports valid legacy blueprint JSON from clipboard paste', async () => {
      renderDropHook();

      await act(async () => {
        container.dispatchEvent(createPasteEvent(VALID_LEGACY_JSON));
      });

      expect(onImport).toHaveBeenCalledTimes(1);
      const result = onImport.mock.calls[0][0];
      expect(result.format).toBe('legacy');
      expect(result.canvas.name).toBe('Test Blueprint');
    });

    it('imports valid manifest blueprint JSON from clipboard paste', async () => {
      renderDropHook();

      await act(async () => {
        container.dispatchEvent(createPasteEvent(VALID_MANIFEST_JSON));
      });

      // Previously this silently failed because the legacy validator rejected the semver string version
      expect(onError).not.toHaveBeenCalled();
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onImport.mock.calls[0][0].format).toBe('manifest');
    });

    it('prevents default on successful blueprint paste', async () => {
      renderDropHook();

      const event = createPasteEvent(VALID_LEGACY_JSON);
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

      // Has JSON structure but missing the version/schemaVersion/views markers
      await act(async () => {
        container.dispatchEvent(createPasteEvent('{"name": "test"}'));
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('surfaces an error when blueprint-shaped JSON fails to validate', async () => {
      renderDropHook();

      // Has "version" and "views" keywords but is actually invalid (future numeric version).
      // Previously this silently dropped — users got no feedback. Now we surface the error.
      const badBlueprint = JSON.stringify({ version: 999, views: [] });
      const event = createPasteEvent(badBlueprint);
      await act(async () => {
        container.dispatchEvent(event);
      });

      expect(onImport).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toContain('Unsupported blueprint version');
      // We still preventDefault — we consumed the paste (with an error toast),
      // so the user's clipboard text shouldn't be inserted into a focused input.
      expect(event.preventDefault).toHaveBeenCalled();
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
