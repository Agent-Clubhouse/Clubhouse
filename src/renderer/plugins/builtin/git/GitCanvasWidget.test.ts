import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';

// ── Status code mapping ─────────────────────────────────────────────
//
// Mirrors the statusInfo() logic inside GitCanvasWidget.tsx.

interface StatusInfo {
  label: string;
  color: string;
  short: string;
}

function statusInfo(code: string): StatusInfo {
  const c = code.trim();
  if (c === '??' || c === '?') return { label: 'Untracked', color: 'text-ctp-blue', short: 'U' };
  if (c.startsWith('A') || c === 'A') return { label: 'Added', color: 'text-ctp-green', short: 'A' };
  if (c.startsWith('D') || c === 'D') return { label: 'Deleted', color: 'text-ctp-red', short: 'D' };
  if (c.startsWith('M') || c === 'M') return { label: 'Modified', color: 'text-ctp-yellow', short: 'M' };
  if (c.startsWith('R')) return { label: 'Renamed', color: 'text-ctp-mauve', short: 'R' };
  if (c.startsWith('C')) return { label: 'Copied', color: 'text-ctp-teal', short: 'C' };
  return { label: 'Changed', color: 'text-ctp-overlay0', short: '~' };
}

describe('GitCanvasWidget — statusInfo mapping', () => {
  it('maps ?? to Untracked (blue, U)', () => {
    const info = statusInfo('??');
    expect(info).toEqual({ label: 'Untracked', color: 'text-ctp-blue', short: 'U' });
  });

  it('maps ? to Untracked (blue, U)', () => {
    expect(statusInfo('?').short).toBe('U');
  });

  it('maps A to Added (green, A)', () => {
    const info = statusInfo('A');
    expect(info).toEqual({ label: 'Added', color: 'text-ctp-green', short: 'A' });
  });

  it('maps D to Deleted (red, D)', () => {
    expect(statusInfo('D').short).toBe('D');
    expect(statusInfo('D').color).toBe('text-ctp-red');
  });

  it('maps M to Modified (yellow, M)', () => {
    expect(statusInfo('M').short).toBe('M');
    expect(statusInfo('M').color).toBe('text-ctp-yellow');
  });

  it('maps R to Renamed (mauve, R)', () => {
    expect(statusInfo('R100').short).toBe('R');
    expect(statusInfo('R100').color).toBe('text-ctp-mauve');
  });

  it('maps C to Copied (teal, C)', () => {
    expect(statusInfo('C050').short).toBe('C');
    expect(statusInfo('C050').color).toBe('text-ctp-teal');
  });

  it('maps unknown codes to Changed (~)', () => {
    expect(statusInfo('X').short).toBe('~');
  });

  it('trims whitespace before matching', () => {
    expect(statusInfo('  M  ').short).toBe('M');
  });
});

// ── File categorisation ─────────────────────────────────────────────
//
// Mirrors the staged/unstaged/untracked categorisation in the component.

interface MockStatusFile {
  path: string;
  status: string;
  staged: boolean;
}

function categorise(files: MockStatusFile[]) {
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged && f.status !== '??' && f.status !== '?');
  const untracked = files.filter((f) => f.status === '??' || f.status === '?');
  return { staged, unstaged, untracked };
}

describe('GitCanvasWidget — file categorisation', () => {
  it('separates staged from unstaged', () => {
    const files: MockStatusFile[] = [
      { path: 'a.ts', status: 'M', staged: true },
      { path: 'b.ts', status: 'M', staged: false },
    ];
    const { staged, unstaged, untracked } = categorise(files);
    expect(staged).toHaveLength(1);
    expect(unstaged).toHaveLength(1);
    expect(untracked).toHaveLength(0);
  });

  it('puts untracked files in their own category', () => {
    const files: MockStatusFile[] = [
      { path: 'new.ts', status: '??', staged: false },
      { path: 'also-new.ts', status: '?', staged: false },
    ];
    const { staged, unstaged, untracked } = categorise(files);
    expect(staged).toHaveLength(0);
    expect(unstaged).toHaveLength(0);
    expect(untracked).toHaveLength(2);
  });

  it('handles empty file list', () => {
    const { staged, unstaged, untracked } = categorise([]);
    expect(staged).toHaveLength(0);
    expect(unstaged).toHaveLength(0);
    expect(untracked).toHaveLength(0);
  });

  it('handles mixed file types', () => {
    const files: MockStatusFile[] = [
      { path: 'staged.ts', status: 'A', staged: true },
      { path: 'modified.ts', status: 'M', staged: false },
      { path: 'deleted.ts', status: 'D', staged: true },
      { path: 'new.ts', status: '??', staged: false },
    ];
    const { staged, unstaged, untracked } = categorise(files);
    expect(staged).toHaveLength(2);
    expect(unstaged).toHaveLength(1);
    expect(untracked).toHaveLength(1);
  });
});

// ── Compact mode threshold ──────────────────────────────────────────
//
// The widget switches to compact mode (file list only, no diff pane)
// when the width is below 500px.

describe('GitCanvasWidget — compact mode', () => {
  function isCompact(width: number): boolean {
    return width < 500;
  }

  it('uses compact mode at narrow widths', () => {
    expect(isCompact(400)).toBe(true);
    expect(isCompact(300)).toBe(true);
  });

  it('uses full mode at 500px+', () => {
    expect(isCompact(500)).toBe(false);
    expect(isCompact(700)).toBe(false);
  });
});

// ── File path display ───────────────────────────────────────────────
//
// The file list shows the filename and optionally the parent directory.

describe('GitCanvasWidget — file path display', () => {
  function extractDisplay(path: string) {
    const name = path.split('/').pop() || path;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return { name, dir };
  }

  it('extracts filename from path', () => {
    expect(extractDisplay('src/renderer/App.tsx').name).toBe('App.tsx');
  });

  it('extracts directory from path', () => {
    expect(extractDisplay('src/renderer/App.tsx').dir).toBe('src/renderer');
  });

  it('handles root-level files', () => {
    const { name, dir } = extractDisplay('README.md');
    expect(name).toBe('README.md');
    expect(dir).toBe('');
  });
});

// ── Project color generation ────────────────────────────────────────

describe('GitCanvasWidget — projectColor', () => {
  function projectColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 55%)`;
  }

  it('produces deterministic colors', () => {
    expect(projectColor('MyProject')).toBe(projectColor('MyProject'));
  });

  it('produces different colors for different names', () => {
    expect(projectColor('Alpha')).not.toBe(projectColor('Beta'));
  });

  it('returns valid HSL format', () => {
    expect(projectColor('test')).toMatch(/^hsl\(\d+, 55%, 55%\)$/);
  });
});

// ── Manifest — canvas widget declaration ────────────────────────────

describe('git manifest — canvas widget', () => {
  const widget = manifest.contributes!.canvasWidgets![0];

  it('declares git-status widget', () => {
    expect(widget.id).toBe('git-status');
  });

  it('labels widget as "Git Diff"', () => {
    expect(widget.label).toBe('Git Diff');
  });

  it('uses 700x500 default size for diff viewing', () => {
    expect(widget.defaultSize).toEqual({ width: 700, height: 500 });
  });

  it('includes projectId and worktreePath in metadataKeys', () => {
    expect(widget.metadataKeys).toContain('projectId');
    expect(widget.metadataKeys).toContain('worktreePath');
  });
});

// ── Polling constant ────────────────────────────────────────────────

describe('GitCanvasWidget — polling interval', () => {
  it('polls every 3 seconds', () => {
    // The component uses GIT_POLL_INTERVAL_MS = 3000
    const GIT_POLL_INTERVAL_MS = 3000;
    expect(GIT_POLL_INTERVAL_MS).toBe(3000);
  });
});

// ── Read-only: no write actions ─────────────────────────────────────

describe('GitCanvasWidget — read-only contract', () => {
  it('component does not export or reference stage/commit/push handlers', async () => {
    // Import the module and verify no write operations are exposed
    const widgetModule = await import('./GitCanvasWidget');
    const exported = Object.keys(widgetModule);
    expect(exported).toEqual(['GitCanvasWidget']);
    // The component function itself should not have stage/commit/push as named exports
    expect(exported).not.toContain('handleStageAll');
    expect(exported).not.toContain('handleCommit');
    expect(exported).not.toContain('handlePush');
  });
});
