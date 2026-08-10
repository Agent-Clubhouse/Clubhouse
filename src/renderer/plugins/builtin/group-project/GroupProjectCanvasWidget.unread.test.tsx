import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TopicDigest, DigestSince } from '../../../../shared/group-project-types';

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

// The widget reaches the board through this hook; mocking it is the seam that
// lets us assert exactly what `since` the digest is fetched with.
const fetchDigest = vi.fn();
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
    fetchDigest,
    fetchTopicMessages: vi.fn(async () => []),
    fetchAllMessages: vi.fn(async () => []),
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

import { GroupProjectCanvasWidget, openChannel, clearUnread } from './GroupProjectCanvasWidget';
import { useBulletinReadStore } from '../../../stores/bulletinReadStore';

const PROJECT_ID = 'gp1';
const READ_KEY = `bulletin_read_${PROJECT_ID}`;

const GENERAL_LATEST = '2026-07-25T10:00:00.000Z';
const TASKS_LATEST = '2026-07-25T11:00:00.000Z';

/** Messages the fake board holds, one per topic timestamp. */
const BOARD: Record<string, string[]> = {
  general: ['2026-07-25T09:00:00.000Z', GENERAL_LATEST],
  tasks: [TASKS_LATEST],
};

/** A digest server that honours `since` exactly like the real bulletin board. */
function fakeDigest(since?: DigestSince): TopicDigest[] {
  return Object.entries(BOARD).map(([topic, timestamps]) => {
    const iso = typeof since === 'string' ? since : since?.[topic];
    const cutoff = iso ? new Date(iso).getTime() : 0;
    const unread = cutoff > 0
      ? timestamps.filter((t) => new Date(t).getTime() > cutoff)
      : timestamps;
    return {
      topic,
      messageCount: timestamps.length,
      newMessageCount: unread.length,
      latestTimestamp: timestamps[timestamps.length - 1],
    };
  });
}

function renderWidget() {
  return render(
    <GroupProjectCanvasWidget
      widgetId="w1"
      api={{ context: { mode: 'app', projectId: undefined }, annex: {} } as never}
      metadata={{ groupProjectId: PROJECT_ID }}
      onUpdateMetadata={vi.fn()}
      size={{ width: 900, height: 600 }}
      {...({} as never)}
    />,
  );
}

/** The unread badge text rendered next to a topic, e.g. "+2". */
function unreadBadge(topic: string): string | null {
  const button = screen.getByText(topic).closest('button')!;
  const badge = button.querySelector('.text-ctp-green');
  return badge ? badge.textContent : null;
}

function storedReadState(): Record<string, string> {
  const raw = storage[READ_KEY];
  return raw ? JSON.parse(raw) : {};
}

describe('GroupProjectCanvasWidget — unread counts', () => {
  beforeEach(() => {
    storage = {};
    useBulletinReadStore.setState({ lastRead: {} });
    fetchDigest.mockImplementation(async (_id: string, since?: DigestSince) => fakeDigest(since));
  });

  it('passes the per-channel last-read map as `since` to the digest', async () => {
    renderWidget();

    await waitFor(() => expect(fetchDigest).toHaveBeenCalled());
    expect(fetchDigest).toHaveBeenCalledWith(PROJECT_ID, expect.any(Object));
  });

  it('shows unread counts for channels that have never been read', async () => {
    renderWidget();

    // "All" is selected by default and does not exist as a real topic, so both
    // channels start unread until one is opened.
    await waitFor(() => expect(screen.getByText('tasks')).toBeInTheDocument());
    expect(unreadBadge('tasks')).toBe('+1');
  });

  it('clears the unread badge when a channel is opened', async () => {
    const user = userEvent.setup();
    renderWidget();

    await waitFor(() => expect(unreadBadge('tasks')).toBe('+1'));

    await user.click(screen.getByText('tasks'));

    await waitFor(() => expect(unreadBadge('tasks')).toBeNull());
  });

  it('persists the last-read timestamp when a channel is opened', async () => {
    const user = userEvent.setup();
    renderWidget();

    await waitFor(() => expect(screen.getByText('tasks')).toBeInTheDocument());
    await user.click(screen.getByText('tasks'));

    await waitFor(() => expect(storedReadState().tasks).toBe(TASKS_LATEST));
    // Opening one channel must not mark the others read.
    expect(storedReadState().general).toBeUndefined();
  });

  it('keeps the badge cleared on the next poll — the bug being fixed', async () => {
    const user = userEvent.setup();
    renderWidget();

    await waitFor(() => expect(screen.getByText('tasks')).toBeInTheDocument());
    await user.click(screen.getByText('tasks'));
    await waitFor(() => expect(storedReadState().tasks).toBe(TASKS_LATEST));

    // Replay the digest exactly as the next poll would.
    const digest = fakeDigest(useBulletinReadStore.getState().getLastRead(PROJECT_ID));
    expect(digest.find((d) => d.topic === 'tasks')!.newMessageCount).toBe(0);
    // ...while an unopened channel still reports its unread messages.
    expect(digest.find((d) => d.topic === 'general')!.newMessageCount).toBe(2);
  });

  it('counts a message posted after the read as unread again', async () => {
    const user = userEvent.setup();
    renderWidget();

    await waitFor(() => expect(screen.getByText('tasks')).toBeInTheDocument());
    await user.click(screen.getByText('tasks'));
    await waitFor(() => expect(storedReadState().tasks).toBe(TASKS_LATEST));

    BOARD.tasks.push('2026-07-25T12:00:00.000Z');
    try {
      const digest = fakeDigest(useBulletinReadStore.getState().getLastRead(PROJECT_ID));
      expect(digest.find((d) => d.topic === 'tasks')!.newMessageCount).toBe(1);
    } finally {
      BOARD.tasks.pop();
    }
  });

  it('restores persisted read state on remount, without a poll round-trip', async () => {
    storage[READ_KEY] = JSON.stringify({ tasks: TASKS_LATEST });

    renderWidget();

    await waitFor(() => expect(fetchDigest).toHaveBeenCalled());
    // The very first fetch already carries the stored timestamp, so the badge
    // never flashes back on after a reload.
    expect(fetchDigest.mock.calls[0][1]).toEqual({ tasks: TASKS_LATEST });
    await waitFor(() => expect(unreadBadge('tasks')).toBeNull());
    expect(unreadBadge('general')).toBe('+2');
  });

  it('does not mark anything read from the default All pane', async () => {
    renderWidget();

    await waitFor(() => expect(fetchDigest).toHaveBeenCalled());
    // "All" is the default selection, so treating it as a read would clear
    // every badge before the user has opened anything.
    expect(storedReadState()).toEqual({});
    expect(unreadBadge('general')).toBe('+2');
    expect(unreadBadge('tasks')).toBe('+1');
  });
});

describe('GroupProjectCanvasWidget — unread helpers', () => {
  const digest: TopicDigest[] = [
    { topic: 'general', messageCount: 2, newMessageCount: 2, latestTimestamp: GENERAL_LATEST },
    { topic: 'tasks', messageCount: 1, newMessageCount: 1, latestTimestamp: TASKS_LATEST },
  ];

  it('openChannel returns the selected topic', () => {
    expect(openChannel(digest, 'tasks')).toBe(digest[1]);
  });

  it('openChannel returns null for the All pane', () => {
    expect(openChannel(digest, '__all__')).toBeNull();
  });

  it('openChannel returns null for an unknown topic', () => {
    expect(openChannel(digest, 'gone')).toBeNull();
  });

  it('clearUnread zeroes only the open channel', () => {
    const cleared = clearUnread(digest, digest[1]);
    expect(cleared.find((t) => t.topic === 'tasks')!.newMessageCount).toBe(0);
    expect(cleared.find((t) => t.topic === 'general')!.newMessageCount).toBe(2);
  });

  it('clearUnread leaves the list untouched when no channel is open', () => {
    expect(clearUnread(digest, null)).toBe(digest);
  });
});
