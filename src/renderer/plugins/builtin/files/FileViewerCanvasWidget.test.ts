import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';

// ── Worktree label generation ───────────────────────────────────────
//
// Mirrors the label logic used in the <select> dropdown inside
// FileViewerCanvasWidget.  Each worktree option shows either
// "/ (main)" for the bare/main worktree or the worktree directory label,
// optionally suffixed with the branch name.

describe('FileViewerCanvasWidget — worktree option label', () => {
  function worktreeOptionLabel(isBare: boolean, label: string, branch: string): string {
    const display = isBare ? '/ (main)' : label;
    return branch ? `${display} [${branch}]` : display;
  }

  it('shows "/ (main)" with branch for the main worktree', () => {
    expect(worktreeOptionLabel(true, 'project', 'main')).toBe('/ (main) [main]');
  });

  it('shows worktree label with branch for linked worktrees', () => {
    expect(worktreeOptionLabel(false, 'bouncy-salmon', 'bouncy-salmon/standby'))
      .toBe('bouncy-salmon [bouncy-salmon/standby]');
  });

  it('omits branch suffix when branch is empty', () => {
    expect(worktreeOptionLabel(false, 'detached-wt', '')).toBe('detached-wt');
  });

  it('shows "/ (main)" without suffix when branch is empty', () => {
    expect(worktreeOptionLabel(true, 'anything', '')).toBe('/ (main)');
  });
});

// ── Worktree selector visibility ────────────────────────────────────
//
// The <select> dropdown is only rendered when multiple worktrees exist.

describe('FileViewerCanvasWidget — worktree selector visibility', () => {
  function shouldShowWorktreeSelector(worktreeCount: number): boolean {
    return worktreeCount > 1;
  }

  it('hidden when no worktrees are returned', () => {
    expect(shouldShowWorktreeSelector(0)).toBe(false);
  });

  it('hidden when only one worktree (main)', () => {
    expect(shouldShowWorktreeSelector(1)).toBe(false);
  });

  it('shown when multiple worktrees exist', () => {
    expect(shouldShowWorktreeSelector(2)).toBe(true);
    expect(shouldShowWorktreeSelector(5)).toBe(true);
  });
});

// ── rootPath resolution ─────────────────────────────────────────────
//
// The widget resolves rootPath from metadata, falling back to the
// project's main path.  This ensures existing widgets (without rootPath
// in metadata) continue to work unchanged.

describe('FileViewerCanvasWidget — rootPath resolution', () => {
  function resolveRootPath(metadataRootPath: string | undefined | null, projectPath: string): string {
    return (metadataRootPath as string) || projectPath || '';
  }

  it('uses metadata rootPath when set', () => {
    expect(resolveRootPath('/worktree/bouncy-salmon', '/project/root')).toBe('/worktree/bouncy-salmon');
  });

  it('falls back to project path when no metadata rootPath', () => {
    expect(resolveRootPath(undefined, '/project/root')).toBe('/project/root');
  });

  it('falls back to project path when metadata rootPath is null', () => {
    expect(resolveRootPath(null, '/project/root')).toBe('/project/root');
  });

  it('returns empty string when neither is available', () => {
    expect(resolveRootPath(undefined, '')).toBe('');
  });
});

// ── Metadata updates on worktree switch ─────────────────────────────
//
// When the user selects a different worktree, filePath must be cleared
// (files are relative to the root) while rootPath is updated.

describe('FileViewerCanvasWidget — worktree switch metadata', () => {
  function computeWorktreeSwitchMetadata(wtPath: string) {
    return { rootPath: wtPath, filePath: null };
  }

  it('sets the new rootPath', () => {
    const meta = computeWorktreeSwitchMetadata('/new/worktree');
    expect(meta.rootPath).toBe('/new/worktree');
  });

  it('clears filePath', () => {
    const meta = computeWorktreeSwitchMetadata('/new/worktree');
    expect(meta.filePath).toBeNull();
  });
});

// ── Manifest — metadataKeys ─────────────────────────────────────────

describe('files manifest — file-viewer metadataKeys', () => {
  const widget = manifest.contributes!.canvasWidgets![0];

  it('includes rootPath in metadataKeys', () => {
    expect(widget.metadataKeys).toContain('rootPath');
  });

  it('still includes projectId and filePath', () => {
    expect(widget.metadataKeys).toContain('projectId');
    expect(widget.metadataKeys).toContain('filePath');
  });
});
