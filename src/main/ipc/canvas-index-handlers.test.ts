import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/canvas-store-reader', () => ({
  getAgentCanvasMemberships: vi.fn(async () => [{ scope: 'app', canvasId: 'c', name: 'n', viewId: 'v' }]),
}));
vi.mock('../services/connection-target-navigation', () => ({
  resolveAgentNavigationTarget: vi.fn(async () => ({ error: 'Unavailable agent' })),
  resolveTargetCanvasIndex: vi.fn(async () => ({ stores: [] })),
  readTargetCanvasForNavigation: vi.fn(async () => ({ canvases: [], wires: [], zoneWires: [] })),
}));

import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getAgentCanvasMemberships } from '../services/canvas-store-reader';
import { registerCanvasIndexHandlers } from './canvas-index-handlers';

type Handler = (...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const handler: Handler = (...args) => handlers.get(IPC.CANVAS_CMD.GET_AGENT_CANVASES)!(...args);
const event = { sender: { id: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => { handlers.set(channel, fn); }) as never);
  registerCanvasIndexHandlers();
});

describe('connection navigation index', () => {
  it.each([
    [IPC.CANVAS_CMD.GET_TARGET_CANVASES, ['group-project', 'gp_1']],
    [IPC.CANVAS_CMD.READ_FOR_NAVIGATION, ['group-project', 'gp_1', 'project_1']],
    [IPC.CANVAS_CMD.RESOLVE_AGENT_TARGET, ['agent_1']],
  ])('allows only application windows for %s', async (channel, args) => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    await expect(handlers.get(channel)!(event, ...args)).rejects.toThrow(/unauthorized caller/);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never);
    await expect(handlers.get(channel)!(event, ...args)).resolves.toBeDefined();
  });

  it('does not accept an invented widget route or a missing target identity', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never);
    await expect(handlers.get(IPC.CANVAS_CMD.GET_TARGET_CANVASES)!(event, 'future-widget', 'id')).rejects.toThrow(/Unsupported/);
    expect(() => handlers.get(IPC.CANVAS_CMD.RESOLVE_AGENT_TARGET)!(event, '')).toThrow(/at least 1/);
  });
});

describe('GET_AGENT_CANVASES', () => {
  it('is registered on its channel', () => {
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.CANVAS_CMD.GET_AGENT_CANVASES, expect.any(Function));
  });

  it('answers app windows from the persisted stores', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never);
    await expect(handler(event, 'durable_a', 'proj_1')).resolves.toHaveLength(1);
    expect(getAgentCanvasMemberships).toHaveBeenCalledWith('durable_a', 'proj_1');
  });

  it('rejects callers that are not app windows (webviews)', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    await expect(handler(event, 'durable_a')).rejects.toThrow(/unauthorized caller/);
    expect(getAgentCanvasMemberships).not.toHaveBeenCalled();
  });
});
