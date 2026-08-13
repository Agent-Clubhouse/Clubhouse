import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TopicDigest } from '../../../../shared/group-project-types';

// ---------- localStorage mock ----------
let storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => { storage[key] = val; },
    removeItem: (key: string) => { delete storage[key]; },
  },
  writable: true,
});

// ---------- ResizeObserver that reports an expanded (>500px) widget ----------
// The 3-pane ExpandedProjectView only renders once the widget's measured
// width crosses EXPANDED_WIDTH_THRESHOLD.
class WideResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 900, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: WideResizeObserver, writable: true });

const TOPIC: TopicDigest = {
  topic: 'general',
  messageCount: 1,
  newMessageCount: 0,
  latestTimestamp: '2026-07-25T10:00:00.000Z',
};

const MESSAGE = {
  id: 'msg_1_a',
  topic: 'general',
  sender: 'agent-1',
  body: 'hello world',
  timestamp: '2026-07-25T10:00:00.000Z',
};

vi.mock('./useGroupProjectContext', () => ({
  useGroupProjectContext: () => ({
    isRemote: false,
    satelliteId: null,
    project: { id: 'gp1', name: 'Test Project', description: '', instructions: '', metadata: {} },
    members: [],
    loaded: true,
    loadProjects: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    setPolling: vi.fn(async () => {}),
    fetchDigest: vi.fn(async () => [TOPIC]),
    fetchTopicMessages: vi.fn(async () => [MESSAGE]),
    fetchAllMessages: vi.fn(async () => [MESSAGE]),
    injectMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => true),
    deleteTopic: vi.fn(async () => true),
    setTopicProtection: vi.fn(async () => true),
    clearAllMessages: vi.fn(async () => ({ removed: 0 })),
    estimateTrim: vi.fn(async () => ({ wouldRemove: 0 })),
  }),
}));

vi.mock('../../../stores/mcpSettingsStore', () => ({
  useMcpSettingsStore: (sel: (s: unknown) => unknown) => sel({ enabled: true }),
}));

vi.mock('../../../hooks/useRemoteProject', () => ({
  useRemoteProject: () => ({ isRemote: false, satelliteId: null }),
}));

import { GroupProjectCanvasWidget } from './GroupProjectCanvasWidget';

function renderWidget() {
  return render(
    <div onWheel={onViewportChange} data-testid="workspace">
      <GroupProjectCanvasWidget
        widgetId="w1"
        api={{ context: { mode: 'app', projectId: undefined }, annex: {} } as never}
        metadata={{ groupProjectId: 'gp1' }}
        onUpdateMetadata={vi.fn()}
        size={{ width: 900, height: 600 }}
        {...({} as never)}
      />
    </div>,
  );
}

// #1545: Stands in for CanvasWorkspace's pan handler, which would call
// onViewportChange for any wheel event that bubbles up to it.
let onViewportChange: ReturnType<typeof vi.fn>;

describe('ExpandedProjectView — wheel containment (#1545)', () => {
  beforeEach(() => {
    storage = {};
    onViewportChange = vi.fn();
  });

  it('stops plain wheel propagation over the topics sidebar', async () => {
    renderWidget();
    await waitFor(() => expect(screen.getByText('general')).toBeInTheDocument());

    const sidebars = screen.getAllByTestId('group-project-panel-sidebar');
    fireEvent.wheel(sidebars[0], { deltaY: 120 });

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('stops plain wheel propagation over the message list', async () => {
    renderWidget();
    await waitFor(() => expect(screen.getByText('general')).toBeInTheDocument());

    const sidebars = screen.getAllByTestId('group-project-panel-sidebar');
    fireEvent.wheel(sidebars[1], { deltaY: 120 });

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('stops plain wheel propagation over the message detail pane', async () => {
    renderWidget();
    await waitFor(() => expect(screen.getByText('general')).toBeInTheDocument());

    const detail = screen.getByTestId('group-project-message-detail-scroll');
    fireEvent.wheel(detail, { deltaY: 120 });

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('lets Ctrl+wheel zoom gestures bubble past the message detail pane', async () => {
    renderWidget();
    await waitFor(() => expect(screen.getByText('general')).toBeInTheDocument());

    const detail = screen.getByTestId('group-project-message-detail-scroll');
    fireEvent.wheel(detail, { deltaY: 120, ctrlKey: true });

    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });
});
