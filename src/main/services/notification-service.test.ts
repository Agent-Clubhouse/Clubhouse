import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so these are available when vi.mock factories run (which are hoisted)
const { mockShow, mockClose, mockOn, mockIsSupported, notificationInstances } = vi.hoisted(() => {
  return {
    mockShow: vi.fn(),
    mockClose: vi.fn(),
    mockOn: vi.fn(),
    mockIsSupported: vi.fn().mockReturnValue(true),
    notificationInstances: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('electron', () => {
  return {
    Notification: class MockNotification {
      show = mockShow;
      close = mockClose;
      on = mockOn;
      static isSupported = mockIsSupported;
      constructor(_opts: Record<string, unknown>) {
        notificationInstances.push(this);
      }
    },
    BrowserWindow: {
      getAllWindows: vi.fn().mockReturnValue([]),
    },
  };
});

vi.mock('./settings-store', () => ({
  createSettingsStore: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue({}),
    save: vi.fn(),
  }),
}));

import { sendNotification, closeNotification } from './notification-service';

describe('notification-service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear instance-level mocks but preserve isSupported return value
    mockShow.mockClear();
    mockClose.mockClear();
    mockOn.mockClear();
    mockIsSupported.mockClear();
    mockIsSupported.mockReturnValue(true);
    notificationInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sendNotification', () => {
    it('creates and shows a notification', () => {
      sendNotification('Title', 'Body', false);

      expect(notificationInstances).toHaveLength(1);
      expect(mockShow).toHaveBeenCalledOnce();
    });

    it('auto-dismisses notification after 5 seconds', () => {
      sendNotification('Title', 'Body', false, 'agent-1', 'proj-1');

      expect(mockClose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('auto-dismisses notifications without agent context after 5 seconds', () => {
      sendNotification('Title', 'Body', false);

      expect(mockClose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('replaces previous notification for same agent', () => {
      sendNotification('First', 'Body', false, 'agent-1', 'proj-1');

      expect(notificationInstances).toHaveLength(1);

      sendNotification('Second', 'Body', false, 'agent-1', 'proj-1');

      // Previous notification should be closed, new one created
      expect(mockClose).toHaveBeenCalled();
      expect(notificationInstances).toHaveLength(2);
    });

    it('registers click and close event handlers', () => {
      sendNotification('Title', 'Body', false, 'agent-1', 'proj-1');

      expect(mockOn).toHaveBeenCalledWith('click', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('does nothing when notifications not supported', () => {
      mockIsSupported.mockReturnValue(false);

      sendNotification('Title', 'Body', false);

      expect(notificationInstances).toHaveLength(0);
      expect(mockShow).not.toHaveBeenCalled();
    });
  });

  describe('closeNotification', () => {
    it('programmatically closes an active notification', () => {
      sendNotification('Title', 'Body', false, 'agent-1', 'proj-1');
      mockClose.mockClear();

      closeNotification('agent-1', 'proj-1');

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('does nothing when no active notification for agent', () => {
      closeNotification('agent-1', 'proj-1');

      expect(mockClose).not.toHaveBeenCalled();
    });

    it('cancels the auto-dismiss timer when closed manually', () => {
      sendNotification('Title', 'Body', false, 'agent-1', 'proj-1');
      mockClose.mockClear();

      closeNotification('agent-1', 'proj-1');

      expect(mockClose).toHaveBeenCalledOnce();
      mockClose.mockClear();

      // Advance past the auto-dismiss time - should NOT close again
      vi.advanceTimersByTime(5000);

      expect(mockClose).not.toHaveBeenCalled();
    });

    it('does not affect notifications for other agents', () => {
      sendNotification('Title 1', 'Body', false, 'agent-1', 'proj-1');
      sendNotification('Title 2', 'Body', false, 'agent-2', 'proj-1');
      mockClose.mockClear();

      closeNotification('agent-1', 'proj-1');

      // Only one close call (for agent-1)
      expect(mockClose).toHaveBeenCalledOnce();

      mockClose.mockClear();

      // agent-2 should still auto-dismiss
      vi.advanceTimersByTime(5000);
      expect(mockClose).toHaveBeenCalledOnce();
    });
  });
});
