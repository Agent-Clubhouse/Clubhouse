import { describe, it, expect, beforeEach, vi } from 'vitest';

const win = vi.hoisted(() => ({
  current: null as null | { isDestroyed: () => boolean; webContents: { capturePage: () => Promise<{ toPNG: () => Buffer }> } },
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => win.current) },
}));

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

const svc = vi.hoisted(() => ({
  enabled: true,
  service: {
    start: vi.fn(async () => {}),
    status: vi.fn(() => ({ started: true, canCapture: true })),
    connect: vi.fn(async (inv: string) => ({ connected: inv === 'good', status: {} })),
    disconnect: vi.fn(async () => ({ forgotten: true, revoked: true, status: {} })),
    captureDraft: vi.fn(async (grab: () => Promise<Buffer | null>) => ({ draftId: 'd1', preview: (await grab())?.toString() ?? null })),
    send: vi.fn(async () => ({ id: 'r1', status: 'saved-local' })),
    cancel: vi.fn(),
    onChange: vi.fn(() => () => {}),
  },
}));
vi.mock('../services/framebriar', () => ({
  isFeedbackEnabled: () => svc.enabled,
  getFeedbackService: () => svc.service,
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerFeedbackHandlers, validateSendInput } from './feedback-handlers';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();
const event = { sender: {} };
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  svc.enabled = true;
  win.current = { isDestroyed: () => false, webContents: { capturePage: async () => ({ toPNG: () => Buffer.from('png') }) } };
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: HandlerFn) => { handlers.set(channel, handler); });
  registerFeedbackHandlers();
});

describe('feedback IPC', () => {
  it('registers every request channel', () => {
    expect([...handlers.keys()].sort()).toEqual([
      IPC.FEEDBACK.CANCEL, IPC.FEEDBACK.CAPTURE, IPC.FEEDBACK.CONNECT, IPC.FEEDBACK.DISCONNECT, IPC.FEEDBACK.GET_STATUS, IPC.FEEDBACK.SEND,
    ].sort());
  });

  it('reports a stopped service and refuses actions once quit begins', async () => {
    svc.enabled = false;
    expect(await call(IPC.FEEDBACK.GET_STATUS)).toMatchObject({ started: false, canCapture: false, state: 'disconnected', storage: { available: true }, outbox: { pending: 0 } });
    expect(svc.service.start).not.toHaveBeenCalled();
    await expect(call(IPC.FEEDBACK.CONNECT, 'good')).rejects.toThrow(/quitting/);
    await expect(call(IPC.FEEDBACK.CAPTURE)).rejects.toThrow(/quitting/);
    await expect(call(IPC.FEEDBACK.SEND, { notes: 'x', includeScreenshot: false })).rejects.toThrow(/quitting/);
    await call(IPC.FEEDBACK.CANCEL, 'd1');
    expect(svc.service.cancel).not.toHaveBeenCalled();
  });

  it('starts on status', async () => {
    expect(await call(IPC.FEEDBACK.GET_STATUS)).toEqual({ started: true, canCapture: true });
    expect(svc.service.start).toHaveBeenCalled();
  });

  it('refuses callers that are not application windows', async () => {
    win.current = null;
    await expect(call(IPC.FEEDBACK.GET_STATUS)).rejects.toThrow(/unauthorized caller/);
    await expect(call(IPC.FEEDBACK.CONNECT, 'good')).rejects.toThrow(/unauthorized caller/);
    await expect(call(IPC.FEEDBACK.DISCONNECT)).rejects.toThrow(/unauthorized caller/);
    await expect(call(IPC.FEEDBACK.SEND, { notes: 'x', includeScreenshot: false })).rejects.toThrow(/unauthorized caller/);
    expect(() => call(IPC.FEEDBACK.CANCEL, 'd1')).toThrow(/unauthorized caller/);
    expect(svc.service.connect).not.toHaveBeenCalled();
  });

  it('connects and disconnects through the service', async () => {
    expect(await call(IPC.FEEDBACK.CONNECT, 'good')).toMatchObject({ connected: true });
    expect(svc.service.connect).toHaveBeenCalledWith('good');
    expect(await call(IPC.FEEDBACK.DISCONNECT)).toMatchObject({ forgotten: true });
    expect(() => call(IPC.FEEDBACK.CONNECT, 'x'.repeat(300))).toThrow();
    expect(() => call(IPC.FEEDBACK.CONNECT, 42)).toThrow();
  });

  it("captures the calling window's own contents", async () => {
    expect(await call(IPC.FEEDBACK.CAPTURE)).toEqual({ draftId: 'd1', preview: 'png' });
    win.current = null;
    await expect(call(IPC.FEEDBACK.CAPTURE)).rejects.toThrow(/unauthorized caller/);
    win.current = { isDestroyed: () => true, webContents: { capturePage: async () => ({ toPNG: () => Buffer.from('png') }) } };
    await expect(call(IPC.FEEDBACK.CAPTURE)).rejects.toThrow(/unauthorized caller/);
    expect(svc.service.captureDraft).toHaveBeenCalledTimes(1);
  });

  it('sends a validated review', async () => {
    const input = { draftId: '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e', notes: 'hi', includeScreenshot: true, scene: 'agents' };
    expect(await call(IPC.FEEDBACK.SEND, input)).toEqual({ id: 'r1', status: 'saved-local' });
    expect(svc.service.send).toHaveBeenCalledWith(input);
  });
});

describe('validateSendInput', () => {
  const ok = { notes: 'n', includeScreenshot: false };
  it('accepts a minimal text-only review', () => {
    expect(() => validateSendInput(ok, 'arg1')).not.toThrow();
  });
  it('accepts a base64 annotated screenshot', () => {
    expect(() => validateSendInput({ ...ok, includeScreenshot: true, annotatedPng: Buffer.from('png-bytes').toString('base64') }, 'arg1')).not.toThrow();
  });
  it.each([
    [{ ...ok, extra: 1 }, /not a recognized field/],
    [{ ...ok, notes: 3 }, /notes/],
    [{ ...ok, notes: 'x'.repeat(4001) }, /notes/],
    [{ ...ok, includeScreenshot: 'yes' }, /includeScreenshot/],
    [{ ...ok, draftId: '../etc' }, /draftId/],
    [{ ...ok, scene: 'x'.repeat(41) }, /scene/],
    [{ ...ok, annotatedPng: 42 }, /annotatedPng/],
    [{ ...ok, annotatedPng: 'not base64!' }, /annotatedPng/],
    [{ ...ok, annotatedPng: 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4) }, /annotatedPng/],
  ])('rejects %s', (value, error) => {
    expect(() => validateSendInput(value as never, 'arg1')).toThrow(error);
  });
});
