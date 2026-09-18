import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

const { goobersServiceMock } = vi.hoisted(() => ({
  goobersServiceMock: {
    isSupportedPlatform: true,
    subscribe: vi.fn(),
    getState: vi.fn(() => ({ connection: 'idle' })),
    connect: vi.fn(async () => ({ connection: 'idle' })),
    disconnect: vi.fn(() => undefined),
    notImplemented: vi.fn(() => ({ error: { code: 'not-implemented', message: 'not implemented until Phase 2' } })),
    unsupportedPlatform: vi.fn(() => ({ error: { code: 'unsupported-platform', message: 'unsupported' } })),
    listRuns: vi.fn(async () => ({ runs: [] })),
    daemonStatus: vi.fn(async () => ({ state: 'unknown' })),
    daemonStart: vi.fn(async () => ({ ok: true })),
    daemonStop: vi.fn(async () => ({ ok: true })),
    getRunEvents: vi.fn(async () => ({ runId: 'run-1', events: [] })),
    telemetryErrors: vi.fn(async () => ({ items: [] })),
    workItems: vi.fn(async () => ({ items: [], hasMore: false })),
  },
}));

vi.mock('../services/goobers-service', () => ({
  goobersService: goobersServiceMock,
  validateInstanceRoot: vi.fn(async (root: string) => ({ ok: root === '/valid', instanceId: root === '/valid' ? 'abc' : undefined })),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerGoobersHandlers } from './goobers-handlers';
import { validateInstanceRoot } from '../services/goobers-service';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  goobersServiceMock.isSupportedPlatform = true;
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: HandlerFn) => {
    handlers.set(channel, handler);
  });
  registerGoobersHandlers();
});

function getHandler(channel: string): HandlerFn {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}`);
  return h;
}

const fakeEvent = {} as unknown;

describe('goobers-handlers', () => {
  describe('registration', () => {
    it('registers every §6.1 channel', () => {
      for (const channel of Object.values(IPC.GOOBERS)) {
        if (channel === IPC.GOOBERS.STATE_CHANGED || channel === IPC.GOOBERS.DATA_INVALIDATED) continue; // broadcast-only
        expect(handlers.has(channel), `missing handler for ${channel}`).toBe(true);
      }
    });
  });

  describe('platform gate (§7.8)', () => {
    it('returns unsupported-platform on win32 for a no-arg channel', async () => {
      goobersServiceMock.isSupportedPlatform = false;
      const result = await getHandler(IPC.GOOBERS.GET_STATE)(fakeEvent);
      expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
      expect(goobersServiceMock.subscribe).not.toHaveBeenCalled();
    });

    it('returns unsupported-platform on win32 before validating args', async () => {
      goobersServiceMock.isSupportedPlatform = false;
      const result = await getHandler(IPC.GOOBERS.GET_RUN)(fakeEvent, { runId: '../etc/passwd' });
      expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
    });

    it('returns unsupported-platform for daemon-status', async () => {
      goobersServiceMock.isSupportedPlatform = false;
      const result = await getHandler(IPC.GOOBERS.DAEMON_STATUS)(fakeEvent);
      expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
    });
  });

  describe('goobers:get-state', () => {
    it('subscribes and returns the current snapshot', async () => {
      const result = await getHandler(IPC.GOOBERS.GET_STATE)(fakeEvent);
      expect(goobersServiceMock.subscribe).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ connection: 'idle' });
    });
  });

  describe('goobers:validate-root', () => {
    it('validates the arg shape and delegates to validateInstanceRoot', async () => {
      const result = await getHandler(IPC.GOOBERS.VALIDATE_ROOT)(fakeEvent, { path: '/valid' });
      expect(validateInstanceRoot).toHaveBeenCalledWith('/valid');
      expect(result).toEqual({ ok: true, instanceId: 'abc' });
    });

    it('rejects a missing path field', () => {
      expect(() => getHandler(IPC.GOOBERS.VALIDATE_ROOT)(fakeEvent, {})).toThrow();
    });

    it('rejects a non-object arg', () => {
      expect(() => getHandler(IPC.GOOBERS.VALIDATE_ROOT)(fakeEvent, 'not-an-object')).toThrow();
    });
  });

  describe('connect / disconnect', () => {
    it('connect() delegates to the service', async () => {
      const result = await getHandler(IPC.GOOBERS.CONNECT)(fakeEvent);
      expect(goobersServiceMock.connect).toHaveBeenCalled();
      expect(result).toEqual({ connection: 'idle' });
    });

    it('disconnect() delegates to the service', () => {
      getHandler(IPC.GOOBERS.DISCONNECT)(fakeEvent);
      expect(goobersServiceMock.disconnect).toHaveBeenCalled();
    });
  });

  describe('path-injection attempts on runId/gaggle/workflow/stage', () => {
    const pathInjectionCases: unknown[] = [
      '../secret',
      '..%2Fsecret',
      '%2e%2e%2fsecret',
      '/etc/passwd',
      'foo/bar',
      'foo%2Fbar',
      '..',
      '.',
      '',
    ];

    it.each(pathInjectionCases)('rejects runId=%j on goobers:get-run', (runId) => {
      expect(() => getHandler(IPC.GOOBERS.GET_RUN)(fakeEvent, { runId })).toThrow();
    });

    it.each(pathInjectionCases)('rejects gaggle=%j on goobers:list-workflows', (gaggle) => {
      expect(() => getHandler(IPC.GOOBERS.LIST_WORKFLOWS)(fakeEvent, { gaggle })).toThrow();
    });

    it.each(pathInjectionCases)('rejects runId=%j on goobers:get-run-events', (runId) => {
      expect(() => getHandler(IPC.GOOBERS.GET_RUN_EVENTS)(fakeEvent, { runId })).toThrow();
    });

    it('rejects a path-injecting stage alongside a valid runId', () => {
      expect(() => getHandler(IPC.GOOBERS.GET_STAGE_ATTEMPTS)(fakeEvent, { runId: 'run-1', stage: '../../etc' }))
        .toThrow();
    });

    it('accepts a well-formed runId and returns not-implemented (M3 stub)', async () => {
      const result = await getHandler(IPC.GOOBERS.GET_RUN)(fakeEvent, { runId: 'run-abc123' });
      expect(result).toEqual({ error: { code: 'not-implemented', message: expect.any(String) } });
    });
  });

  describe('goobers:list-runs', () => {
    it('accepts an empty query and delegates to the service', async () => {
      const result = await getHandler(IPC.GOOBERS.LIST_RUNS)(fakeEvent, undefined);
      expect(goobersServiceMock.listRuns).toHaveBeenCalledWith({});
      expect(result).toEqual({ runs: [] });
    });

    it('rejects an unrecognized query field', () => {
      expect(() => getHandler(IPC.GOOBERS.LIST_RUNS)(fakeEvent, { notARealField: true })).toThrow();
    });

    it('accepts a well-formed query and passes it through', async () => {
      const result = await getHandler(IPC.GOOBERS.LIST_RUNS)(fakeEvent, { gaggle: 'clubhouse', limit: 10 });
      expect(goobersServiceMock.listRuns).toHaveBeenCalledWith({ gaggle: 'clubhouse', limit: 10 });
      expect(result).toEqual({ runs: [] });
    });
  });

  describe('Phase 2 handlers still return not-implemented', () => {
    it('cancel-run', async () => {
      const result = await getHandler(IPC.GOOBERS.CANCEL_RUN)(fakeEvent, { runId: 'run-1' });
      expect(result).toEqual({ error: { code: 'not-implemented', message: expect.any(String) } });
    });

    it('open-run-dir', async () => {
      const result = await getHandler(IPC.GOOBERS.OPEN_RUN_DIR)(fakeEvent, { runId: 'run-1' });
      expect(result).toEqual({ error: { code: 'not-implemented', message: expect.any(String) } });
    });

    it('list-gaggles', async () => {
      const result = await getHandler(IPC.GOOBERS.LIST_GAGGLES)(fakeEvent);
      expect(result).toEqual({ error: { code: 'not-implemented', message: expect.any(String) } });
    });
  });

  describe('goobers:get-run-events (M25)', () => {
    it('validates runId/cursor/limit shape and delegates only runId to the service', async () => {
      const result = await getHandler(IPC.GOOBERS.GET_RUN_EVENTS)(fakeEvent, { runId: 'run-1', cursor: 'c1', limit: 50 });
      // cursor/limit are validated (see path-injection/shape tests above and
      // in validation.test.ts) but deliberately not forwarded — the daemon's
      // own route takes no pagination params, see goobers-service.ts.
      expect(goobersServiceMock.getRunEvents).toHaveBeenCalledWith('run-1');
      expect(result).toEqual({ runId: 'run-1', events: [] });
    });

    it('rejects a non-integer limit', () => {
      expect(() => getHandler(IPC.GOOBERS.GET_RUN_EVENTS)(fakeEvent, { runId: 'run-1', limit: 1.5 })).toThrow();
    });
  });

  describe('goobers:telemetry-errors (M25)', () => {
    it('delegates to the service with no args', async () => {
      const result = await getHandler(IPC.GOOBERS.TELEMETRY_ERRORS)(fakeEvent);
      expect(goobersServiceMock.telemetryErrors).toHaveBeenCalled();
      expect(result).toEqual({ items: [] });
    });

    it('gates on platform before calling the service', async () => {
      goobersServiceMock.isSupportedPlatform = false;
      const result = await getHandler(IPC.GOOBERS.TELEMETRY_ERRORS)(fakeEvent);
      expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
      expect(goobersServiceMock.telemetryErrors).not.toHaveBeenCalled();
    });
  });

  describe('goobers:work-items (M25)', () => {
    it('delegates to the service with no args', async () => {
      const result = await getHandler(IPC.GOOBERS.WORK_ITEMS)(fakeEvent);
      expect(goobersServiceMock.workItems).toHaveBeenCalled();
      expect(result).toEqual({ items: [], hasMore: false });
    });

    it('gates on platform before calling the service', async () => {
      goobersServiceMock.isSupportedPlatform = false;
      const result = await getHandler(IPC.GOOBERS.WORK_ITEMS)(fakeEvent);
      expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
      expect(goobersServiceMock.workItems).not.toHaveBeenCalled();
    });
  });

  describe('daemon control handlers', () => {
    it('daemon-status delegates to the service', async () => {
      const result = await getHandler(IPC.GOOBERS.DAEMON_STATUS)(fakeEvent);
      expect(goobersServiceMock.daemonStatus).toHaveBeenCalled();
      expect(result).toEqual({ state: 'unknown' });
    });

    it('daemon-start delegates to the service', async () => {
      const result = await getHandler(IPC.GOOBERS.DAEMON_START)(fakeEvent);
      expect(goobersServiceMock.daemonStart).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    it('daemon-stop delegates to the service', async () => {
      const result = await getHandler(IPC.GOOBERS.DAEMON_STOP)(fakeEvent);
      expect(goobersServiceMock.daemonStop).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });
});
