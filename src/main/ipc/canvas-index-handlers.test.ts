import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/canvas-store-reader', () => ({
  getAgentCanvasMemberships: vi.fn(async () => [{ scope: 'app', canvasId: 'c', name: 'n', viewId: 'v' }]),
}));

import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getAgentCanvasMemberships } from '../services/canvas-store-reader';
import { registerCanvasIndexHandlers } from './canvas-index-handlers';

type Handler = (...args: unknown[]) => Promise<unknown>;
let handler: Handler;
const event = { sender: { id: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipcMain.handle).mockImplementation(((_channel: string, fn: Handler) => { handler = fn; }) as never);
  registerCanvasIndexHandlers();
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
