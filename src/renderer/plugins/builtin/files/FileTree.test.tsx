import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from './FileTree';
import { fileState } from './state';
import { createMockAPI } from '../../testing';
import type { FileNode } from '../../../../shared/types';

const MOCK_TREE: FileNode[] = [
  {
    name: 'src',
    path: '/project/src',
    isDirectory: true,
    children: [
      { name: 'index.ts', path: '/project/src/index.ts', isDirectory: false },
      { name: 'utils.ts', path: '/project/src/utils.ts', isDirectory: false },
    ],
  },
  { name: 'README.md', path: '/project/README.md', isDirectory: false },
  { name: 'package.json', path: '/project/package.json', isDirectory: false },
];

/** Creates a readTree mock that returns MOCK_TREE for root and [] for other paths (like worktree listing). */
function mockReadTree(overrideFn?: (...args: unknown[]) => Promise<FileNode[]>) {
  return vi.fn(async (path: string, _opts?: unknown) => {
    if (overrideFn) return overrideFn(path, _opts);
    // Return tree only for root path, empty for worktree listing
    if (path === '.' || path === '/project') return MOCK_TREE;
    return [];
  });
}

function createFilesAPI(overrides?: Partial<ReturnType<typeof createMockAPI>>) {
  const base = createMockAPI();
  return createMockAPI({
    files: {
      ...base.files,
      readTree: mockReadTree(),
      ...overrides?.files,
    },
    git: {
      ...base.git,
      status: vi.fn(async () => [
        { path: 'src/index.ts', status: 'M', staged: false },
        { path: 'README.md', status: '?', staged: false },
        { path: 'deleted.ts', status: 'D', staged: true },
      ]),
      currentBranch: vi.fn(async () => 'main'),
      ...overrides?.git,
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/project',
      ...overrides?.context,
    },
    settings: {
      get: () => false,
      getAll: () => ({}),
      onChange: () => ({ dispose: () => {} }),
      ...overrides?.settings,
    },
    storage: {
      ...base.storage,
      ...overrides?.storage,
    },
    ...overrides,
  });
}

describe('FileTree', () => {
  beforeEach(() => {
    fileState.reset();
  });

  it('renders tree from api.files.readTree()', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('shows directory chevrons, expand on click shows children', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    const srcDir = await screen.findByText('src');
    expect(srcDir).toBeInTheDocument();

    // Click the directory to expand
    fireEvent.click(srcDir);

    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });
  });

  it('clicking file calls fileState.setSelectedPath()', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    const readme = await screen.findByText('README.md');
    fireEvent.click(readme);

    expect(fileState.selectedPath).toBe('README.md');
  });

  it('refresh button calls api.files.readTree()', async () => {
    const readTree = mockReadTree();
    const api = createFilesAPI({
      files: { ...createMockAPI().files, readTree },
    });

    render(<FileTree api={api} />);
    await screen.findByText('src'); // wait for initial load

    const refreshBtn = screen.getByTitle('Refresh');
    fireEvent.click(refreshBtn);

    // readTree is called on mount (root + worktrees) and on refresh
    await waitFor(() => {
      const rootCalls = readTree.mock.calls.filter((c: unknown[]) => c[0] === '.');
      expect(rootCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows git status badges (M for modified, U for untracked)', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    // Expand src to see index.ts which has status 'M'
    const srcDir = await screen.findByText('src');
    fireEvent.click(srcDir);

    await waitFor(() => {
      expect(screen.getByText('M')).toBeInTheDocument(); // Modified
      expect(screen.getByText('U')).toBeInTheDocument(); // Untracked (? -> U)
    });
  });

  it('context menu: new file calls api.files.writeFile()', async () => {
    const writeFile = vi.fn(async () => {});
    const showInput = vi.fn(async () => 'newfile.ts');
    const api = createFilesAPI({
      files: { ...createMockAPI().files, readTree: mockReadTree(), writeFile },
      ui: { ...createMockAPI().ui, showInput },
    });

    render(<FileTree api={api} />);

    // Right-click on the src directory (which is a directory, so new file goes inside it)
    const srcDir = await screen.findByText('src');
    fireEvent.contextMenu(srcDir);

    await waitFor(() => {
      expect(screen.getByText('New File')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New File'));

    await waitFor(() => {
      expect(showInput).toHaveBeenCalledWith('File name');
      expect(writeFile).toHaveBeenCalledWith('src/newfile.ts', '');
    });
  });

  it('context menu: delete calls api.files.delete()', async () => {
    const deleteFn = vi.fn(async () => {});
    const showConfirm = vi.fn(async () => true);
    const api = createFilesAPI({
      files: { ...createMockAPI().files, readTree: mockReadTree(), delete: deleteFn },
      ui: { ...createMockAPI().ui, showConfirm },
    });

    render(<FileTree api={api} />);
    const readme = await screen.findByText('README.md');

    fireEvent.contextMenu(readme);

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(showConfirm).toHaveBeenCalled();
      expect(deleteFn).toHaveBeenCalledWith('README.md');
    });
  });

  it('keyboard nav: ArrowDown moves focus', async () => {
    const api = createFilesAPI();
    const { container } = render(<FileTree api={api} />);

    await screen.findByText('src');

    const treeContainer = container.querySelector('[tabindex="0"]')!;
    fireEvent.keyDown(treeContainer, { key: 'ArrowDown' });

    // Focus should move to the first item
    await waitFor(() => {
      const focused = container.querySelector('[class*="bg-ctp-surface0"]');
      expect(focused).not.toBeNull();
    });
  });

  it('shows branch indicator', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
    });
  });

  it('shows worktree branch when an agent worktree is selected', async () => {
    const currentBranch = vi.fn(async (subPath?: string) => {
      if (subPath === '.clubhouse/agents/my-agent') return 'my-agent/standby';
      return 'main';
    });
    const readTree = vi.fn(async (path: string) => {
      if (path === '.clubhouse/agents') {
        return [{ name: 'my-agent', path: '/project/.clubhouse/agents/my-agent', isDirectory: true }];
      }
      if (path === '.' || path === '.clubhouse/agents/my-agent') return MOCK_TREE;
      return [];
    });
    const api = createFilesAPI({
      files: { ...createMockAPI().files, readTree },
      git: { ...createMockAPI().git, currentBranch, status: vi.fn(async () => []) },
    });

    render(<FileTree api={api} />);

    // Wait for worktree selector to appear, then switch to agent worktree
    await waitFor(() => {
      expect(screen.getByTitle('Switch worktree root')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTitle('Switch worktree root'), {
      target: { value: '.clubhouse/agents/my-agent' },
    });

    await waitFor(() => {
      expect(screen.getByText('my-agent/standby')).toBeInTheDocument();
    });
    expect(currentBranch).toHaveBeenCalledWith('.clubhouse/agents/my-agent');
  });

  it('shows "No Worktree" when agent directory has no git info', async () => {
    const currentBranch = vi.fn(async (subPath?: string) => {
      if (subPath === '.clubhouse/agents/no-wt-agent') return '';
      return 'main';
    });
    const readTree = vi.fn(async (path: string) => {
      if (path === '.clubhouse/agents') {
        return [{ name: 'no-wt-agent', path: '/project/.clubhouse/agents/no-wt-agent', isDirectory: true }];
      }
      if (path === '.' || path === '.clubhouse/agents/no-wt-agent') return MOCK_TREE;
      return [];
    });
    const api = createFilesAPI({
      files: { ...createMockAPI().files, readTree },
      git: { ...createMockAPI().git, currentBranch, status: vi.fn(async () => []) },
    });

    render(<FileTree api={api} />);

    await waitFor(() => {
      expect(screen.getByTitle('Switch worktree root')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTitle('Switch worktree root'), {
      target: { value: '.clubhouse/agents/no-wt-agent' },
    });

    await waitFor(() => {
      expect(screen.getByText('No Worktree')).toBeInTheDocument();
    });
  });

  it('persists selected path to storage on file select', async () => {
    const write = vi.fn(async () => {});
    const api = createFilesAPI({
      storage: {
        ...createMockAPI().storage,
        project: {
          ...createMockAPI().storage.project,
          write,
        },
      },
    });

    render(<FileTree api={api} />);
    const readme = await screen.findByText('README.md');
    fireEvent.click(readme);

    await waitFor(() => {
      expect(write).toHaveBeenCalledWith('files:lastSelectedPath', 'README.md');
    });
  });

  it('shows toolbar buttons (new file, new folder, expand all, collapse all)', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    await screen.findByText('src');

    expect(screen.getByTitle('New File')).toBeInTheDocument();
    expect(screen.getByTitle('New Folder')).toBeInTheDocument();
    expect(screen.getByTitle('Expand All')).toBeInTheDocument();
    expect(screen.getByTitle('Collapse All')).toBeInTheDocument();
    expect(screen.getByTitle('Refresh')).toBeInTheDocument();
  });

  it('does not show the "changes won\'t appear" footer', async () => {
    const api = createFilesAPI();
    render(<FileTree api={api} />);

    await screen.findByText('src');

    expect(screen.queryByText(/changes made outside/i)).not.toBeInTheDocument();
  });
});

// ── Realistic shallow-load mock data ──────────────────────────────────

/** Root tree returned by readTree('.', { depth: 1 }) — directories have NO children */
const SHALLOW_ROOT: FileNode[] = [
  { name: 'src', path: '/project/src', isDirectory: true },
  { name: 'docs', path: '/project/docs', isDirectory: true },
  { name: 'README.md', path: '/project/README.md', isDirectory: false },
  { name: 'package.json', path: '/project/package.json', isDirectory: false },
];

/** Children returned when readTree('src', { depth: 1 }) is called */
const SRC_CHILDREN: FileNode[] = [
  { name: 'components', path: '/project/src/components', isDirectory: true },
  { name: 'index.ts', path: '/project/src/index.ts', isDirectory: false },
  { name: 'utils.ts', path: '/project/src/utils.ts', isDirectory: false },
];

/** Children of src/components */
const COMPONENTS_CHILDREN: FileNode[] = [
  { name: 'App.tsx', path: '/project/src/components/App.tsx', isDirectory: false },
  { name: 'Button.tsx', path: '/project/src/components/Button.tsx', isDirectory: false },
];

/** Children of docs */
const DOCS_CHILDREN: FileNode[] = [
  { name: 'guide.md', path: '/project/docs/guide.md', isDirectory: false },
];

/**
 * Realistic readTree mock that simulates depth:1 behavior:
 * - Root returns shallow nodes (no children on directories)
 * - Folder paths return that folder's children
 */
function realisticReadTree() {
  return vi.fn(async (path: string, _opts?: unknown) => {
    if (path === '.' || path === '/project') return SHALLOW_ROOT;
    if (path === 'src') return SRC_CHILDREN;
    if (path === 'src/components') return COMPONENTS_CHILDREN;
    if (path === 'docs') return DOCS_CHILDREN;
    if (path === '.clubhouse/agents') return [];
    return [];
  });
}

function createRealisticAPI(overrides?: Partial<ReturnType<typeof createMockAPI>>) {
  const base = createMockAPI();
  return createMockAPI({
    files: {
      ...base.files,
      readTree: realisticReadTree(),
      ...overrides?.files,
    },
    git: {
      ...base.git,
      status: vi.fn(async () => []),
      currentBranch: vi.fn(async () => 'main'),
      ...overrides?.git,
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/project',
      ...overrides?.context,
    },
    settings: {
      get: () => false,
      getAll: () => ({}),
      onChange: () => ({ dispose: () => {} }),
      ...overrides?.settings,
    },
    storage: { ...base.storage, ...overrides?.storage },
    ...overrides,
  });
}

// ── Folder expansion stability (bug fix) ──────────────────────────────

describe('FileTree — folder expansion stability', () => {
  beforeEach(() => {
    fileState.reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expanded folder children survive a loadTree refresh', async () => {
    const readTree = realisticReadTree();
    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    // Wait for initial shallow load
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument(); // No children yet

    // Expand src folder — triggers lazy load
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });

    // Trigger a refresh (simulates manual refresh button click)
    fireEvent.click(screen.getByTitle('Refresh'));

    // Children should still be visible after refresh
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });
  });

  it('file watcher refresh preserves expanded folder children', async () => {
    let watchCallback: (() => void) | null = null;
    const watch = vi.fn((_pattern: string, cb: () => void) => {
      watchCallback = cb;
      return { dispose: () => {} };
    });

    const readTree = realisticReadTree();
    const api = createRealisticAPI({
      files: { ...createMockAPI().files, readTree, watch },
    });
    render(<FileTree api={api} />);

    // Wait for initial load and expand src
    expect(await screen.findByText('src')).toBeInTheDocument();
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
    });

    // Simulate file watcher event (e.g., external file change)
    expect(watchCallback).not.toBeNull();
    watchCallback!();

    // Advance past the 500ms debounce
    await vi.advanceTimersByTimeAsync(600);

    // Children should still be visible
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });
  });

  it('multiple expanded folders all survive refresh', async () => {
    const readTree = realisticReadTree();
    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand src
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());

    // Expand docs
    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument());

    // Trigger refresh
    fireEvent.click(screen.getByTitle('Refresh'));

    // Both expanded folders should preserve their children
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
      expect(screen.getByText('guide.md')).toBeInTheDocument();
    });
  });

  it('collapsed folder does not re-expand after refresh', async () => {
    const readTree = realisticReadTree();
    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand then collapse src
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument());

    // Trigger refresh
    fireEvent.click(screen.getByTitle('Refresh'));

    // src should remain collapsed
    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
    });
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });

  it('file watcher debounces multiple rapid changes into one refresh', async () => {
    let watchCallback: (() => void) | null = null;
    const watch = vi.fn((_pattern: string, cb: () => void) => {
      watchCallback = cb;
      return { dispose: () => {} };
    });

    const readTree = realisticReadTree();
    const api = createRealisticAPI({
      files: { ...createMockAPI().files, readTree, watch },
    });
    render(<FileTree api={api} />);

    await screen.findByText('src');
    const callCountAfterMount = readTree.mock.calls.filter((c: unknown[]) => c[0] === '.').length;

    // Fire watcher 5 times in rapid succession
    for (let i = 0; i < 5; i++) {
      watchCallback!();
      await vi.advanceTimersByTimeAsync(100);
    }

    // Advance past the final 500ms debounce
    await vi.advanceTimersByTimeAsync(600);

    // Should have only triggered one additional root refresh, not 5
    const rootCallsAfter = readTree.mock.calls.filter((c: unknown[]) => c[0] === '.').length;
    expect(rootCallsAfter - callCountAfterMount).toBe(1);
  });
});

// ── File structure rendering ──────────────────────────────────────────

describe('FileTree — file structure rendering', () => {
  beforeEach(() => {
    fileState.reset();
  });

  it('renders root-level directories and files', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('directories do not show children until expanded', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('components')).not.toBeInTheDocument();
  });

  it('expanding a folder lazy-loads and shows its children', async () => {
    const readTree = realisticReadTree();
    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();
    fireEvent.click(screen.getByText('src'));

    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
      expect(screen.getByText('components')).toBeInTheDocument();
    });

    // readTree should have been called for 'src' to lazy-load children
    expect(readTree).toHaveBeenCalledWith('src', expect.objectContaining({ depth: 1 }));
  });

  it('collapsing a folder hides its children', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());

    // Collapse
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument());
  });

  it('nested folder expansion works (expand parent then child)', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand src
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('components')).toBeInTheDocument());

    // Expand src/components
    fireEvent.click(screen.getByText('components'));
    await waitFor(() => {
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    });
  });

  it('collapsing parent hides all nested children', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand src → components
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('components')).toBeInTheDocument());
    fireEvent.click(screen.getByText('components'));
    await waitFor(() => expect(screen.getByText('App.tsx')).toBeInTheDocument());

    // Collapse src — should hide components AND its children
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => {
      expect(screen.queryByText('components')).not.toBeInTheDocument();
      expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();
      expect(screen.queryByText('Button.tsx')).not.toBeInTheDocument();
    });
  });

  it('expand-collapse-expand cycle re-shows children', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());

    // Collapse
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument());

    // Re-expand — children should come back
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });
  });

  it('expand all shows all nested directory contents', async () => {
    // expandAll uses depth:10, so build a readTree that returns the full tree
    const fullTree: FileNode[] = [
      {
        name: 'src', path: '/project/src', isDirectory: true,
        children: [
          {
            name: 'components', path: '/project/src/components', isDirectory: true,
            children: COMPONENTS_CHILDREN,
          },
          { name: 'index.ts', path: '/project/src/index.ts', isDirectory: false },
          { name: 'utils.ts', path: '/project/src/utils.ts', isDirectory: false },
        ],
      },
      {
        name: 'docs', path: '/project/docs', isDirectory: true,
        children: DOCS_CHILDREN,
      },
      { name: 'README.md', path: '/project/README.md', isDirectory: false },
      { name: 'package.json', path: '/project/package.json', isDirectory: false },
    ];

    const readTree = vi.fn(async (path: string, opts?: { depth?: number }) => {
      if (path === '.clubhouse/agents') return [];
      // expandAll uses depth:10
      if ((path === '.' || path === '/project') && opts?.depth && opts.depth >= 10) return fullTree;
      if (path === '.' || path === '/project') return SHALLOW_ROOT;
      if (path === 'src') return SRC_CHILDREN;
      if (path === 'src/components') return COMPONENTS_CHILDREN;
      if (path === 'docs') return DOCS_CHILDREN;
      return [];
    });

    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Click expand all
    fireEvent.click(screen.getByTitle('Expand All'));

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
      expect(screen.getByText('components')).toBeInTheDocument();
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
      expect(screen.getByText('index.ts')).toBeInTheDocument();
      expect(screen.getByText('docs')).toBeInTheDocument();
      expect(screen.getByText('guide.md')).toBeInTheDocument();
    });
  });

  it('collapse all hides all expanded children', async () => {
    const api = createRealisticAPI();
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand src and docs
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());
    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument());

    // Collapse all
    fireEvent.click(screen.getByTitle('Collapse All'));

    await waitFor(() => {
      expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
      expect(screen.queryByText('utils.ts')).not.toBeInTheDocument();
      expect(screen.queryByText('guide.md')).not.toBeInTheDocument();
    });

    // Root items still visible
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('empty tree shows "No files found" message', async () => {
    const readTree = vi.fn(async () => []);
    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    await waitFor(() => {
      expect(screen.getByText('No files found')).toBeInTheDocument();
    });
  });

  it('keyboard Enter on directory toggles expansion', async () => {
    const api = createRealisticAPI();
    const { container } = render(<FileTree api={api} />);

    await screen.findByText('src');

    const treeContainer = container.querySelector('[tabindex="0"]')!;

    // Move focus to first item (src)
    fireEvent.keyDown(treeContainer, { key: 'ArrowDown' });

    // Press Enter to expand
    fireEvent.keyDown(treeContainer, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
    });

    // Press Enter again to collapse
    fireEvent.keyDown(treeContainer, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    });
  });

  it('nested expanded folders survive refresh after parent re-expand', async () => {
    const readTree = realisticReadTree();
    const api = createRealisticAPI({ files: { ...createMockAPI().files, readTree } });
    render(<FileTree api={api} />);

    expect(await screen.findByText('src')).toBeInTheDocument();

    // Expand src → components
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('components')).toBeInTheDocument());
    fireEvent.click(screen.getByText('components'));
    await waitFor(() => expect(screen.getByText('App.tsx')).toBeInTheDocument());

    // Refresh — both levels should survive
    fireEvent.click(screen.getByTitle('Refresh'));

    await waitFor(() => {
      expect(screen.getByText('components')).toBeInTheDocument();
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    });
  });
});
