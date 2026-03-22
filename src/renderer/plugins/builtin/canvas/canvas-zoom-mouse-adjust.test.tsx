import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { CanvasViewComponent } from './CanvasView';
import type { CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

// ── Fixtures ────────────────────────────────────────────────────────────

const baseView: CanvasView = {
  id: 'cv_zoom_1',
  type: 'agent',
  title: 'Agent',
  displayName: 'Zoom Test',
  position: { x: 100, y: 100 },
  size: { width: 400, height: 300 },
  zIndex: 0,
  metadata: {},
  agentId: 'agent_1',
} as CanvasView;

function stubApi(): PluginAPI {
  return {
    agents: {
      list: () => [],
      onAnyChange: () => ({ dispose: () => {} }),
      getDetailedStatus: () => null,
    },
    projects: { list: () => [] },
    context: { mode: 'project', projectId: 'p1' },
    widgets: {
      AgentAvatar: () => null,
      AgentTerminal: () => null,
      SleepingAgent: () => null,
    },
    settings: {
      get: () => undefined,
      getAll: () => ({}),
      set: () => {},
      onChange: () => ({ dispose: () => {} }),
    },
  } as unknown as PluginAPI;
}

const noop = () => {};

// ── Tests ────────────────────────────────────────────────────────────────

describe('canvas zoom mouse coordinate adjustment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function renderView(zoom: number) {
    return render(
      <CanvasViewComponent
        view={baseView}
        api={stubApi()}
        zoom={zoom}
        isSelected={false}
        onClose={noop}
        onFocus={noop}
        onSelect={noop}
        onToggleSelect={noop}
        onCenterView={noop}
        onZoomView={noop}
        onDragStart={noop}
        onDragEnd={noop}
        onResizeEnd={noop}
        onUpdate={noop}
      />,
    );
  }

  /**
   * Helper: dispatch a MouseEvent on a target element and return the
   * clientX/clientY that downstream listeners would see.  We add a
   * bubble-phase listener (which fires AFTER the capture-phase adjuster)
   * to read the final property values.
   */
  function dispatchAndCapture(
    target: Element,
    type: string,
    clientX: number,
    clientY: number,
  ): { clientX: number; clientY: number } {
    const result = { clientX: 0, clientY: 0 };

    // Bubble-phase listener reads the (possibly overridden) values
    const listener = (e: Event) => {
      const me = e as MouseEvent;
      result.clientX = me.clientX;
      result.clientY = me.clientY;
    };
    target.addEventListener(type, listener, false);

    const event = new MouseEvent(type, {
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);

    target.removeEventListener(type, listener, false);
    return result;
  }

  it('does not adjust mouse coordinates at zoom = 1', () => {
    const { container } = renderView(1);
    const contentArea = container.querySelector('.flex-1.min-h-0.overflow-hidden');
    expect(contentArea).toBeTruthy();

    // Mock getBoundingClientRect on the content area
    vi.spyOn(contentArea!, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      right: 500,
      bottom: 350,
      width: 400,
      height: 300,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    const captured = dispatchAndCapture(contentArea!, 'mousedown', 300, 200);
    expect(captured.clientX).toBe(300);
    expect(captured.clientY).toBe(200);
  });

  it('adjusts mouse coordinates at zoom < 1 (e.g. 0.5)', () => {
    const { container } = renderView(0.5);
    const contentArea = container.querySelector('.flex-1.min-h-0.overflow-hidden');
    expect(contentArea).toBeTruthy();

    // At zoom 0.5 the element's visual bounds are scaled:
    // layout (100,50)→(500,350) → visual (50,25)→(250,175)
    // getBoundingClientRect returns the scaled visual bounds.
    vi.spyOn(contentArea!, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      top: 25,
      right: 250,
      bottom: 175,
      width: 200,
      height: 150,
      x: 50,
      y: 25,
      toJSON: () => {},
    });

    // Click at screen position (150, 100) which is offset (100, 75) from visual left/top.
    // Adjusted: left + offset/zoom = 50 + 100/0.5 = 250, 25 + 75/0.5 = 175
    const captured = dispatchAndCapture(contentArea!, 'mousedown', 150, 100);
    expect(captured.clientX).toBe(250);
    expect(captured.clientY).toBe(175);
  });

  it('adjusts mouse coordinates at zoom > 1 (e.g. 2.0)', () => {
    const { container } = renderView(2);
    const contentArea = container.querySelector('.flex-1.min-h-0.overflow-hidden');
    expect(contentArea).toBeTruthy();

    // At zoom 2 the visual bounds are doubled:
    // layout (100,50)→(500,350) → visual (200,100)→(1000,700)
    vi.spyOn(contentArea!, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 100,
      right: 1000,
      bottom: 700,
      width: 800,
      height: 600,
      x: 200,
      y: 100,
      toJSON: () => {},
    });

    // Click at screen (600, 400) → offset (400, 300) from visual left/top.
    // Adjusted: 200 + 400/2 = 400, 100 + 300/2 = 250
    const captured = dispatchAndCapture(contentArea!, 'mousedown', 600, 400);
    expect(captured.clientX).toBe(400);
    expect(captured.clientY).toBe(250);
  });

  it('adjusts all mouse event types', () => {
    const { container } = renderView(0.5);
    const contentArea = container.querySelector('.flex-1.min-h-0.overflow-hidden');
    expect(contentArea).toBeTruthy();

    vi.spyOn(contentArea!, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      top: 25,
      right: 250,
      bottom: 175,
      width: 200,
      height: 150,
      x: 50,
      y: 25,
      toJSON: () => {},
    });

    const eventTypes = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu'];
    for (const type of eventTypes) {
      const captured = dispatchAndCapture(contentArea!, type, 150, 100);
      expect(captured.clientX).toBe(250);
      expect(captured.clientY).toBe(175);
    }
  });

  it('adjusts coordinates on child elements (events bubble up)', () => {
    const { container } = renderView(0.75);
    const contentArea = container.querySelector('.flex-1.min-h-0.overflow-hidden');
    expect(contentArea).toBeTruthy();

    // At zoom 0.75: visual bounds scaled
    vi.spyOn(contentArea!, 'getBoundingClientRect').mockReturnValue({
      left: 75,
      top: 37.5,
      right: 375,
      bottom: 262.5,
      width: 300,
      height: 225,
      x: 75,
      y: 37.5,
      toJSON: () => {},
    });

    // Create a child element to dispatch from — simulates xterm.js's screen element
    const child = document.createElement('div');
    contentArea!.appendChild(child);

    // Click at (225, 150) → offset from content area (150, 112.5)
    // Adjusted: 75 + 150/0.75 = 275, 37.5 + 112.5/0.75 = 187.5
    const captured = dispatchAndCapture(child, 'mousedown', 225, 150);
    expect(captured.clientX).toBe(275);
    expect(captured.clientY).toBe(187.5);

    contentArea!.removeChild(child);
  });
});
