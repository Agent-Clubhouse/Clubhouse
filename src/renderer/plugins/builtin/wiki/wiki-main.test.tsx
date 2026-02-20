import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WikiTree, parseOrderFile, sortByOrder, filterMarkdownTree } from './WikiTree';
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

vi.mock('./WikiMarkdownPreview', () => ({
  WikiMarkdownPreview: ({ content, pageNames, onNavigate, wikiStyle }: { content: string; pageNames: string[]; onNavigate: (name: string) => void; wikiStyle?: string }) =>
    React.createElement('div', { 'data-testid': 'markdown-preview', 'data-wiki-style': wikiStyle || 'github' }, content),
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
      get: (key: string) => {
        if (key === 'wikiPath') return '/path/to/wiki';
        if (key === 'wikiStyle') return 'github';
        return false;
      },
      getAll: () => ({ wikiPath: '/path/to/wiki', wikiStyle: 'github', showHiddenFiles: false }),
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
    expect(screen.getByText('Guides')).toBeInTheDocument(); // directories also prettified in view mode
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

// ── parseOrderFile tests ─────────────────────────────────────────────

describe('parseOrderFile', () => {
  it('parses simple .order file content', () => {
    const result = parseOrderFile('Home\nGetting-Started\nAPI-Reference');
    expect(result).toEqual(['Home', 'Getting-Started', 'API-Reference']);
  });

  it('ignores empty lines', () => {
    const result = parseOrderFile('Home\n\nGetting-Started\n\n');
    expect(result).toEqual(['Home', 'Getting-Started']);
  });

  it('trims whitespace', () => {
    const result = parseOrderFile('  Home  \n  Getting-Started  ');
    expect(result).toEqual(['Home', 'Getting-Started']);
  });

  it('ignores comment lines starting with #', () => {
    const result = parseOrderFile('# comment\nHome\n# another comment\nGuide');
    expect(result).toEqual(['Home', 'Guide']);
  });

  it('returns empty array for empty content', () => {
    expect(parseOrderFile('')).toEqual([]);
    expect(parseOrderFile('\n\n')).toEqual([]);
  });
});

// ── sortByOrder tests ────────────────────────────────────────────────

describe('sortByOrder', () => {
  const nodes: FileNode[] = [
    { name: 'Zebra.md', path: 'Zebra.md', isDirectory: false },
    { name: 'Apple.md', path: 'Apple.md', isDirectory: false },
    { name: 'Banana.md', path: 'Banana.md', isDirectory: false },
    { name: 'guides', path: 'guides', isDirectory: true },
  ];

  it('sorts nodes according to .order list', () => {
    const order = ['Banana', 'Zebra', 'guides', 'Apple'];
    const sorted = sortByOrder(nodes, order);
    expect(sorted.map((n) => n.name)).toEqual(['Banana.md', 'Zebra.md', 'guides', 'Apple.md']);
  });

  it('puts ordered items first, unordered items alphabetically after', () => {
    const order = ['Banana'];
    const sorted = sortByOrder(nodes, order);
    expect(sorted[0].name).toBe('Banana.md');
    // Remaining items should be alphabetical
    expect(sorted.slice(1).map((n) => n.name)).toEqual(['Apple.md', 'guides', 'Zebra.md']);
  });

  it('returns original order when order list is empty', () => {
    const sorted = sortByOrder(nodes, []);
    expect(sorted).toEqual(nodes);
  });

  it('matches case-insensitively', () => {
    const order = ['zebra', 'APPLE'];
    const sorted = sortByOrder(nodes, order);
    expect(sorted[0].name).toBe('Zebra.md');
    expect(sorted[1].name).toBe('Apple.md');
  });

  it('matches directories without extension', () => {
    const order = ['guides', 'Apple'];
    const sorted = sortByOrder(nodes, order);
    expect(sorted[0].name).toBe('guides');
    expect(sorted[1].name).toBe('Apple.md');
  });
});

// ── ADO-style WikiTree tests ─────────────────────────────────────────

describe('WikiTree (ADO mode)', () => {
  const ADO_WIKI_TREE: FileNode[] = [
    {
      name: 'Architecture',
      path: 'Architecture',
      isDirectory: true,
      children: [
        { name: 'API-Design.md', path: 'Architecture/API-Design.md', isDirectory: false },
      ],
    },
    { name: 'Architecture.md', path: 'Architecture.md', isDirectory: false },
    { name: 'Getting-Started.md', path: 'Getting-Started.md', isDirectory: false },
    { name: '.order', path: '.order', isDirectory: false },
  ];

  function createAdoWikiAPI(scopedOverrides?: Partial<FilesAPI>) {
    const scoped = createScopedFilesAPI({
      readTree: vi.fn(async () => ADO_WIKI_TREE),
      readFile: vi.fn(async (path: string) => {
        if (path === '.order') return 'Getting-Started\nArchitecture';
        return '# ADO Wiki Page';
      }),
      ...scopedOverrides,
    });
    return createMockAPI({
      files: {
        ...createMockAPI().files,
        forRoot: vi.fn(() => scoped),
      },
      settings: {
        get: (key: string) => {
          if (key === 'wikiPath') return '/path/to/wiki';
          if (key === 'wikiStyle') return 'ado';
          return false;
        },
        getAll: () => ({ wikiPath: '/path/to/wiki', wikiStyle: 'ado', showHiddenFiles: false }),
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
    });
  }

  beforeEach(() => {
    wikiState.reset();
  });

  it('hides .order files from the tree in ADO mode', async () => {
    const api = createAdoWikiAPI();
    render(<WikiTree api={api} />);

    await screen.findByText('Getting Started'); // prettified ADO name
    expect(screen.queryByText('.order')).not.toBeInTheDocument();
  });

  it('prettifies ADO names (dashes become spaces)', async () => {
    const api = createAdoWikiAPI();
    render(<WikiTree api={api} />);

    expect(await screen.findByText('Getting Started')).toBeInTheDocument();
  });

  it('hides same-named .md files when folder exists (ADO pattern)', async () => {
    const api = createAdoWikiAPI();
    render(<WikiTree api={api} />);

    await screen.findByText('Getting Started');
    // Architecture.md should be hidden because Architecture/ folder exists
    // But the Architecture folder should be visible
    expect(screen.getByText('Architecture')).toBeInTheDocument();
    // The standalone Architecture.md file should be hidden in view mode
    const architectureElements = screen.getAllByText('Architecture');
    // Only 1: the folder (not the .md file)
    expect(architectureElements).toHaveLength(1);
  });

  it('shows ADO folders with empty children (lazy-loaded, not yet expanded)', async () => {
    // Simulate realistic depth-1 readTree output where subdirectories have children: []
    const LAZY_ADO_TREE: FileNode[] = [
      {
        name: 'Architecture',
        path: 'Architecture',
        isDirectory: true,
        children: [],  // Empty from depth-1 lazy loading
      },
      { name: 'Architecture.md', path: 'Architecture.md', isDirectory: false },
      { name: 'Getting-Started.md', path: 'Getting-Started.md', isDirectory: false },
      { name: '.order', path: '.order', isDirectory: false },
    ];
    const api = createAdoWikiAPI({
      readTree: vi.fn(async () => LAZY_ADO_TREE),
    });
    render(<WikiTree api={api} />);

    // Architecture folder should be visible even with empty children
    expect(await screen.findByText('Architecture')).toBeInTheDocument();
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });

  it('expands ADO folder and auto-selects index page', async () => {
    const LAZY_ADO_TREE: FileNode[] = [
      {
        name: 'Architecture',
        path: 'Architecture',
        isDirectory: true,
        children: [],
      },
      { name: 'Architecture.md', path: 'Architecture.md', isDirectory: false },
      { name: 'Getting-Started.md', path: 'Getting-Started.md', isDirectory: false },
    ];

    const ARCHITECTURE_CHILDREN: FileNode[] = [
      { name: 'Architecture.md', path: 'Architecture/Architecture.md', isDirectory: false },
      { name: 'API-Design.md', path: 'Architecture/API-Design.md', isDirectory: false },
    ];

    const readTreeMock = vi.fn(async (path: string) => {
      if (path === 'Architecture') return ARCHITECTURE_CHILDREN;
      return LAZY_ADO_TREE;
    });

    const api = createAdoWikiAPI({
      readTree: readTreeMock,
      readFile: vi.fn(async (path: string) => {
        if (path === '.order' || path === 'Architecture/.order') return '';
        return '# ADO Wiki Page';
      }),
    });

    render(<WikiTree api={api} />);
    await screen.findByText('Architecture');

    // Click the folder to expand it
    fireEvent.click(screen.getByText('Architecture'));

    // After expansion, the index page should be auto-selected
    await waitFor(() => {
      expect(wikiState.selectedPath).toBe('Architecture/Architecture.md');
    });
  });

  it('expands ADO folder and auto-selects sibling .md when no child index page exists', async () => {
    // ADO pattern: Architecture.md is a sibling of Architecture/ folder,
    // NOT duplicated inside the folder as Architecture/Architecture.md
    const LAZY_ADO_TREE: FileNode[] = [
      {
        name: 'Architecture',
        path: 'Architecture',
        isDirectory: true,
        children: [],
      },
      { name: 'Architecture.md', path: 'Architecture.md', isDirectory: false },
      { name: 'Getting-Started.md', path: 'Getting-Started.md', isDirectory: false },
    ];

    // The folder's children do NOT contain a same-named .md file
    const ARCHITECTURE_CHILDREN: FileNode[] = [
      { name: 'API-Design.md', path: 'Architecture/API-Design.md', isDirectory: false },
      { name: 'Data-Model.md', path: 'Architecture/Data-Model.md', isDirectory: false },
    ];

    const readTreeMock = vi.fn(async (path: string) => {
      if (path === 'Architecture') return ARCHITECTURE_CHILDREN;
      return LAZY_ADO_TREE;
    });

    const statMock = vi.fn(async (path: string) => {
      if (path === 'Architecture.md') {
        return { size: 100, isDirectory: false, isFile: true, modifiedAt: 0 };
      }
      throw new Error('not found');
    });

    const api = createAdoWikiAPI({
      readTree: readTreeMock,
      stat: statMock,
      readFile: vi.fn(async (path: string) => {
        if (path === '.order' || path === 'Architecture/.order') return '';
        return '# ADO Wiki Page';
      }),
    });

    render(<WikiTree api={api} />);
    await screen.findByText('Architecture');

    // Click the folder to expand it
    fireEvent.click(screen.getByText('Architecture'));

    // After expansion, the sibling .md page should be auto-selected
    await waitFor(() => {
      expect(wikiState.selectedPath).toBe('Architecture.md');
    });
  });

  it('expands nested ADO folder and auto-selects sibling .md at same level', async () => {
    // Nested case: Guides/Architecture/ folder with Guides/Architecture.md sibling
    const GUIDES_CHILDREN: FileNode[] = [
      {
        name: 'Architecture',
        path: 'Guides/Architecture',
        isDirectory: true,
        children: [],
      },
      { name: 'Architecture.md', path: 'Guides/Architecture.md', isDirectory: false },
    ];

    const LAZY_ADO_TREE: FileNode[] = [
      {
        name: 'Guides',
        path: 'Guides',
        isDirectory: true,
        children: GUIDES_CHILDREN,
      },
      { name: 'Getting-Started.md', path: 'Getting-Started.md', isDirectory: false },
    ];

    const ARCHITECTURE_CHILDREN: FileNode[] = [
      { name: 'API-Design.md', path: 'Guides/Architecture/API-Design.md', isDirectory: false },
    ];

    const readTreeMock = vi.fn(async (path: string) => {
      if (path === 'Guides/Architecture') return ARCHITECTURE_CHILDREN;
      if (path === 'Guides') return GUIDES_CHILDREN;
      return LAZY_ADO_TREE;
    });

    const statMock = vi.fn(async (path: string) => {
      if (path === 'Guides/Architecture.md') {
        return { size: 100, isDirectory: false, isFile: true, modifiedAt: 0 };
      }
      throw new Error('not found');
    });

    const api = createAdoWikiAPI({
      readTree: readTreeMock,
      stat: statMock,
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('.order')) return '';
        return '# ADO Wiki Page';
      }),
    });

    render(<WikiTree api={api} />);

    // First expand Guides
    await screen.findByText('Guides');
    fireEvent.click(screen.getByText('Guides'));

    // Wait for Guides to expand and show Architecture folder
    await waitFor(() => {
      expect(screen.getByText('Architecture')).toBeInTheDocument();
    });

    // Click Architecture folder
    fireEvent.click(screen.getByText('Architecture'));

    // The sibling Guides/Architecture.md should be auto-selected
    await waitFor(() => {
      expect(wikiState.selectedPath).toBe('Guides/Architecture.md');
    });
  });
});

// ── filterMarkdownTree tests ─────────────────────────────────────────

describe('filterMarkdownTree', () => {
  it('includes directories with loaded markdown children', () => {
    const nodes: FileNode[] = [
      {
        name: 'docs',
        path: 'docs',
        isDirectory: true,
        children: [
          { name: 'guide.md', path: 'docs/guide.md', isDirectory: false },
        ],
      },
      { name: 'readme.md', path: 'readme.md', isDirectory: false },
    ];
    const result = filterMarkdownTree(nodes, 'github');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('docs');
    expect(result[1].name).toBe('readme.md');
  });

  it('excludes directories with loaded children but no markdown files', () => {
    const nodes: FileNode[] = [
      {
        name: 'assets',
        path: 'assets',
        isDirectory: true,
        children: [
          { name: 'logo.png', path: 'assets/logo.png', isDirectory: false },
        ],
      },
      { name: 'readme.md', path: 'readme.md', isDirectory: false },
    ];
    const result = filterMarkdownTree(nodes, 'github');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  it('includes directories with empty children (lazy-loaded, not yet expanded)', () => {
    const nodes: FileNode[] = [
      {
        name: 'guides',
        path: 'guides',
        isDirectory: true,
        children: [],  // Empty from depth-1 lazy loading
      },
      { name: 'home.md', path: 'home.md', isDirectory: false },
    ];
    const result = filterMarkdownTree(nodes, 'github');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('guides');
  });

  it('includes directories with undefined children', () => {
    const nodes: FileNode[] = [
      {
        name: 'guides',
        path: 'guides',
        isDirectory: true,
        // children is undefined
      },
      { name: 'home.md', path: 'home.md', isDirectory: false },
    ];
    const result = filterMarkdownTree(nodes, 'github');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('guides');
  });

  it('in ADO mode, hides .order files and same-named .md files', () => {
    const nodes: FileNode[] = [
      {
        name: 'Architecture',
        path: 'Architecture',
        isDirectory: true,
        children: [],
      },
      { name: 'Architecture.md', path: 'Architecture.md', isDirectory: false },
      { name: '.order', path: '.order', isDirectory: false },
      { name: 'FAQ.md', path: 'FAQ.md', isDirectory: false },
    ];
    const result = filterMarkdownTree(nodes, 'ado');
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.name)).toEqual(['Architecture', 'FAQ.md']);
  });

  it('in ADO mode, shows nested directories with empty children', () => {
    const nodes: FileNode[] = [
      {
        name: 'Guides',
        path: 'Guides',
        isDirectory: true,
        children: [
          { name: 'Setup.md', path: 'Guides/Setup.md', isDirectory: false },
          {
            name: 'Advanced',
            path: 'Guides/Advanced',
            isDirectory: true,
            children: [],  // Lazy-loaded subdirectory
          },
        ],
      },
    ];
    const result = filterMarkdownTree(nodes, 'ado');
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children![1].name).toBe('Advanced');
  });
});

// ── wikiState navigation history tests ───────────────────────────────

describe('wikiState navigation history', () => {
  beforeEach(() => {
    wikiState.reset();
  });

  it('tracks navigation history when setSelectedPath is called', () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    wikiState.setSelectedPath('page3.md');
    expect(wikiState.canGoBack()).toBe(true);
  });

  it('goBack navigates to previous page', () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    wikiState.setSelectedPath('page3.md');

    wikiState.goBack();
    expect(wikiState.selectedPath).toBe('page2.md');

    wikiState.goBack();
    expect(wikiState.selectedPath).toBe('page1.md');
  });

  it('canGoBack returns false when at start of history', () => {
    expect(wikiState.canGoBack()).toBe(false);

    wikiState.setSelectedPath('page1.md');
    expect(wikiState.canGoBack()).toBe(false);

    wikiState.setSelectedPath('page2.md');
    expect(wikiState.canGoBack()).toBe(true);

    wikiState.goBack();
    expect(wikiState.canGoBack()).toBe(false);
  });

  it('navigating after goBack truncates forward history', () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    wikiState.setSelectedPath('page3.md');

    wikiState.goBack(); // at page2
    wikiState.setSelectedPath('page4.md'); // page3 should be dropped

    wikiState.goBack();
    expect(wikiState.selectedPath).toBe('page2.md');

    // Can't go forward to page3 anymore
    expect(wikiState.canGoBack()).toBe(true);
  });

  it('goBack notifies listeners', () => {
    const listener = vi.fn();
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    wikiState.subscribe(listener);

    wikiState.goBack();
    expect(listener).toHaveBeenCalled();
  });

  it('reset clears history', () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    wikiState.reset();

    expect(wikiState.canGoBack()).toBe(false);
    expect(wikiState.selectedPath).toBeNull();
  });

  it('setSelectedPath(null) does not add to history', () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath(null);
    expect(wikiState.canGoBack()).toBe(false);
  });
});

// ── WikiViewer back button tests ─────────────────────────────────────

describe('WikiViewer back button', () => {
  beforeEach(() => {
    wikiState.reset();
  });

  it('shows back button when there is navigation history', async () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    await screen.findByTestId('markdown-preview');
    expect(screen.getByTitle('Go back')).toBeInTheDocument();
  });

  it('back button is disabled when no history', async () => {
    wikiState.setSelectedPath('page1.md');
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    await screen.findByTestId('markdown-preview');
    const backBtn = screen.getByTitle('Go back');
    expect(backBtn).toBeDisabled();
  });

  it('clicking back button navigates to previous page', async () => {
    wikiState.setSelectedPath('page1.md');
    wikiState.setSelectedPath('page2.md');
    const api = createWikiAPI();
    render(<WikiViewer api={api} />);

    await screen.findByTestId('markdown-preview');
    const backBtn = screen.getByTitle('Go back');
    fireEvent.click(backBtn);

    await waitFor(() => {
      expect(wikiState.selectedPath).toBe('page1.md');
    });
  });
});
