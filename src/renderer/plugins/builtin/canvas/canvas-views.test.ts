import { describe, it, expect, vi } from 'vitest';

// ── File viewer helper logic ───────────────────────────────────────

describe('File viewer — file name extraction', () => {
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

describe('File viewer — hidden files filtering', () => {
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

// ── AgentCanvasView — handlePickAgent sets displayName ───────────────

describe('AgentCanvasView — handlePickAgent updates displayName', () => {
  /**
   * Mirrors the logic in handlePickAgent: when a user picks an agent,
   * the onUpdate call must include displayName so the title bar reflects
   * the agent's real name instead of the default "Agent".
   */
  function buildPickUpdate(agent: { id: string; name?: string; projectId?: string; orchestrator?: string; model?: string }, project?: { name: string }) {
    const name = agent.name || agent.id;
    return {
      agentId: agent.id,
      projectId: agent.projectId,
      title: name,
      displayName: name,
      metadata: {
        agentId: agent.id,
        projectId: agent.projectId ?? null,
        agentName: agent.name ?? null,
        projectName: project?.name ?? null,
        orchestrator: agent.orchestrator ?? null,
        model: agent.model ?? null,
      },
    };
  }

  it('sets displayName to agent name when agent has a name', () => {
    const update = buildPickUpdate({ id: 'a1', name: 'faithful-urchin', projectId: 'p1' });
    expect(update.displayName).toBe('faithful-urchin');
    expect(update.title).toBe('faithful-urchin');
  });

  it('falls back to agent id when name is missing', () => {
    const update = buildPickUpdate({ id: 'a1', projectId: 'p1' });
    expect(update.displayName).toBe('a1');
    expect(update.title).toBe('a1');
  });

  it('falls back to agent id when name is empty string', () => {
    const update = buildPickUpdate({ id: 'a1', name: '', projectId: 'p1' });
    expect(update.displayName).toBe('a1');
    expect(update.title).toBe('a1');
  });

  it('displayName matches title so title bar shows the correct value', () => {
    const update = buildPickUpdate({ id: 'a1', name: 'my-agent', projectId: 'p1' });
    // CanvasView renders: view.displayName || view.title
    // Both must be set so the agent name is shown regardless of which takes precedence
    expect(update.displayName).toBe(update.title);
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

// ── AgentCanvasView — create agent flow ──────────────────────────────

describe('AgentCanvasView — create agent resolves active project', () => {
  const projects = [
    { id: 'p1', name: 'Project One', path: '/projects/p1' },
    { id: 'p2', name: 'Project Two', path: '/projects/p2' },
  ];

  function resolveProject(
    isAppMode: boolean,
    selectedProjectId: string | null,
    contextProjectId: string | undefined,
  ) {
    const pid = isAppMode ? selectedProjectId : contextProjectId;
    if (!pid) return null;
    return projects.find((p) => p.id === pid) ?? null;
  }

  it('resolves project from selection in app mode', () => {
    const project = resolveProject(true, 'p2', undefined);
    expect(project).toEqual(projects[1]);
  });

  it('resolves project from context in project mode', () => {
    const project = resolveProject(false, null, 'p1');
    expect(project).toEqual(projects[0]);
  });

  it('returns null when no project selected in app mode', () => {
    const project = resolveProject(true, null, undefined);
    expect(project).toBeNull();
  });

  it('returns null for unknown project id', () => {
    const project = resolveProject(false, null, 'unknown');
    expect(project).toBeNull();
  });
});

describe('AgentCanvasView — handleCreateDurable auto-assigns new agent', () => {
  it('finds the newly created agent by id and builds pick update', () => {
    const agents = [
      { id: 'a1', name: 'existing', kind: 'durable', status: 'running', projectId: 'p1' },
      { id: 'new-1', name: 'fresh-agent', kind: 'durable', status: 'sleeping', projectId: 'p1' },
    ];
    const newAgent = agents.find((a) => a.id === 'new-1')!;
    const name = newAgent.name || newAgent.id;
    const update = {
      agentId: newAgent.id,
      projectId: newAgent.projectId,
      title: name,
      displayName: name,
    };

    expect(update.agentId).toBe('new-1');
    expect(update.displayName).toBe('fresh-agent');
    expect(update.title).toBe('fresh-agent');
  });

  it('handles case when agent not found after creation', () => {
    const agents: any[] = [];
    const newAgent = agents.find((a: any) => a.id === 'new-1');
    expect(newAgent).toBeUndefined();
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

// ── Multi-directional resize logic ───────────────────────────────────

import { MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT } from './canvas-types';
import type { ResizeDirection } from './CanvasView';

/**
 * Extracted resize calculation — mirrors the logic in CanvasView's handleMouseMove
 * during a resize operation. Pure function for easy testing.
 */
function computeResize(
  direction: ResizeDirection,
  startW: number,
  startH: number,
  startX: number,
  startY: number,
  dx: number,
  dy: number,
): { width: number; height: number; x: number; y: number } {
  let newW = startW;
  let newH = startH;
  let newX = startX;
  let newY = startY;

  // East component
  if (direction === 'e' || direction === 'se' || direction === 'ne') {
    newW = startW + dx;
  }
  // West component
  if (direction === 'w' || direction === 'sw' || direction === 'nw') {
    newW = startW - dx;
    newX = startX + dx;
  }
  // South component
  if (direction === 's' || direction === 'se' || direction === 'sw') {
    newH = startH + dy;
  }
  // North component
  if (direction === 'n' || direction === 'ne' || direction === 'nw') {
    newH = startH - dy;
    newY = startY + dy;
  }

  // Enforce minimum size — clamp position if needed
  if (newW < MIN_VIEW_WIDTH) {
    if (direction === 'w' || direction === 'sw' || direction === 'nw') {
      newX = startX + startW - MIN_VIEW_WIDTH;
    }
    newW = MIN_VIEW_WIDTH;
  }
  if (newH < MIN_VIEW_HEIGHT) {
    if (direction === 'n' || direction === 'ne' || direction === 'nw') {
      newY = startY + startH - MIN_VIEW_HEIGHT;
    }
    newH = MIN_VIEW_HEIGHT;
  }

  return { width: newW, height: newH, x: newX, y: newY };
}

describe('CanvasView — multi-directional resize', () => {
  const startW = 480;
  const startH = 480;
  const startX = 100;
  const startY = 100;

  describe('east (e) — only width changes', () => {
    it('increases width when dragging right', () => {
      const r = computeResize('e', startW, startH, startX, startY, 50, 30);
      expect(r.width).toBe(530);
      expect(r.height).toBe(startH);
      expect(r.x).toBe(startX);
      expect(r.y).toBe(startY);
    });

    it('decreases width when dragging left, clamped to min', () => {
      const r = computeResize('e', startW, startH, startX, startY, -400, 0);
      expect(r.width).toBe(MIN_VIEW_WIDTH);
      expect(r.x).toBe(startX); // x never changes for east
    });
  });

  describe('west (w) — width and x change', () => {
    it('increases width when dragging left', () => {
      const r = computeResize('w', startW, startH, startX, startY, -50, 0);
      expect(r.width).toBe(530);
      expect(r.x).toBe(50);
      expect(r.y).toBe(startY);
    });

    it('clamps to min width and adjusts x', () => {
      const r = computeResize('w', startW, startH, startX, startY, 400, 0);
      expect(r.width).toBe(MIN_VIEW_WIDTH);
      expect(r.x).toBe(startX + startW - MIN_VIEW_WIDTH);
    });
  });

  describe('south (s) — only height changes', () => {
    it('increases height when dragging down', () => {
      const r = computeResize('s', startW, startH, startX, startY, 30, 60);
      expect(r.height).toBe(540);
      expect(r.width).toBe(startW);
      expect(r.y).toBe(startY);
    });
  });

  describe('north (n) — height and y change', () => {
    it('increases height when dragging up', () => {
      const r = computeResize('n', startW, startH, startX, startY, 0, -50);
      expect(r.height).toBe(530);
      expect(r.y).toBe(50);
      expect(r.x).toBe(startX);
    });

    it('clamps to min height and adjusts y', () => {
      const r = computeResize('n', startW, startH, startX, startY, 0, 400);
      expect(r.height).toBe(MIN_VIEW_HEIGHT);
      expect(r.y).toBe(startY + startH - MIN_VIEW_HEIGHT);
    });
  });

  describe('southeast (se) — width and height change', () => {
    it('increases both when dragging down-right', () => {
      const r = computeResize('se', startW, startH, startX, startY, 40, 60);
      expect(r.width).toBe(520);
      expect(r.height).toBe(540);
      expect(r.x).toBe(startX);
      expect(r.y).toBe(startY);
    });
  });

  describe('northwest (nw) — all four values change', () => {
    it('increases size when dragging up-left', () => {
      const r = computeResize('nw', startW, startH, startX, startY, -30, -40);
      expect(r.width).toBe(510);
      expect(r.height).toBe(520);
      expect(r.x).toBe(70);
      expect(r.y).toBe(60);
    });

    it('clamps to min and adjusts position for both axes', () => {
      const r = computeResize('nw', startW, startH, startX, startY, 500, 500);
      expect(r.width).toBe(MIN_VIEW_WIDTH);
      expect(r.height).toBe(MIN_VIEW_HEIGHT);
      expect(r.x).toBe(startX + startW - MIN_VIEW_WIDTH);
      expect(r.y).toBe(startY + startH - MIN_VIEW_HEIGHT);
    });
  });

  describe('northeast (ne) — width increases, height and y change', () => {
    it('increases width right, increases height up', () => {
      const r = computeResize('ne', startW, startH, startX, startY, 30, -40);
      expect(r.width).toBe(510);
      expect(r.height).toBe(520);
      expect(r.x).toBe(startX);
      expect(r.y).toBe(60);
    });
  });

  describe('southwest (sw) — height increases, width and x change', () => {
    it('increases height down, increases width left', () => {
      const r = computeResize('sw', startW, startH, startX, startY, -30, 40);
      expect(r.width).toBe(510);
      expect(r.height).toBe(520);
      expect(r.x).toBe(70);
      expect(r.y).toBe(startY);
    });
  });
});
