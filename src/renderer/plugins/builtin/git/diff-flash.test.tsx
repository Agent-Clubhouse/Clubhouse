/**
 * Mission 70 — Regression tests for the "Loading diff..." flash bug.
 *
 * Bug: when a file was selected in the Git diff view and the user (or anything
 * else) caused git status to refresh, the diff pane would briefly flash
 * "Loading diff..." on every poll, even when the selected file was unchanged.
 *
 * Root cause: the diff-fetch useEffect listed `gitInfo` in its dependency
 * array, so every git status poll re-ran the effect, set loading=true, and
 * cleared the existing diff data — producing a visible flash.
 *
 * Fix: track a "fetch key" of (selectedFile, staged) in a ref. The loading
 * state and diff clear only happen when the fetch key actually changes
 * (i.e. the user really did switch files). Background refreshes silently
 * update diffData when the fetch resolves.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MainPanel } from './main';
import { GitCanvasWidget } from './GitCanvasWidget';
import { gitState } from './state';
import { createMockAPI } from '../../testing';
import type { GitInfo, GitStatusFile } from '../../../../shared/types';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';

// Mock the lazy Monaco editor — we don't need real Monaco to verify the
// flash behavior. The component renders <MonacoDiffEditor> when diffData is
// non-null, so we replace it with a marker we can assert against.
vi.mock('../canvas/MonacoDiffEditor', () => ({
  MonacoDiffEditor: ({ original, modified }: { original: string; modified: string }) =>
    React.createElement('div', {
      'data-testid': 'mock-monaco-diff',
      'data-original': original,
      'data-modified': modified,
    }, 'monaco-diff'),
}));

function makeGitInfo(overrides: Partial<GitInfo> = {}, status: GitStatusFile[] = []): GitInfo {
  return {
    branch: 'main',
    branches: ['main'],
    status,
    log: [],
    hasGit: true,
    ahead: 0,
    behind: 0,
    remote: 'origin',
    stashCount: 0,
    hasConflicts: false,
    ...overrides,
  };
}

describe('Mission 70 — git MainPanel diff flash', () => {
  beforeEach(() => {
    gitState.reset();
    gitState.setGitInfo(null);
    gitState.setSelectedFile(null);
    gitState.setSelectedCommit(null);
  });

  afterEach(() => {
    gitState.reset();
  });

  it('shows "Loading diff..." on first file selection, then renders the diff', async () => {
    const api = createMockAPI({
      context: { mode: 'project', projectId: 'p1', projectPath: '/proj' },
    });
    const diffSpy = vi.spyOn(window.clubhouse.git, 'diff').mockResolvedValue({
      original: 'old contents',
      modified: 'new contents',
    } as unknown as string);

    gitState.setGitInfo(makeGitInfo({}, [
      { path: 'src/foo.ts', status: 'M', staged: false },
    ]));

    render(React.createElement(MainPanel, { api }));

    // No file selected yet → no loading state, no diff
    expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-monaco-diff')).not.toBeInTheDocument();

    // Select a file → loading state appears synchronously (effect's setLoading)
    act(() => {
      gitState.setSelectedFile('src/foo.ts');
    });
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();

    // Diff resolves → loading state disappears, Monaco renders
    await waitFor(() => {
      expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
    expect(diffSpy).toHaveBeenCalledTimes(1);
    expect(diffSpy).toHaveBeenCalledWith('/proj', 'src/foo.ts', false);
  });

  it('does NOT show "Loading diff..." flash when git status polls and the selected file is unchanged', async () => {
    const api = createMockAPI({
      context: { mode: 'project', projectId: 'p1', projectPath: '/proj' },
    });
    vi.spyOn(window.clubhouse.git, 'diff').mockResolvedValue({
      original: 'A',
      modified: 'B',
    } as unknown as string);

    const initialStatus: GitStatusFile[] = [
      { path: 'src/foo.ts', status: 'M', staged: false },
      { path: 'src/bar.ts', status: 'M', staged: false },
    ];
    gitState.setGitInfo(makeGitInfo({}, initialStatus));

    render(React.createElement(MainPanel, { api }));

    // Select foo.ts and wait for first diff to load
    act(() => {
      gitState.setSelectedFile('src/foo.ts');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
    });
    expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();

    // Simulate a git status poll. New gitInfo object (different reference),
    // but the selected file's status is unchanged. Also throw in a new
    // unrelated file to mimic an "unrelated edit".
    const updatedStatus: GitStatusFile[] = [
      { path: 'src/foo.ts', status: 'M', staged: false },
      { path: 'src/bar.ts', status: 'M', staged: false },
      { path: 'src/baz.ts', status: '??', staged: false }, // unrelated new file
    ];
    act(() => {
      gitState.setGitInfo(makeGitInfo({}, updatedStatus));
    });

    // CRITICAL: Loading state must NOT reappear. The previous diff is still
    // visible while the background refetch happens silently.
    expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();

    // Let any pending background fetch settle, then re-check.
    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
    });
    expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
  });

  it('shows "Loading diff..." again when the user switches to a different file', async () => {
    const api = createMockAPI({
      context: { mode: 'project', projectId: 'p1', projectPath: '/proj' },
    });
    const diffSpy = vi.spyOn(window.clubhouse.git, 'diff').mockImplementation((async (_path: string, file: string) => ({
      original: `old:${file}`,
      modified: `new:${file}`,
    })) as never);

    gitState.setGitInfo(makeGitInfo({}, [
      { path: 'a.ts', status: 'M', staged: false },
      { path: 'b.ts', status: 'M', staged: false },
    ]));

    render(React.createElement(MainPanel, { api }));

    act(() => {
      gitState.setSelectedFile('a.ts');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
    });

    // Switch to b.ts — loading state should reappear (real file switch)
    act(() => {
      gitState.setSelectedFile('b.ts');
    });
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
    });
    const monaco = screen.getByTestId('mock-monaco-diff');
    expect(monaco.getAttribute('data-original')).toBe('old:b.ts');
    expect(diffSpy).toHaveBeenCalledTimes(2);
  });

  it('shows "Loading diff..." again when the same file changes staged status', async () => {
    const api = createMockAPI({
      context: { mode: 'project', projectId: 'p1', projectPath: '/proj' },
    });
    vi.spyOn(window.clubhouse.git, 'diff').mockResolvedValue({
      original: 'A',
      modified: 'B',
    } as unknown as string);

    gitState.setGitInfo(makeGitInfo({}, [
      { path: 'foo.ts', status: 'M', staged: false },
    ]));

    render(React.createElement(MainPanel, { api }));

    act(() => {
      gitState.setSelectedFile('foo.ts');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
    });

    // Same file, but now staged. fetchKey changes → loading reappears.
    act(() => {
      gitState.setGitInfo(makeGitInfo({}, [
        { path: 'foo.ts', status: 'M', staged: true },
      ]));
    });
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
    });
  });
});

describe('Mission 70 — GitCanvasWidget diff flash', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeProps(): CanvasWidgetComponentProps {
    const api = createMockAPI({
      context: { mode: 'project', projectId: 'p1', projectPath: '/proj' },
      projects: {
        list: () => [{ id: 'p1', name: 'proj', path: '/proj' }],
        getActive: () => ({ id: 'p1', name: 'proj', path: '/proj' }),
      },
    });
    return {
      widgetId: 'w1',
      api,
      metadata: { projectId: 'p1' },
      onUpdateMetadata: vi.fn(),
      size: { width: 800, height: 600 },
    } as unknown as CanvasWidgetComponentProps;
  }

  it('does NOT flash "Loading diff…" when poll fires with unchanged selected file', async () => {
    const props = makeProps();
    const baseStatus: GitStatusFile[] = [
      { path: 'src/foo.ts', status: 'M', staged: false },
    ];
    // Return a fresh gitInfo (new object reference) on every poll, to mimic
    // real polling. Also bump an unrelated field to make sure the change
    // wouldn't be deduped by reference equality.
    let pollIndex = 0;
    vi.spyOn(window.clubhouse.git, 'info').mockImplementation((async () => {
      pollIndex++;
      return makeGitInfo({ behind: pollIndex }, baseStatus.map((f) => ({ ...f })));
    }) as never);
    vi.spyOn(window.clubhouse.git, 'diff').mockResolvedValue({
      original: 'A',
      modified: 'B',
    } as unknown as string);

    render(React.createElement(GitCanvasWidget, props));

    // Wait for initial git info to populate the file list
    await waitFor(() => {
      expect(screen.getByTestId('file-src/foo.ts')).toBeInTheDocument();
    });

    // Click the file
    act(() => {
      screen.getByTestId('file-src/foo.ts').click();
    });

    // Wait for the initial diff to render
    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
    });
    expect(screen.queryByText('Loading diff…')).not.toBeInTheDocument();

    const pollCountBefore = pollIndex;

    // Advance the polling timer (GIT_POLL_INTERVAL_MS = 3000) — this triggers
    // git.info() → setGitInfo with a fresh object → diff effect re-runs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });

    // Confirm the poll actually fired
    expect(pollIndex).toBeGreaterThan(pollCountBefore);

    // CRITICAL: the diff must still be rendered, NOT "Loading diff…"
    expect(screen.queryByText('Loading diff…')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();

    // Advance again to be sure
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(screen.queryByText('Loading diff…')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-monaco-diff')).toBeInTheDocument();
  });
});
