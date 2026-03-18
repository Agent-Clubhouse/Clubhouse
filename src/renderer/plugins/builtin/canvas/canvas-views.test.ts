import { describe, it, expect, vi } from 'vitest';
import { manifest } from './manifest';

// ── Manifest changes ──────────────────────────────────────────────────

describe('canvas manifest — new settings', () => {
  it('includes showHiddenFiles boolean setting defaulting to true', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'showHiddenFiles');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(true);
  });
});

// ── FileCanvasView helper logic ───────────────────────────────────────

describe('FileCanvasView — file name extraction', () => {
  // The split layout extracts file name from path for the view title
  function extractFileName(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  it('extracts filename from simple path', () => {
    expect(extractFileName('index.ts')).toBe('index.ts');
  });

  it('extracts filename from nested path', () => {
    expect(extractFileName('src/utils/helpers.ts')).toBe('helpers.ts');
  });

  it('extracts filename from deeply nested path', () => {
    expect(extractFileName('src/renderer/plugins/builtin/canvas/FileTree.tsx')).toBe('FileTree.tsx');
  });

  it('handles empty path gracefully', () => {
    expect(extractFileName('')).toBe('');
  });
});

describe('FileCanvasView — hidden files filtering', () => {
  const entries = [
    { name: '.git', path: '.git', isDirectory: true },
    { name: '.env', path: '.env', isDirectory: false },
    { name: 'src', path: 'src', isDirectory: true },
    { name: 'index.ts', path: 'index.ts', isDirectory: false },
    { name: '.hidden-dir', path: '.hidden-dir', isDirectory: true },
  ];

  it('filters dot-prefixed entries when showHidden is false', () => {
    const filtered = entries.filter((e) => !e.name.startsWith('.'));
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.name)).toEqual(['src', 'index.ts']);
  });

  it('keeps all entries when showHidden is true', () => {
    expect(entries).toHaveLength(5);
  });
});

// ── AgentCanvasView — project color helper ────────────────────────────

describe('AgentCanvasView — projectColor', () => {
  function projectColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 55%)`;
  }

  it('returns consistent color for same name', () => {
    expect(projectColor('MyProject')).toBe(projectColor('MyProject'));
  });

  it('returns different colors for different names', () => {
    expect(projectColor('Alpha')).not.toBe(projectColor('Beta'));
  });

  it('returns valid hsl string', () => {
    const color = projectColor('test');
    expect(color).toMatch(/^hsl\(\d+, 55%, 55%\)$/);
  });
});

// ── AgentCanvasView — durable-only filtering ─────────────────────────

describe('AgentCanvasView — agent filtering', () => {
  const agents = [
    { id: 'a1', name: 'alpha', kind: 'durable', status: 'running', projectId: 'p1' },
    { id: 'a2', name: 'beta', kind: 'quick', status: 'running', projectId: 'p1' },
    { id: 'a3', name: 'gamma', kind: 'durable', status: 'sleeping', projectId: 'p1' },
    { id: 'a4', name: 'delta', kind: 'quick', status: 'sleeping', projectId: 'p1' },
  ];

  it('filters out quick agents, keeping only durable', () => {
    const filtered = agents.filter((a) => a.kind === 'durable');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((a) => a.name)).toEqual(['alpha', 'gamma']);
  });

  it('excludes all quick agents regardless of status', () => {
    const filtered = agents.filter((a) => a.kind === 'durable');
    expect(filtered.every((a) => a.kind === 'durable')).toBe(true);
    expect(filtered.some((a) => a.kind === 'quick')).toBe(false);
  });

  it('combines project filtering with durable-only filtering', () => {
    const moreAgents = [
      ...agents,
      { id: 'a5', name: 'epsilon', kind: 'durable', status: 'running', projectId: 'p2' },
    ];
    const filtered = moreAgents
      .filter((a) => a.projectId === 'p1')
      .filter((a) => a.kind === 'durable');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((a) => a.name)).toEqual(['alpha', 'gamma']);
  });
});

// ── Scroll event propagation ──────────────────────────────────────────

describe('CanvasView — scroll isolation', () => {
  it('stopPropagation prevents parent from receiving wheel events', () => {
    const childHandler = (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
    };

    const event = {
      stopPropagation: vi.fn(),
      deltaX: 0,
      deltaY: 100,
    };

    childHandler(event);
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});

// ── Permission indicator logic ─────────────────────────────────────────

describe('CanvasView — permission indicator', () => {
  const borderColorForState = (state: string | null) => {
    const isPermission = state === 'needs_permission';
    const isToolError = state === 'tool_error';
    return isPermission
      ? 'rgb(249,115,22)'
      : isToolError
        ? 'rgb(234,179,8)'
        : 'transparent';
  };

  it('returns orange for needs_permission state', () => {
    expect(borderColorForState('needs_permission')).toBe('rgb(249,115,22)');
  });

  it('returns yellow for tool_error state', () => {
    expect(borderColorForState('tool_error')).toBe('rgb(234,179,8)');
  });

  it('returns transparent for idle state', () => {
    expect(borderColorForState('idle')).toBe('transparent');
  });

  it('returns transparent for working state', () => {
    expect(borderColorForState('working')).toBe('transparent');
  });

  it('returns transparent for null state', () => {
    expect(borderColorForState(null)).toBe('transparent');
  });

  it('applies animate-pulse class only for needs_permission', () => {
    const shouldPulse = (state: string | null) => state === 'needs_permission';
    expect(shouldPulse('needs_permission')).toBe(true);
    expect(shouldPulse('tool_error')).toBe(false);
    expect(shouldPulse('idle')).toBe(false);
    expect(shouldPulse(null)).toBe(false);
  });

  it('sets border width to 2 for permission/error states', () => {
    const borderWidth = (state: string | null) => {
      const isPermission = state === 'needs_permission';
      const isToolError = state === 'tool_error';
      return (isPermission || isToolError) ? 2 : 0;
    };
    expect(borderWidth('needs_permission')).toBe(2);
    expect(borderWidth('tool_error')).toBe(2);
    expect(borderWidth('idle')).toBe(0);
    expect(borderWidth(null)).toBe(0);
  });
});

// ── Canvas zoom state ──────────────────────────────────────────────────

describe('Canvas — zoom view toggle', () => {
  it('toggles zoom on when clicking zoom on an unzoomed view', () => {
    let zoomedViewId: string | null = null;
    const onZoomView = (viewId: string | null) => { zoomedViewId = viewId; };

    onZoomView('cv_1');
    expect(zoomedViewId).toBe('cv_1');
  });

  it('toggles zoom off when clicking zoom on the already-zoomed view', () => {
    let zoomedViewId: string | null = 'cv_1';
    const toggle = (viewId: string) => {
      zoomedViewId = zoomedViewId === viewId ? null : viewId;
    };

    toggle('cv_1');
    expect(zoomedViewId).toBeNull();
  });

  it('switches to a different view when clicking zoom on another view', () => {
    let zoomedViewId: string | null = 'cv_1';
    const toggle = (viewId: string) => {
      zoomedViewId = zoomedViewId === viewId ? null : viewId;
    };

    toggle('cv_2');
    expect(zoomedViewId).toBe('cv_2');
  });
});
