import { describe, it, expect } from 'vitest';
import type { AgentCanvasView } from './canvas-types';
import type { PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import {
  agentAttention,
  viewToScreenRect,
  isViewOffScreen,
  getOffScreenDirection,
  computeIndicatorPosition,
  computeOffScreenIndicators,
} from './canvas-attention';

// ── Factories ────────────────────────────────────────────────────────

function makeAgentView(overrides: Partial<AgentCanvasView> = {}): AgentCanvasView {
  return {
    id: 'v1',
    type: 'agent',
    position: { x: 100, y: 100 },
    size: { width: 480, height: 480 },
    title: 'Agent',
    displayName: 'Agent',
    zIndex: 0,
    metadata: {},
    agentId: 'a1',
    ...overrides,
  };
}

// ── agentAttention ───────────────────────────────────────────────────

describe('agentAttention', () => {
  it('returns warning for needs_permission', () => {
    const status: PluginAgentDetailedStatus = { state: 'needs_permission', message: 'Needs permission', toolName: 'Bash' };
    const att = agentAttention('v1', status);
    expect(att).toEqual({ level: 'warning', message: 'Needs permission', viewId: 'v1' });
  });

  it('returns error for tool_error', () => {
    const status: PluginAgentDetailedStatus = { state: 'tool_error', message: 'Bash failed', toolName: 'Bash' };
    const att = agentAttention('v1', status);
    expect(att).toEqual({ level: 'error', message: 'Bash failed', viewId: 'v1' });
  });

  it('returns null for idle', () => {
    const status: PluginAgentDetailedStatus = { state: 'idle', message: 'Thinking' };
    expect(agentAttention('v1', status)).toBeNull();
  });

  it('returns null for working', () => {
    const status: PluginAgentDetailedStatus = { state: 'working', message: 'Editing file', toolName: 'Edit' };
    expect(agentAttention('v1', status)).toBeNull();
  });

  it('returns null for null status', () => {
    expect(agentAttention('v1', null)).toBeNull();
  });
});

// ── viewToScreenRect ─────────────────────────────────────────────────

describe('viewToScreenRect', () => {
  it('maps canvas coordinates to screen space', () => {
    const view = makeAgentView({ position: { x: 100, y: 200 }, size: { width: 300, height: 400 } });
    const viewport = { panX: 50, panY: -100, zoom: 1 };
    const containerSize = { width: 1000, height: 800 };

    const rect = viewToScreenRect(view, viewport, containerSize);
    // left = (100 + 50) * 1 = 150
    // top = (200 + (-100)) * 1 = 100
    // right = 150 + 300 = 450
    // bottom = 100 + 400 = 500
    expect(rect).toEqual({ left: 150, top: 100, right: 450, bottom: 500 });
  });

  it('accounts for zoom', () => {
    const view = makeAgentView({ position: { x: 100, y: 100 }, size: { width: 200, height: 200 } });
    const viewport = { panX: 0, panY: 0, zoom: 2 };
    const containerSize = { width: 1000, height: 800 };

    const rect = viewToScreenRect(view, viewport, containerSize);
    // left = (100 + 0) * 2 = 200
    // top = (100 + 0) * 2 = 200
    // right = 200 + 200*2 = 600
    // bottom = 200 + 200*2 = 600
    expect(rect).toEqual({ left: 200, top: 200, right: 600, bottom: 600 });
  });
});

// ── isViewOffScreen ──────────────────────────────────────────────────

describe('isViewOffScreen', () => {
  const container = { width: 1000, height: 800 };

  it('returns false when view is within viewport', () => {
    expect(isViewOffScreen({ left: 100, top: 100, right: 500, bottom: 500 }, container)).toBe(false);
  });

  it('returns true when view is fully left of viewport', () => {
    expect(isViewOffScreen({ left: -500, top: 100, right: -10, bottom: 500 }, container)).toBe(true);
  });

  it('returns true when view is fully above viewport', () => {
    expect(isViewOffScreen({ left: 100, top: -500, right: 500, bottom: -10 }, container)).toBe(true);
  });

  it('returns true when view is fully right of viewport', () => {
    expect(isViewOffScreen({ left: 1100, top: 100, right: 1500, bottom: 500 }, container)).toBe(true);
  });

  it('returns true when view is fully below viewport', () => {
    expect(isViewOffScreen({ left: 100, top: 900, right: 500, bottom: 1300 }, container)).toBe(true);
  });

  it('returns false when view is partially visible', () => {
    expect(isViewOffScreen({ left: -100, top: 100, right: 200, bottom: 500 }, container)).toBe(false);
  });
});

// ── getOffScreenDirection ────────────────────────────────────────────

describe('getOffScreenDirection', () => {
  const container = { width: 1000, height: 800 };

  it('returns "top" when view is above', () => {
    expect(getOffScreenDirection({ left: 400, top: -300, right: 600, bottom: -100 }, container)).toBe('top');
  });

  it('returns "bottom" when view is below', () => {
    expect(getOffScreenDirection({ left: 400, top: 900, right: 600, bottom: 1100 }, container)).toBe('bottom');
  });

  it('returns "left" when view is to the left', () => {
    expect(getOffScreenDirection({ left: -500, top: 300, right: -200, bottom: 500 }, container)).toBe('left');
  });

  it('returns "right" when view is to the right', () => {
    expect(getOffScreenDirection({ left: 1200, top: 300, right: 1500, bottom: 500 }, container)).toBe('right');
  });

  it('returns "top-left" for upper-left corner', () => {
    expect(getOffScreenDirection({ left: -500, top: -300, right: -200, bottom: -100 }, container)).toBe('top-left');
  });

  it('returns "bottom-right" for lower-right corner', () => {
    expect(getOffScreenDirection({ left: 1200, top: 900, right: 1500, bottom: 1100 }, container)).toBe('bottom-right');
  });
});

// ── computeIndicatorPosition ─────────────────────────────────────────

describe('computeIndicatorPosition', () => {
  const container = { width: 1000, height: 800 };

  it('places top indicators at y=8', () => {
    const { screenY } = computeIndicatorPosition(
      { left: 400, top: -300, right: 600, bottom: -100 }, container, 'top',
    );
    expect(screenY).toBe(8);
  });

  it('places bottom indicators near bottom edge', () => {
    const { screenY } = computeIndicatorPosition(
      { left: 400, top: 900, right: 600, bottom: 1100 }, container, 'bottom',
    );
    expect(screenY).toBe(792); // 800 - 8
  });

  it('places left indicators at x=8', () => {
    const { screenX } = computeIndicatorPosition(
      { left: -500, top: 300, right: -200, bottom: 500 }, container, 'left',
    );
    expect(screenX).toBe(8);
  });

  it('clamps x position within padded bounds', () => {
    const { screenX } = computeIndicatorPosition(
      { left: -500, top: -300, right: -200, bottom: -100 }, container, 'top',
    );
    // cx = (-500 + -200)/2 = -350, clamped to pad=24
    expect(screenX).toBe(24);
  });
});

// ── computeOffScreenIndicators ───────────────────────────────────────

describe('computeOffScreenIndicators', () => {
  const container = { width: 1000, height: 800 };
  const viewport = { panX: 0, panY: 0, zoom: 1 };

  it('returns empty array when no views need attention', () => {
    const views = [makeAgentView()];
    const attentionMap = new Map();
    expect(computeOffScreenIndicators(views, attentionMap, viewport, container)).toEqual([]);
  });

  it('returns empty when attention view is on-screen', () => {
    const view = makeAgentView({ position: { x: 100, y: 100 }, size: { width: 200, height: 200 } });
    const attentionMap = new Map([['v1', { level: 'warning' as const, message: 'test', viewId: 'v1' }]]);
    expect(computeOffScreenIndicators([view], attentionMap, viewport, container)).toEqual([]);
  });

  it('returns indicator for attention view that is off-screen', () => {
    const view = makeAgentView({ position: { x: -1000, y: 100 }, size: { width: 200, height: 200 } });
    const attentionMap = new Map([['v1', { level: 'warning' as const, message: 'test', viewId: 'v1' }]]);
    const indicators = computeOffScreenIndicators([view], attentionMap, viewport, container);
    expect(indicators).toHaveLength(1);
    expect(indicators[0].viewId).toBe('v1');
    expect(indicators[0].direction).toBe('left');
  });

  it('skips views not in attention map', () => {
    const view = makeAgentView({ position: { x: -1000, y: 100 }, size: { width: 200, height: 200 } });
    const attentionMap = new Map();
    expect(computeOffScreenIndicators([view], attentionMap, viewport, container)).toEqual([]);
  });
});
