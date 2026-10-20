import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test', getVersion: () => '0.42.0' },
  net: { isOnline: () => true },
  safeStorage: {},
  Menu: { getApplicationMenu: () => menu.current },
}));
const menu = vi.hoisted(() => ({ current: null as null | { getMenuItemById: (id: string) => { enabled: boolean } | null } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../telemetry/diag', () => ({ diag: vi.fn() }));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: broadcast }));

const created = vi.hoisted(() => [] as Array<{ shutdown: ReturnType<typeof vi.fn>; listeners: Array<(s: unknown) => void> }>);
const fake = vi.hoisted(() => ({
  connected: false,
  exportValue: { host: 'h', options: () => ({ url: 'https://h/x', headers: async () => ({}) }), sessionId: 's' },
}));
vi.mock('./feedback-service', () => ({
  FeedbackService: class {
    listeners: Array<(s: unknown) => void> = [];
    shutdown = vi.fn(async () => {});
    start = vi.fn(async () => {});
    constructor(public deps: { log: (...a: unknown[]) => void; diag: (...a: unknown[]) => void }) { created.push(this as never); }
    get telemetryConnected() { return fake.connected; }
    telemetryExport() { return fake.connected ? fake.exportValue : null; }
    onChange(fn: (s: unknown) => void) { this.listeners.push(fn); return () => {}; }
  },
}));

import { IPC } from '../../../shared/ipc-channels';
import { appLog } from '../log-service';
import { diag } from '../../telemetry/diag';
import { getFeedbackService, isFeedbackEnabled, resetFeedbackService, shutdownFeedback, startFeedback } from './index';
import { getFramebriarTelemetrySource, onFramebriarConnectionChanged, setFramebriarTelemetrySource } from '../../telemetry/destinations/framebriar-source';

beforeEach(() => {
  resetFeedbackService();
  created.length = 0;
  broadcast.mockClear();
  fake.connected = false;
  setFramebriarTelemetrySource(null);
});

describe('feedback wiring', () => {
  it('is always available until quit, with no switch', () => {
    expect(isFeedbackEnabled()).toBe(true);
  });

  it('starts with the app', () => {
    startFeedback();
    expect(created).toHaveLength(1);
    expect((created[0] as unknown as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledTimes(1);
  });

  it('sends report-id lines to the local-only diag tier and the rest to the legacy log (#2309)', () => {
    getFeedbackService();
    const { deps } = created[0] as unknown as { deps: { log: (...a: unknown[]) => void; diag: (...a: unknown[]) => void } };
    deps.diag('info', 'Feedback saved for delivery', { id: 'rep-1' });
    deps.log('info', 'Feedback started', { state: 'connected' });
    expect(diag).toHaveBeenCalledWith('core:feedback', 'info', 'Feedback saved for delivery', { id: 'rep-1' });
    expect(appLog).toHaveBeenCalledWith('core:feedback', 'info', 'Feedback started', { meta: { state: 'connected' } });
    expect(appLog).not.toHaveBeenCalledWith('core:feedback', 'info', 'Feedback saved for delivery', expect.anything());
  });

  it('broadcasts status changes to every window', () => {
    getFeedbackService();
    created[0].listeners[0]({ connected: true });
    expect(broadcast).toHaveBeenCalledWith(IPC.FEEDBACK.STATUS_CHANGED, { connected: true });
  });

  it('enables the capture shortcut menu item exactly when feedback can capture, and disables it at quit (#2101)', async () => {
    const item = { enabled: false };
    menu.current = { getMenuItemById: (id: string) => (id === 'feedback-capture' ? item : null) };
    try {
      getFeedbackService();
      const notify = (status: unknown) => created[0].listeners.forEach((l) => l(status));
      notify({ canCapture: true });
      expect(item.enabled).toBe(true);
      notify({ canCapture: false });
      expect(item.enabled).toBe(false);
      notify({ canCapture: true });
      await shutdownFeedback();
      expect(item.enabled).toBe(false);
    } finally {
      menu.current = null;
    }
  });

  it('cannot be started again after quit', async () => {
    getFeedbackService();
    await shutdownFeedback();
    expect(created[0].shutdown).toHaveBeenCalledTimes(1);
    expect(isFeedbackEnabled()).toBe(false);
    expect(() => getFeedbackService()).toThrow(/quitting/);
  });

  it('gives telemetry a Framebriar source and announces connection changes once each', () => {
    getFeedbackService();
    const source = getFramebriarTelemetrySource()!;
    expect(source()).toBeNull();
    const changed = vi.fn();
    const off = onFramebriarConnectionChanged(changed);
    const fire = () => created[0].listeners.forEach((fn) => fn({}));
    fire();
    expect(changed).not.toHaveBeenCalled();
    fake.connected = true;
    fire();
    fire();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(source()).toBe(fake.exportValue);
    fake.connected = false;
    fire();
    expect(changed).toHaveBeenCalledTimes(2);
    off();
  });

  it('drops the telemetry source when Feedback stops at quit, and tells telemetry', async () => {
    getFeedbackService();
    fake.connected = true;
    const changed = vi.fn();
    const off = onFramebriarConnectionChanged(changed);
    await shutdownFeedback();
    expect(getFramebriarTelemetrySource()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });
});

