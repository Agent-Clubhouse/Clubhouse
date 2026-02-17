import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WikiTree } from './WikiTree';
import { WikiViewer } from './WikiViewer';
import { wikiState } from './state';
import { createMockAPI } from '../../testing';
import type { FileNode } from '../../../../shared/types';
import type { FilesAPI } from '../../../../shared/plugin-types';

// ── Mock MonacoEditor and MarkdownPreview ─────────────────────────────

vi.mock('../files/MonacoEditor', () => ({
  MonacoEditor: ({ value, filePath }: { value: string; filePath: string }) =>
    React.createElement('div', { 'data-testid': 'monaco-editor' }, `Editor: ${filePath}`),
}));

vi.mock('../files/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'markdown-preview' }, content),
}));

// ── Test data ─────────────────────────────────────────────────────────

const MOCK_WIKI_TREE: FileNode[] = [
  {
    name: 'guides',
    path: 'guides',
    isDirectory: true,
    children: [
      { name: 'getting-started.md', path: 'guides/getting-started.md', isDirectory: false },
      { name: 'config.yaml', path: 'guides/config.yaml', isDirectory: false },
    ],
  },
  { name: 'home.md', path: 'home.md', isDirectory: false },
  { name: 'notes.txt', path: 'notes.txt', isDirectory: false },
];

function createScopedFilesAPI(overrides?: Partial<FilesAPI>): FilesAPI {
  return {
    readTree: vi.fn(async () => MOCK_WIKI_TREE),
    readFile: vi.fn(async () => '# Hello Wiki'),
    readBinary: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 100, isDirectory: false, isFile: true, modifiedAt: 0 })),
    rename: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    showInFolder: vi.fn(async () => {}),
    forRoot: vi.fn(() => { throw new Error('nested'); }),
    ...overrides,
  };
}

function createWikiAPI(scopedOverrides?: Partial<FilesAPI>, apiOverrides?: Partial<ReturnType<typeof createMockAPI>>) {
  const scoped = createScopedFilesAPI(scopedOverrides);
  return createMockAPI({
    files: {
      ...createMockAPI().files,
      forRoot: vi.fn(() => scoped),
    },
    settings: {
      get: (key: string) => key === 'wikiPath' ? '/path/to/wiki' : false,
      getAll: () => ({ wikiPath: '/path/to/wiki', showHiddenFiles: false }),
      onChange: () => ({ dispose: () => {} }),
    },
    agents: {
      ...createMockAPI().agents,
      list: vi.fn(() => []),
      runQuick: vi.fn(async () => 'agent-1'),
    },
    ui: {
      ...createMockAPI().ui,
      showInput: vi.fn(async () => 'test mission'),
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/project',
    },
    ...apiOverrides,
  });
}

// ── WikiTree tests ────────────────────────────────────────────────────

describe('WikiTree', () => {
  beforeEach(() => {
    wikiState.reset();
  });

  it('renders wiki tree from scoped files API', async () => {
    const api = createWikiAPI();
    render(<WikiTree api={api} />);

    expect(await screen.findByText('Home')).toBeInTheDocument(); // prettified
    expect(screen.getByText('guides')).toBeInTheDocument();
  });

  it('in view mode, filters to .md files only and prettifies names', async () => {
    const api = createWikiAPI();
    render(<WikiTree api={api} />);

    await screen.findByText('Home'); // home.md -> Home
    // notes.txt should not be visible in view mode
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('in edit mode, shows all files with raw names', async () => {
    wikiState.setViewMode('edit');
    const api = createWikiAPI();
    render(<WikiTree api={api} />);

    await screen.findByText('home.md'); // raw name
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

  it('view/edit toggle buttons switch mode', async () => {
    const api = createWikiAPI();
    render(<WikiTree api={api} />);

    await screen.findByText('Home'); // view mode initially

    // Click Edit
    const editBtn = screen.getByText('Edit');
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(wikiState.viewMode).toBe('edit');
    });
  });

  it('agent button calls api.ui.showInput and api.agents.runQuick', async () => {
    const runQuick = vi.fn(async () => 'agent-1');
    const showInput = vi.fn(async () => 'do something');
    const api = createWikiAPI(undefined, {
      agents: {
        ...createMockAPI().agents,
        runQuick,
        list: vi.fn(() => []),
      },
      ui: {
        ...createMockAPI().ui,
        showInput,
        showNotice: vi.fn(),
      },
    });

    render(<WikiTree api={api} />);
    await screen.findByText('Home');

    const agentBtn = screen.getByTitle('Run Agent in Wiki');
    fireEvent.click(agentBtn);

    await waitFor(() => {
      expect(showInput).toHaveBeenCalledWith('Mission');
      expect(runQuick).toHaveBeenCalledWith('do something', expect.objectContaining({
        systemPrompt: expect.stringContaining('wiki'),
      }));
    });
  });

  it('shows config error state when forRoot throws', async () => {
    const api = createMockAPI({
      files: {
        ...createMockAPI().files,
        forRoot: vi.fn(() => { throw new Error('not configured'); }),
      },
      settings: {
        get: () => undefined,
        getAll: () => ({}),
        onChange: () => ({ dispose: () => {} }),
      },
    });

    render(<WikiTree api={api as any} />);

    expect(await screen.findByText('Wiki not configured')).toBeInTheDocument();
  });
});

// ── WikiViewer tests ──────────────────────────────────────────────────

describe('WikiViewer', () => {
  beforeEach(() => {
    wikiState.reset();
  });

  it('shows empty state when no file selected', () => {
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    expect(screen.getByText('Select a page to view')).toBeInTheDocument();
  });

  it('loads and displays file content when path selected', async () => {
    wikiState.selectedPath = 'home.md';
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    // In view mode, should show markdown preview
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Hello Wiki');
  });

  it('in view mode shows MarkdownPreview', async () => {
    wikiState.selectedPath = 'home.md';
    wikiState.viewMode = 'view';
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument();
  });

  it('in edit mode shows MonacoEditor', async () => {
    wikiState.selectedPath = 'home.md';
    wikiState.viewMode = 'edit';
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    expect(await screen.findByTestId('monaco-editor')).toBeInTheDocument();
  });

  it('shows dirty indicator when isDirty', async () => {
    wikiState.selectedPath = 'home.md';
    wikiState.isDirty = true;
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    await screen.findByTestId('markdown-preview');
    expect(screen.getByTitle('Unsaved changes')).toBeInTheDocument();
  });

  it('has Send to Agent button', async () => {
    wikiState.selectedPath = 'home.md';
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    await screen.findByTestId('markdown-preview');
    expect(screen.getByText('Send to Agent')).toBeInTheDocument();
  });
});
