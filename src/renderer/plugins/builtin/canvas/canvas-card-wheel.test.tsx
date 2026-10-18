import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CanvasViewComponent } from './CanvasView';
import type { CanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

// A chat card's content: a transcript that scrolls, plus a strip that doesn't.
vi.mock('./AgentCanvasView', () => ({
  AgentCanvasView: () => (
    <div>
      <div data-testid="transcript" style={{ overflowY: 'auto', height: 100 }}>
        <p data-testid="message">old reply</p>
      </div>
      <div data-testid="status-strip">idle</div>
    </div>
  ),
}));

const view: CanvasView = {
  id: 'cv_wheel_1',
  type: 'agent',
  title: 'Agent',
  displayName: 'Wheel Test',
  position: { x: 100, y: 100 },
  size: { width: 400, height: 300 },
  zIndex: 0,
  metadata: {},
  agentId: 'agent_1',
} as CanvasView;

const api = {
  agents: { list: () => [], onAnyChange: () => ({ dispose: () => {} }), getDetailedStatus: () => null },
  projects: { list: () => [] },
  context: { mode: 'project', projectId: 'p1' },
  widgets: { AgentAvatar: () => null, AgentTerminal: () => null, SleepingAgent: () => null },
  settings: { get: () => undefined, getAll: () => ({}), set: () => {}, onChange: () => ({ dispose: () => {} }) },
} as unknown as PluginAPI;

const noop = () => {};

/** Stands in for the canvas's useViewportControls.handleWheel: pans, or zooms with Ctrl/Cmd. */
const canvasWheel = vi.fn();

function renderCard(isSelected: boolean, { overflows = true } = {}) {
  render(
    <div onWheel={(e) => canvasWheel(e.ctrlKey || e.metaKey ? 'zoom' : 'pan')}>
      <CanvasViewComponent
        view={view}
        api={api}
        isSelected={isSelected}
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
      />
    </div>,
  );
  const transcript = screen.getByTestId('transcript');
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: overflows ? 900 : 100 });
}

describe('canvas card wheel (#2111)', () => {
  beforeEach(() => canvasWheel.mockClear());

  it('scrolls a chat transcript in an unselected card without panning the canvas', () => {
    renderCard(false);
    fireEvent.wheel(screen.getByTestId('message'), { deltaY: 120 });
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it('keeps the wheel contained at the end of the transcript', () => {
    renderCard(false);
    const transcript = screen.getByTestId('transcript');
    transcript.scrollTop = 800; // scrolled to the bottom
    fireEvent.wheel(transcript, { deltaY: 120 });
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it('still zooms the canvas with Ctrl or Cmd over the transcript, selected or not', () => {
    renderCard(false);
    fireEvent.wheel(screen.getByTestId('message'), { deltaY: 120, ctrlKey: true });
    fireEvent.wheel(screen.getByTestId('message'), { deltaY: 120, metaKey: true });
    expect(canvasWheel.mock.calls).toEqual([['zoom'], ['zoom']]);
  });

  it('zooms with Ctrl over a selected card too', () => {
    renderCard(true);
    fireEvent.wheel(screen.getByTestId('message'), { deltaY: 120, ctrlKey: true });
    expect(canvasWheel.mock.calls).toEqual([['zoom']]);
  });

  it('pans the canvas from the card header', () => {
    renderCard(false);
    fireEvent.wheel(screen.getByTestId('canvas-view-titlebar'), { deltaY: 120 });
    expect(canvasWheel.mock.calls).toEqual([['pan']]);
  });

  it('pans from non-scrolling content in an unselected card', () => {
    renderCard(false);
    fireEvent.wheel(screen.getByTestId('status-strip'), { deltaY: 120 });
    expect(canvasWheel.mock.calls).toEqual([['pan']]);
  });

  it('pans over a transcript that has nothing to scroll', () => {
    renderCard(false, { overflows: false });
    fireEvent.wheel(screen.getByTestId('message'), { deltaY: 120 });
    expect(canvasWheel.mock.calls).toEqual([['pan']]);
  });

  it('contains every plain wheel over a selected card\'s content', () => {
    renderCard(true);
    fireEvent.wheel(screen.getByTestId('status-strip'), { deltaY: 120 });
    expect(canvasWheel).not.toHaveBeenCalled();
  });
});
