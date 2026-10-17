import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SidebarPanel } from './main';
import { FileViewer, clearFileCache } from './FileViewer';
import { fileState } from './state';
import { createMockAPI } from '../../testing';
import { useChromeFlagStore } from '../../../chrome/chromeFlag';
import { useChromeStore } from '../../../chrome/chromeStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentStore } from '../../../stores/agentStore';
import { updateSavedContent } from './MonacoEditor';

// The editor shows the model key it was given, and keeps the last save callback.
let lastOnSave: ((content: string) => unknown) | null = null;
vi.mock('./MonacoEditor', () => ({
  MonacoEditor: ({ filePath, onSave }: { filePath: string; onSave?: (content: string) => unknown }) => {
    lastOnSave = onSave || null;
    return React.createElement('div', { 'data-testid': 'monaco-editor' }, filePath);
  },
  disposeModel: vi.fn(),
  disposeAllModels: vi.fn(),
  disposeCleanModels: vi.fn(),
  updateSavedContent: vi.fn(),
  getModelContent: vi.fn(() => 'draft'),
  isModelDirty: vi.fn(() => false),
  getOrCreateModel: vi.fn(),
}));

const PROJECT = { id: 'p1', name: 'Clubhouse', path: '/src/ch' };

function useScope(agentWorktree: string | undefined, projectScope: boolean) {
  useChromeFlagStore.setState({ enabled: true });
  useProjectStore.setState({ projects: [PROJECT] as never, activeProjectId: 'p1' });
  useAgentStore.setState({
    agents: { a1: { id: 'a1', projectId: 'p1', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'blue', worktreePath: agentWorktree } as never },
    activeAgentId: 'a1',
  });
  useChromeStore.setState({ projectScopeId: projectScope ? 'p1' : null });
}

function filesApi() {
  return createMockAPI({
    context: { mode: 'project', projectId: 'p1', projectPath: '/src/ch' },
    files: {
      ...createMockAPI().files,
      search: vi.fn(async () => ({ results: [], totalMatches: 0, truncated: false })),
      readFile: vi.fn(async () => 'root content'),
      stat: vi.fn(async () => ({ size: 10, isDirectory: false, isFile: true, modifiedAt: 1 })),
      readTree: vi.fn(async () => []),
      watch: vi.fn(() => ({ dispose: () => {} })),
      writeFile: vi.fn(async () => {}),
    },
    storage: { project: { read: vi.fn(async () => null), write: vi.fn(async () => {}) } } as never,
  });
}

beforeEach(() => {
  fileState.reset();
  clearFileCache();
  lastOnSave = null;
  window.clubhouse.file = {
    ...window.clubhouse.file,
    search: vi.fn(async () => ({
      results: [{ filePath: 'src/a.ts', matches: [{ line: 3, column: 1, length: 3, lineContent: 'foo()' }] }],
      totalMatches: 1,
      truncated: false,
    })),
    read: vi.fn(async () => 'worktree content'),
    write: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 10, isDirectory: false, isFile: true, modifiedAt: 2 })),
    readTree: vi.fn(async () => []),
    watchStart: vi.fn(async () => {}),
    watchStop: vi.fn(async () => {}),
    onWatchEvent: vi.fn(),
    offWatchEvent: vi.fn(),
  } as never;
  window.clubhouse.git = {
    ...window.clubhouse.git,
    info: vi.fn(async () => ({ branch: 'main', status: [], log: [] })),
  } as never;
});

afterEach(() => {
  useChromeFlagStore.setState({ enabled: false });
});

describe('Files search follows the scope (through the sidebar)', () => {
  it('searches the selected worktree and opens results at its paths', async () => {
    useScope('/src/ch/.clubhouse/agents/gs', false);
    const api = filesApi();
    render(<SidebarPanel api={api} />);

    act(() => fileState.setSearchMode(true));
    fireEvent.change(await screen.findByPlaceholderText('Search files...'), { target: { value: 'foo' } });

    await waitFor(() => {
      expect(window.clubhouse.file.search).toHaveBeenCalledWith('/src/ch/.clubhouse/agents/gs', 'foo', expect.anything());
    });
    expect(api.files.search).not.toHaveBeenCalled();

    // The result's path is project-relative, the same path the tree and viewer use.
    fireEvent.click(await screen.findByText('3'));
    expect(fileState.getActiveTab()?.filePath).toBe('.clubhouse/agents/gs/src/a.ts');
  });

  it('searches the project when the project is selected', async () => {
    useScope('/src/ch/.clubhouse/agents/gs', true);
    const api = filesApi();
    render(<SidebarPanel api={api} />);

    act(() => fileState.setSearchMode(true));
    fireEvent.change(await screen.findByPlaceholderText('Search files...'), { target: { value: 'foo' } });

    await waitFor(() => expect(api.files.search).toHaveBeenCalled());
    expect(window.clubhouse.file.search).not.toHaveBeenCalled();
  });
});

describe('Unsaved edits stay with their checkout', () => {
  it('gives the same relative path in the root and an outside worktree separate models, and saves to the right one', async () => {
    useScope('/elsewhere/gs', true);
    const api = filesApi();
    render(<FileViewer api={api} />);

    act(() => { fileState.openTab('src/a.ts'); });
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('/src/ch/src/a.ts');

    // Select the agent: its worktree lives outside the project.
    act(() => useChromeStore.setState({ projectScopeId: null }));
    act(() => { fileState.openTab('src/a.ts'); });
    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toHaveTextContent('/elsewhere/gs/src/a.ts'));
    expect(window.clubhouse.file.read).toHaveBeenCalledWith('/elsewhere/gs/src/a.ts');

    // Cmd+S in the worktree writes the worktree's file under the worktree's key.
    await act(async () => { await lastOnSave!('worktree edit'); });
    expect(window.clubhouse.file.write).toHaveBeenCalledWith('/elsewhere/gs/src/a.ts', 'worktree edit');
    expect(api.files.writeFile).not.toHaveBeenCalled();
    expect(updateSavedContent).toHaveBeenCalledWith('/elsewhere/gs/src/a.ts', 'worktree edit');
    expect(updateSavedContent).not.toHaveBeenCalledWith('/src/ch/src/a.ts', expect.anything());
  });
});

describe('FileTree between two worktrees outside the project', () => {
  function rootedApi(root: string) {
    return createMockAPI({
      context: { mode: 'project', projectId: 'p1', projectPath: root },
      files: {
        ...createMockAPI().files,
        readTree: vi.fn(async () => [
          { name: 'src', path: `${root}/src`, isDirectory: true, children: [] },
          { name: 'README.md', path: `${root}/README.md`, isDirectory: false },
        ]),
        watch: vi.fn(() => ({ dispose: () => {} })),
      },
      storage: { project: { read: vi.fn(async () => null), write: vi.fn(async () => {}) } } as never,
    });
  }

  it('resets selection and reads the new scope\'s expanded folders, though both roots are "."', async () => {
    const { FileTree } = await import('./FileTree');
    const a = rootedApi('/elsewhere/a');
    const { rerender } = render(<FileTree api={a} scopeRoot="." scopeKey="agent:a" />);
    await waitFor(() => expect(a.storage.project.read).toHaveBeenCalledWith('files:expandedPaths:agent:a'));

    // Select two items; the count only clears when the tree resets.
    fireEvent.click(await screen.findByText('README.md'), { metaKey: true });
    fireEvent.click(screen.getByText('src'), { metaKey: true });
    expect(await screen.findByTitle('2 items selected')).toBeInTheDocument();

    // FileViewer swaps the open tabs on a scope change; do the same here.
    act(() => { fileState.setScope('agent:b'); });
    const b = rootedApi('/elsewhere/b');
    rerender(<FileTree api={b} scopeRoot="." scopeKey="agent:b" />);
    await waitFor(() => expect(b.storage.project.read).toHaveBeenCalledWith('files:expandedPaths:agent:b'));
    await waitFor(() => expect(screen.queryByTitle('2 items selected')).toBeNull());
  });
});
