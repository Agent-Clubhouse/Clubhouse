import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FileViewer, clearFileCache, revealLabel } from './FileViewer';
import { fileState } from './state';
import { createMockAPI } from '../../testing';

// Track the last onSave callback passed to MonacoEditor so tests can trigger saves
let lastOnSave: ((content: string) => unknown) | null = null;

// Mock MonacoEditor and MarkdownPreview to avoid themes/require issues in jsdom
vi.mock('./MonacoEditor', () => ({
  MonacoEditor: ({ value: _value, language, onSave }: { value: string; language: string; onSave?: (content: string) => unknown; onCursorChange?: (line: number, column: number) => void }) => {
    lastOnSave = onSave || null;
    return React.createElement('div', { 'data-testid': 'monaco-editor' }, `Monaco: ${language}`);
  },
  disposeModel: vi.fn(),
  disposeAllModels: vi.fn(),
  updateSavedContent: vi.fn(),
  getModelContent: vi.fn(() => 'console.log("updated")'),
  isModelDirty: vi.fn(() => false),
  getOrCreateModel: vi.fn(),
}));

vi.mock('./MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'markdown-preview' }, content),
}));

function createViewerAPI() {
  return createMockAPI({
    files: {
      ...createMockAPI().files,
      readFile: vi.fn(async (path: string) => {
        if (path === 'hello.ts') return 'console.log("hello")';
        if (path === 'readme.md') return '# Hello\nWorld';
        return '';
      }),
      readBinary: vi.fn(async () => 'data:image/png;base64,abc'),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ size: 100, isDirectory: false, isFile: true, modifiedAt: Date.now() })),
      showInFolder: vi.fn(async () => {}),
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/project',
    },
    ui: {
      ...createMockAPI().ui,
      showError: vi.fn(),
    },
    storage: {
      project: {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
      },
    },
  });
}

/** Open a file via the tab system */
function selectFile(path: string) {
  act(() => {
    fileState.openTab(path, { preview: true });
  });
}

describe('FileViewer', () => {
  beforeEach(() => {
    fileState.reset();
    clearFileCache();
    lastOnSave = null;
  });

  it('shows empty state when no file selected', () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);
    expect(screen.getByText('Select a file to view')).toBeInTheDocument();
  });

  it('loads text file content from API', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('hello.ts');

    await waitFor(() => {
      expect(api.files.readFile).toHaveBeenCalledWith('hello.ts');
    });
  });

  it('shows markdown preview for .md files', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('readme.md');

    await waitFor(() => {
      expect(api.files.readFile).toHaveBeenCalledWith('readme.md');
    });

    // Should show Preview/Source toggle for markdown
    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
      expect(screen.getByText('Source')).toBeInTheDocument();
    });
  });

  it('shows image preview for image files', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('photo.png');

    await waitFor(() => {
      expect(api.files.readBinary).toHaveBeenCalledWith('photo.png');
    });
  });

  it('save calls api.files.writeFile()', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('hello.ts');

    await waitFor(() => {
      expect(api.files.readFile).toHaveBeenCalledWith('hello.ts');
    });

    // Wait for the MonacoEditor to render and capture the onSave callback
    await waitFor(() => {
      expect(lastOnSave).not.toBeNull();
    });

    // Trigger save via the onSave callback (simulates Cmd+S in Monaco)
    await act(async () => {
      lastOnSave!('console.log("updated")');
    });

    expect(api.files.writeFile).toHaveBeenCalledWith('hello.ts', 'console.log("updated")');
  });

  it('save resolves false and surfaces the error when the write fails', async () => {
    const api = createViewerAPI();
    (api.files.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('EACCES'));
    render(<FileViewer api={api} />);
    selectFile('hello.ts');
    await waitFor(() => expect(lastOnSave).not.toBeNull());

    let result: unknown;
    await act(async () => { result = await lastOnSave!('draft'); });

    expect(result).toBe(false);
    expect(api.ui.showError).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  describe('unsaved-changes dialog', () => {
    async function openDirtyTab(api: ReturnType<typeof createViewerAPI>) {
      render(<FileViewer api={api} />);
      selectFile('hello.ts');
      await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
      const tab = fileState.getTabByPath('hello.ts')!;
      act(() => fileState.setTabDirty(tab.id, true));
      fireEvent.click(screen.getByTitle('Close tab'));
      await waitFor(() => expect(screen.getByText('Unsaved Changes')).toBeInTheDocument());
      return tab;
    }

    it('keeps the tab open and dirty when Save fails', async () => {
      const api = createViewerAPI();
      (api.files.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
      const tab = await openDirtyTab(api);

      await act(async () => { fireEvent.click(screen.getByText('Save')); });

      expect(api.ui.showError).toHaveBeenCalledWith(expect.stringContaining('disk full'));
      expect(fileState.getTab(tab.id)).toBeDefined();
      expect(fileState.getTab(tab.id)!.isDirty).toBe(true);
    });

    it('closes the tab after a successful Save', async () => {
      const api = createViewerAPI();
      const tab = await openDirtyTab(api);

      await act(async () => { fireEvent.click(screen.getByText('Save')); });

      expect(api.files.writeFile).toHaveBeenCalledWith('hello.ts', 'console.log("updated")');
      expect(fileState.getTab(tab.id)).toBeUndefined();
    });
  });

  it('the strip menu reveals the file with api.files.showInFolder()', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('hello.ts');

    fireEvent.click(await screen.findByTestId('files-file-menu-btn'));
    fireEvent.click(screen.getByRole('menuitem', { name: revealLabel() }));
    expect(api.files.showInFolder).toHaveBeenCalledWith('hello.ts');
  });

  it('shows the reveal button on the binary file message', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('data.bin');

    fireEvent.click(await screen.findByText(revealLabel()));
    expect(api.files.showInFolder).toHaveBeenCalledWith('data.bin');
  });

  it('shows binary file message for unsupported formats', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('data.bin');

    await waitFor(() => {
      expect(screen.getByText('Cannot display binary file')).toBeInTheDocument();
    });
  });

  it('puts the path and cursor position in the one tab strip, with no header or status bar', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('hello.ts');

    await waitFor(() => {
      expect(screen.getByText('Ln 1, Col 1')).toBeInTheDocument();
    });

    const strip = screen.getByTestId('files-tab-strip');
    expect(strip).toContainElement(screen.getByTestId('files-cursor'));
    expect(strip).toContainElement(screen.getByTestId('files-active-path'));
    expect(screen.getByTestId('files-active-path')).toHaveTextContent('hello.ts');
    expect(screen.queryByText('UTF-8')).not.toBeInTheDocument();
  });

  it('does not show the cursor position for binary files', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('data.bin');

    await waitFor(() => {
      expect(screen.getByText('Cannot display binary file')).toBeInTheDocument();
    });

    expect(screen.queryByText('Ln 1, Col 1')).not.toBeInTheDocument();
  });

  describe('LB-PU-001: module-level cache cleared on deactivate', () => {
    it('clearFileCache is exported and callable without throwing', () => {
      expect(() => clearFileCache()).not.toThrow();
    });

    it('clearFileCache causes next file load to re-fetch from API', async () => {
      const api = createViewerAPI();
      const { unmount } = render(<FileViewer api={api} />);

      // Load a file — populates the module-level cache
      selectFile('hello.ts');
      await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
      expect(api.files.readFile).toHaveBeenCalledTimes(1);

      unmount();

      // Simulate plugin deactivation: clear the module-level cache
      clearFileCache();

      // Re-mount with the same file already selected in state
      const api2 = createViewerAPI();
      render(<FileViewer api={api2} />);

      selectFile('hello.ts');
      await waitFor(() => expect(api2.files.readFile).toHaveBeenCalledTimes(1));
      // api2 must have been called — proves the cache was cleared and re-fetched
    });
  });
});
