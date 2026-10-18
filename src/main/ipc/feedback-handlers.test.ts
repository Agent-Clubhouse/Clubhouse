import { describe, it, expect, beforeEach, vi } from 'vitest';

type FakeWindow = {
  isDestroyed: () => boolean;
  isVisible?: () => boolean;
  isMinimized?: () => boolean;
  restore?: () => void;
  focus?: () => void;
  webContents: { capturePage: () => Promise<{ toPNG: () => Buffer }>; send?: (...args: unknown[]) => void };
};
const win = vi.hoisted(() => ({
  current: null as null | FakeWindow,
  focused: null as null | FakeWindow,
  main: null as null | FakeWindow,
  popouts: [] as Array<{ window: FakeWindow; label: string }>,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => win.current), getFocusedWindow: vi.fn(() => win.focused) },
}));
vi.mock('./window-handlers', () => ({
  findMainWindow: () => win.main ?? undefined,
  listPopoutWindows: () => win.popouts,
}));

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

const svc = vi.hoisted(() => ({
  enabled: true,
  service: {
    start: vi.fn(async () => {}),
    status: vi.fn(() => ({ started: true, canCapture: true })),
    connect: vi.fn(async (inv: string) => ({ connected: inv === 'good', status: {} })),
    disconnect: vi.fn(async () => ({ forgotten: true, revoked: true, status: {} })),
    captureDraft: vi.fn(async (sources: Array<{ label: string; grab: () => Promise<Buffer | null> }>) => ({
      draftId: 'd1',
      preview: (await sources[0].grab())?.toString() ?? null,
      labels: sources.map((x) => x.label),
    })),
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
import { captureFromShortcut, captureSources, registerFeedbackHandlers, validateSendInput } from './feedback-handlers';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();
const event = { sender: {} };
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  svc.enabled = true;
  win.current = { isDestroyed: () => false, webContents: { capturePage: async () => ({ toPNG: () => Buffer.from('png') }) } };
  win.focused = null;
  win.main = null;
  win.popouts = [];
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
    expect(await call(IPC.FEEDBACK.CAPTURE)).toEqual({ draftId: 'd1', preview: 'png', labels: ['This window'] });
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

function fakeWindow(png: string, over: Partial<FakeWindow> = {}): FakeWindow {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { capturePage: async () => ({ toPNG: () => Buffer.from(png) }), send: vi.fn() },
    ...over,
  };
}

describe('captureSources (#2100)', () => {
  it('puts the starting window first, then the main window and pop-outs', async () => {
    const main = fakeWindow('main');
    const pop = fakeWindow('pop');
    win.main = main;
    win.popouts = [{ window: pop, label: 'Agent: faithful-urchin' }];
    const sources = captureSources(pop as never);
    expect(sources.map((x) => x.label)).toEqual(['Agent: faithful-urchin', 'Main window']);
    expect((await sources[0].grab())?.toString()).toBe('pop');
  });

  it('leaves out hidden, minimized and closed windows', () => {
    win.main = fakeWindow('main');
    win.popouts = [
      { window: fakeWindow('hidden', { isVisible: () => false }), label: 'Hidden' },
      { window: fakeWindow('min', { isMinimized: () => true }), label: 'Minimized' },
      { window: fakeWindow('closed', { isDestroyed: () => true }), label: 'Closed' },
      { window: fakeWindow('ok'), label: 'Canvas window' },
    ];
    expect(captureSources(null).map((x) => x.label)).toEqual(['Main window', 'Canvas window']);
  });

  it('still captures a starting window it does not know', () => {
    win.main = fakeWindow('main');
    expect(captureSources(fakeWindow('other') as never).map((x) => x.label)).toEqual(['This window', 'Main window']);
  });
});

describe('captureFromShortcut (#2101)', () => {
  it('captures from the focused window and hands the draft to the main window', async () => {
    const main = fakeWindow('main', { isMinimized: () => true });
    const pop = fakeWindow('pop');
    win.main = main;
    win.popouts = [{ window: pop, label: 'Agent: faithful-urchin' }];
    win.focused = pop;
    await captureFromShortcut();
    expect(svc.service.captureDraft).toHaveBeenCalledTimes(1);
    expect(main.restore).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    // The minimized main window isn't captured, but it is restored to show the review.
    expect(main.webContents.send).toHaveBeenCalledWith(IPC.FEEDBACK.CAPTURED, expect.objectContaining({ draftId: 'd1', labels: ['Agent: faithful-urchin'] }));
  });

  it('does nothing when feedback cannot capture or is stopped', async () => {
    win.main = fakeWindow('main');
    svc.service.status.mockReturnValueOnce({ started: true, canCapture: false });
    await captureFromShortcut();
    svc.enabled = false;
    await captureFromShortcut();
    expect(svc.service.captureDraft).not.toHaveBeenCalled();
  });

  it('captures nothing when there is no main window to review in', async () => {
    win.focused = fakeWindow('pop');
    await captureFromShortcut();
    expect(svc.service.captureDraft).not.toHaveBeenCalled();
  });

  it('captures from the window the menu fired in when Electron passes one', async () => {
    win.main = fakeWindow('main');
    const pop = fakeWindow('pop');
    win.popouts = [{ window: pop, label: 'Canvas window' }];
    win.focused = win.main;
    await captureFromShortcut(pop as never);
    expect(win.main.webContents.send).toHaveBeenCalledWith(IPC.FEEDBACK.CAPTURED, expect.objectContaining({ labels: ['Canvas window', 'Main window'] }));
  });
});

describe('validateSendInput', () => {
  const ok = { notes: 'n', includeScreenshot: false };
  it('accepts a minimal text-only review', () => {
    expect(() => validateSendInput(ok, 'arg1')).not.toThrow();
  });
  it('accepts a shot id', () => {
    expect(() => validateSendInput({ ...ok, includeScreenshot: true, shotId: 's1' }, 'arg1')).not.toThrow();
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
    [{ ...ok, shotId: 'main' }, /shotId/],
    [{ ...ok, shotId: 3 }, /shotId/],
    [{ ...ok, annotatedPng: 'not base64!' }, /annotatedPng/],
    [{ ...ok, annotatedPng: 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4) }, /annotatedPng/],
  ])('rejects %s', (value, error) => {
    expect(() => validateSendInput(value as never, 'arg1')).toThrow(error);
  });
});
