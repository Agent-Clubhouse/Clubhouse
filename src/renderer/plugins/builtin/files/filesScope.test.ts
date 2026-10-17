import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scopeFilesApi } from './filesScope';
import { fileState } from './state';
import { tabStateKey } from './FileViewer';
import { createMockAPI } from '../../testing';

function projectApi() {
  return createMockAPI({
    context: { mode: 'project', projectId: 'p1', projectPath: '/src/ch' },
  });
}

describe('scopeFilesApi', () => {
  beforeEach(() => {
    window.clubhouse.file = {
      ...window.clubhouse.file,
      search: vi.fn(async () => ({ results: [{ filePath: 'src/a.ts', matches: [] }], totalMatches: 0, truncated: false })),
      readTree: vi.fn(async () => []),
    } as never;
    window.clubhouse.git = {
      ...window.clubhouse.git,
      info: vi.fn(async () => ({ branch: 'gallant-swift/rows', status: [{ path: 'src/a.ts', status: 'M', staged: false }], log: [] })),
    } as never;
  });

  it('returns the same api for the project root', () => {
    const api = projectApi();
    expect(scopeFilesApi(api, '/src/ch')).toBe(api);
  });

  it('runs search and git in a worktree inside the project, mapping paths back to project-relative', async () => {
    const api = projectApi();
    const scoped = scopeFilesApi(api, '/src/ch/.clubhouse/agents/gs');

    const result = await scoped.files.search('x');
    expect(window.clubhouse.file.search).toHaveBeenCalledWith('/src/ch/.clubhouse/agents/gs', 'x', undefined);
    expect(result.results[0].filePath).toBe('.clubhouse/agents/gs/src/a.ts');

    const status = await scoped.git.status();
    expect(window.clubhouse.git.info).toHaveBeenCalledWith('/src/ch/.clubhouse/agents/gs');
    expect(status[0].path).toBe('.clubhouse/agents/gs/src/a.ts');
    expect(await scoped.git.currentBranch()).toBe('gallant-swift/rows');

    // Everything else still reads through the project api
    expect(scoped.context.projectPath).toBe('/src/ch');
    expect(scoped.files.readTree).toBe(api.files.readTree);
  });

  it('rebases the whole api on a worktree outside the project', async () => {
    const api = projectApi();
    const scoped = scopeFilesApi(api, '/elsewhere/gs');

    expect(scoped.context.projectPath).toBe('/elsewhere/gs');
    await scoped.files.readTree('src');
    expect(window.clubhouse.file.readTree).toHaveBeenCalledWith('/elsewhere/gs/src', undefined);
    const status = await scoped.git.status();
    expect(status[0].path).toBe('src/a.ts');
  });
});

describe('fileState.setScope', () => {
  beforeEach(() => fileState.reset());

  it('keeps each scope\'s tabs apart and brings them back', () => {
    fileState.openTab('README.md');
    expect(fileState.setScope('agent:a1')).toBe(true);
    expect(fileState.openTabs).toHaveLength(0);
    expect(fileState.selectedPath).toBeNull();

    fileState.openTab('.clubhouse/agents/gs/src/a.ts');
    expect(fileState.setScope(null)).toBe(false);
    expect(fileState.getOrderedTabs().map((t) => t.filePath)).toEqual(['README.md']);
    expect(fileState.selectedPath).toBe('README.md');

    expect(fileState.setScope('agent:a1')).toBe(false);
    expect(fileState.getActiveTab()?.filePath).toBe('.clubhouse/agents/gs/src/a.ts');
  });

  it('is a no-op for the current scope', () => {
    const listener = vi.fn();
    fileState.subscribe(listener);
    expect(fileState.setScope(null)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('counts unsaved tabs in other scopes toward isDirty', () => {
    const tab = fileState.openTab('README.md');
    fileState.setTabDirty(tab.id, true);
    fileState.setScope('agent:a1');
    expect(fileState.isDirty).toBe(true);
  });
});

describe('tabStateKey', () => {
  it('keeps the original key for the project root', () => {
    expect(tabStateKey(null)).toBe('files:tabState');
    expect(tabStateKey('agent:a1')).toBe('files:tabState:agent:a1');
  });
});
