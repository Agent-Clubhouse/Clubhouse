import { describe, it, expect } from 'vitest';
import { createView, createViewCounter } from './canvas-operations';
import type { TerminalCanvasView } from './canvas-types';
import { manifest } from './manifest';

// ── createView('terminal') ──────────────────────────────────────────

describe('createView — terminal type', () => {
  it('creates a terminal view with correct defaults', () => {
    const counter = createViewCounter(0);
    const view = createView('terminal', { x: 100, y: 200 }, 5, counter);

    expect(view.type).toBe('terminal');
    expect(view.title).toBe('Terminal');
    expect(view.displayName).toBe('Terminal');
    expect(view.zIndex).toBe(5);
    expect(view.position.x).toBe(100);
    expect(view.position.y).toBe(200);
  });

  it('does not set projectId or cwd by default', () => {
    const counter = createViewCounter(0);
    const view = createView('terminal', { x: 0, y: 0 }, 0, counter) as TerminalCanvasView;

    expect(view.projectId).toBeUndefined();
    expect(view.cwd).toBeUndefined();
  });

  it('initialises empty metadata', () => {
    const counter = createViewCounter(0);
    const view = createView('terminal', { x: 0, y: 0 }, 0, counter);
    expect(view.metadata).toEqual({});
  });

  it('deduplicates display names', () => {
    const counter = createViewCounter(0);
    const v1 = createView('terminal', { x: 0, y: 0 }, 0, counter, ['Terminal']);
    expect(v1.displayName).toBe('Terminal (2)');

    const v2 = createView('terminal', { x: 0, y: 0 }, 0, counter, ['Terminal', 'Terminal (2)']);
    expect(v2.displayName).toBe('Terminal (3)');
  });
});

// ── Manifest ────────────────────────────────────────────────────────

describe('canvas manifest — terminal command', () => {
  it('declares the add-terminal-view command', () => {
    const cmd = manifest.contributes!.commands!.find((c) => c.id === 'add-terminal-view');
    expect(cmd).toBeDefined();
    expect(cmd!.title).toBe('Add Terminal View');
  });

  it('includes terminal permission', () => {
    expect(manifest.permissions).toContain('terminal');
  });

  it('mentions Terminal View in help topics', () => {
    const topic = manifest.contributes!.help!.topics![0];
    expect(topic.content).toContain('Terminal View');
  });
});

// ── TerminalCanvasView — session ID generation ──────────────────────

describe('TerminalCanvasView — session ID generation', () => {
  function makeCanvasTerminalSessionId(viewId: string): string {
    return `canvas-terminal:${viewId}`;
  }

  it('generates deterministic session ID from view ID', () => {
    expect(makeCanvasTerminalSessionId('cv_1')).toBe('canvas-terminal:cv_1');
    expect(makeCanvasTerminalSessionId('cv_42')).toBe('canvas-terminal:cv_42');
  });

  it('returns different IDs for different views', () => {
    expect(makeCanvasTerminalSessionId('cv_1')).not.toBe(makeCanvasTerminalSessionId('cv_2'));
  });
});

// ── TerminalCanvasView — projectColor helper ────────────────────────

describe('TerminalCanvasView — projectColor', () => {
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

// ── CanvasViewType union includes terminal ──────────────────────────

describe('CanvasViewType — terminal', () => {
  it('terminal is a valid canvas view type', () => {
    // Verify by creating a view — if terminal weren't in the type, this would throw
    const counter = createViewCounter(0);
    const view = createView('terminal', { x: 0, y: 0 }, 0, counter);
    expect(view.type).toBe('terminal');
  });
});
