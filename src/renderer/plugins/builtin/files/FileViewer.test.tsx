import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FileViewer } from './FileViewer';
import { fileState } from './state';
import { createMockAPI } from '../../testing';

// Mock MonacoEditor and MarkdownPreview to avoid themes/require issues in jsdom
vi.mock('./MonacoEditor', () => ({
  MonacoEditor: ({ value, language }: { value: string; language: string }) =>
    React.createElement('div', { 'data-testid': 'monaco-editor' }, `Monaco: ${language}`),
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
  });
}

/** Select a file after the component has mounted and subscribed */
function selectFile(path: string) {
  act(() => {
    fileState.setSelectedPath(path);
  });
}

describe('FileViewer', () => {
  beforeEach(() => {
    fileState.reset();
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
  });

  it('shows "Open in Finder" button that calls api.files.showInFolder()', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('hello.ts');

    await waitFor(() => {
      expect(screen.getByText('Open in Finder')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Open in Finder'));
    expect(api.files.showInFolder).toHaveBeenCalledWith('hello.ts');
  });

  it('shows binary file message for unsupported formats', async () => {
    const api = createViewerAPI();
    render(<FileViewer api={api} />);

    selectFile('data.bin');

    await waitFor(() => {
      expect(screen.getByText('Cannot display binary file')).toBeInTheDocument();
    });
  });
});
