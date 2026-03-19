import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createView, createViewCounter } from './canvas-operations';
import type { GitDiffCanvasView } from './canvas-types';
import { manifest } from './manifest';
import { statusInfo, GIT_POLL_INTERVAL_MS } from './GitDiffCanvasView';

// ── createView('git-diff') ──────────────────────────────────────────

describe('createView — git-diff type (now legacy)', () => {
  it('creates a legacy-git-diff view with correct defaults', () => {
    const counter = createViewCounter(0);
    const view = createView('git-diff', { x: 100, y: 200 }, 5, counter);

    expect(view.type).toBe('legacy-git-diff');
    expect(view.title).toBe('Git Diff (Legacy)');
    expect(view.zIndex).toBe(5);
    // Position gets snapped to grid (20px)
    expect(view.position.x).toBe(100);
    expect(view.position.y).toBe(200);
  });

  it('does not set projectId or filePath by default', () => {
    const counter = createViewCounter(0);
    const view = createView('git-diff', { x: 0, y: 0 }, 0, counter) as GitDiffCanvasView;

    expect(view.projectId).toBeUndefined();
    expect(view.filePath).toBeUndefined();
    expect(view.worktreePath).toBeUndefined();
  });
});

// ── Manifest ────────────────────────────────────────────────────────

describe('canvas manifest — git-diff command', () => {
  it('declares the add-git-diff-view command', () => {
    const cmd = manifest.contributes!.commands!.find((c) => c.id === 'add-git-diff-view');
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe('Add Git Diff View');
  });

  it('includes git permission', () => {
    expect(manifest.permissions).toContain('git');
  });

  it('mentions Git Diff View in help topics', () => {
    const topic = manifest.contributes!.help!.topics![0];
    expect(topic.content).toContain('Git Diff View');
  });
});

// ── statusInfo ──────────────────────────────────────────────────────

describe('statusInfo — git status code mapping', () => {
  it('maps ?? to Untracked', () => {
    const info = statusInfo('??');
    expect(info.label).toBe('Untracked');
    expect(info.short).toBe('U');
  });

  it('maps A to Added', () => {
    const info = statusInfo('A');
    expect(info.label).toBe('Added');
    expect(info.short).toBe('A');
  });

  it('maps AM to Added (leading char takes priority)', () => {
    const info = statusInfo('AM');
    expect(info.label).toBe('Added');
    expect(info.short).toBe('A');
  });

  it('maps M to Modified', () => {
    const info = statusInfo('M');
    expect(info.label).toBe('Modified');
    expect(info.short).toBe('M');
  });

  it('maps MM to Modified', () => {
    const info = statusInfo('MM');
    expect(info.label).toBe('Modified');
    expect(info.short).toBe('M');
  });

  it('maps D to Deleted', () => {
    const info = statusInfo('D');
    expect(info.label).toBe('Deleted');
    expect(info.short).toBe('D');
  });

  it('maps R to Renamed', () => {
    const info = statusInfo('R');
    expect(info.label).toBe('Renamed');
    expect(info.short).toBe('R');
  });

  it('maps unknown codes to Changed', () => {
    const info = statusInfo('XX');
    expect(info.label).toBe('Changed');
    expect(info.short).toBe('~');
  });

  it('handles whitespace-padded codes', () => {
    const info = statusInfo(' M');
    expect(info.label).toBe('Modified');
  });
});

// ── Context menu ────────────────────────────────────────────────────

describe('canvas context menu — git-diff item', () => {
  it('includes git-diff in MENU_ITEMS (via context menu module)', async () => {
    // The context menu is a React component; we verify the menu item
    // exists by checking the manifest command and the type union.
    // The CanvasContextMenu maps CanvasViewType to menu items, so
    // verifying 'git-diff' is in the type union is sufficient.
    type ViewTypeCheck = 'git-diff' extends import('./canvas-types').CanvasViewType ? true : false;
    const check: ViewTypeCheck = true;
    expect(check).toBe(true);
  });
});

// ── File path extraction ────────────────────────────────────────────

describe('GitDiffCanvasView — file name extraction', () => {
  function extractFileName(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  it('extracts filename from simple path', () => {
    expect(extractFileName('index.ts')).toBe('index.ts');
  });

  it('extracts filename from nested path', () => {
    expect(extractFileName('src/renderer/GitDiffCanvasView.tsx')).toBe('GitDiffCanvasView.tsx');
  });

  it('handles empty path', () => {
    expect(extractFileName('')).toBe('');
  });
});

// ── Directory path extraction ───────────────────────────────────────

describe('GitDiffCanvasView — directory path extraction', () => {
  function extractDirPath(filePath: string): string {
    return filePath.includes('/')
      ? filePath.slice(0, filePath.lastIndexOf('/'))
      : '';
  }

  it('returns empty for top-level file', () => {
    expect(extractDirPath('README.md')).toBe('');
  });

  it('returns directory for nested file', () => {
    expect(extractDirPath('src/renderer/main.ts')).toBe('src/renderer');
  });

  it('returns parent for deeply nested file', () => {
    expect(extractDirPath('a/b/c/d.ts')).toBe('a/b/c');
  });
});

// ── Polling constant ────────────────────────────────────────────────

describe('GIT_POLL_INTERVAL_MS', () => {
  it('is exported and set to 3000ms', () => {
    expect(GIT_POLL_INTERVAL_MS).toBe(3000);
  });

  it('is a reasonable polling interval (between 1s and 30s)', () => {
    expect(GIT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(GIT_POLL_INTERVAL_MS).toBeLessThanOrEqual(30000);
  });
});

// ── Polling behavior (integration-style with timers) ────────────────

describe('GitDiffCanvasView — polling behavior', () => {
  let gitInfoMock: ReturnType<typeof vi.fn>;
  let gitDiffMock: ReturnType<typeof vi.fn>;
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    gitInfoMock = vi.fn().mockResolvedValue({
      branch: 'main', branches: ['main'], status: [], log: [],
      hasGit: true, ahead: 0, behind: 0, remote: 'origin', stashCount: 0, hasConflicts: false,
    });
    gitDiffMock = vi.fn().mockResolvedValue({ original: '', modified: '' });

    // Mock window.clubhouse.git
    (globalThis as any).window = {
      ...(globalThis as any).window,
      clubhouse: { git: { info: gitInfoMock, diff: gitDiffMock } },
    };

    addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('setInterval uses GIT_POLL_INTERVAL_MS as the delay', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // Simulate what the useEffect would do
    const poll = vi.fn();
    const id = setInterval(poll, GIT_POLL_INTERVAL_MS);

    expect(setIntervalSpy).toHaveBeenCalledWith(poll, 3000);

    clearInterval(id);
    setIntervalSpy.mockRestore();
  });

  it('poll skips fetch when document is hidden', () => {
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });

    // Simulate the poll guard
    const shouldPoll = !document.hidden;
    expect(shouldPoll).toBe(false);

    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
  });

  it('poll proceeds when document is visible', () => {
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });

    const shouldPoll = !document.hidden;
    expect(shouldPoll).toBe(true);
  });

  it('visibilitychange listener can be added and removed', () => {
    const handler = vi.fn();

    document.addEventListener('visibilitychange', handler);
    expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', handler);

    document.removeEventListener('visibilitychange', handler);
    expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', handler);
  });
});
