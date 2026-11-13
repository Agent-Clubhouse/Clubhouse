import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipc-channels';

const state = vi.hoisted(() => ({ windows: [] as Array<{ isDestroyed: () => boolean; webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } }> }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('events');
  return { BrowserWindow: { getAllWindows: () => state.windows }, ipcMain: new EventEmitter() };
});
import { ipcMain } from 'electron';
import { flushOpenCanvases } from './canvas-flush';

function windowWithId(id: number) {
  return { isDestroyed: () => false, webContents: { id, isDestroyed: () => false, send: vi.fn() } };
}

afterEach(() => { state.windows = []; vi.useRealTimers(); (ipcMain as unknown as EventEmitter).removeAllListeners(IPC.CANVAS_CMD.FLUSH_RESULT); });

describe('flushOpenCanvases', () => {
  it('waits for each window and ignores unrelated acknowledgements', async () => {
    const one = windowWithId(1);
    const two = windowWithId(2);
    state.windows = [one, two];
    const result = flushOpenCanvases();
    const id = one.webContents.send.mock.calls[0][1];
    (ipcMain as unknown as EventEmitter).emit(IPC.CANVAS_CMD.FLUSH_RESULT, { sender: { id: 3 } }, id, true);
    (ipcMain as unknown as EventEmitter).emit(IPC.CANVAS_CMD.FLUSH_RESULT, { sender: { id: 1 } }, id, true);
    (ipcMain as unknown as EventEmitter).emit(IPC.CANVAS_CMD.FLUSH_RESULT, { sender: { id: 2 } }, id, true);
    await expect(result).resolves.toEqual({ complete: true });
  });

  it('reports an incomplete inventory if a window fails to answer', async () => {
    vi.useFakeTimers();
    state.windows = [windowWithId(1)];
    const result = flushOpenCanvases();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toEqual({ complete: false });
  });
});
