import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

function createFilesAPI(overrides?: Partial<ReturnType<typeof createMockAPI>>) {
  return createMockAPI({
    files: {
      ...createMockAPI().files,
      readTree: vi.fn(async () => MOCK_TREE),
    },
    git: {
      ...createMockAPI().git,
      status: vi.fn(async () => [
        { path: 'src/index.ts', status: 'M', staged: false },
        { path: 'README.md', status: '?', staged: false },
        { path: 'deleted.ts', status: 'D', staged: true },
      ]),
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/project',
    },
    settings: {
      get: () => false,
      getAll: () => ({}),
      onChange: () => ({ dispose: () => {} }),
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
    const readTree = vi.fn(async () => MOCK_TREE);
    const api = createFilesAPI({
      files: { ...createMockAPI().files, readTree },
    });

    render(<FileTree api={api} />);
    await screen.findByText('src'); // wait for initial load

    const refreshBtn = screen.getByTitle('Refresh');
    fireEvent.click(refreshBtn);

    // readTree is called once on mount and once on refresh
    await waitFor(() => {
      expect(readTree).toHaveBeenCalledTimes(2);
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
      files: { ...createMockAPI().files, readTree: vi.fn(async () => MOCK_TREE), writeFile },
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
      files: { ...createMockAPI().files, readTree: vi.fn(async () => MOCK_TREE), delete: deleteFn },
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
});
