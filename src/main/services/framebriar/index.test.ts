import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test', getVersion: () => '0.42.0' },
  net: { isOnline: () => true },
  safeStorage: {},
}));
const flags = vi.hoisted(() => ({ feedback: true, preview: true }));
vi.mock('../experimental-settings', () => ({ getSettings: () => ({ feedback: flags.feedback }) }));
vi.mock('../preview-eligible', () => ({ isPreviewEligible: () => flags.preview }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: broadcast }));

const created = vi.hoisted(() => [] as Array<{ shutdown: ReturnType<typeof vi.fn>; listeners: Array<(s: unknown) => void> }>);
vi.mock('./feedback-service', () => ({
  FeedbackService: class {
    listeners: Array<(s: unknown) => void> = [];
    shutdown = vi.fn(async () => {});
    start = vi.fn(async () => {});
    constructor() { created.push(this as never); }
    onChange(fn: (s: unknown) => void) { this.listeners.push(fn); return () => {}; }
  },
}));

import { IPC } from '../../../shared/ipc-channels';
import { applyFeedbackSwitch, getFeedbackService, isFeedbackEnabled, resetFeedbackService, shutdownFeedback } from './index';

beforeEach(() => {
  resetFeedbackService();
  created.length = 0;
  broadcast.mockClear();
  flags.feedback = true;
  flags.preview = true;
});

describe('feedback wiring', () => {
  it('is enabled only with the switch on in a preview-eligible build', () => {
    expect(isFeedbackEnabled()).toBe(true);
    flags.preview = false;
    expect(isFeedbackEnabled()).toBe(false);
    flags.preview = true;
    flags.feedback = false;
    expect(isFeedbackEnabled()).toBe(false);
  });

  it('broadcasts status changes to every window', () => {
    getFeedbackService();
    created[0].listeners[0]({ connected: true });
    expect(broadcast).toHaveBeenCalledWith(IPC.FEEDBACK.STATUS_CHANGED, { connected: true });
  });

  it('stops the service when the switch goes off at runtime, and starts a fresh one when it comes back', async () => {
    const first = getFeedbackService();
    await applyFeedbackSwitch();
    expect(created[0].shutdown).not.toHaveBeenCalled();

    flags.feedback = false;
    await applyFeedbackSwitch();
    expect(created[0].shutdown).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(IPC.FEEDBACK.STATUS_CHANGED, null);

    flags.feedback = true;
    expect(getFeedbackService()).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it('cannot be started again after quit', async () => {
    getFeedbackService();
    await shutdownFeedback();
    expect(created[0].shutdown).toHaveBeenCalledTimes(1);
    expect(isFeedbackEnabled()).toBe(false);
    expect(() => getFeedbackService()).toThrow(/quitting/);
  });
});
