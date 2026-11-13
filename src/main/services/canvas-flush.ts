import { randomUUID } from 'crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';

/** Ask every window to finish its pending canvas saves before an impact check. */
export async function flushOpenCanvases(timeoutMs = 2000): Promise<{ complete: boolean }> {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed());
  if (!windows.length) return { complete: true };
  const requestId = randomUUID();
  const pending = new Set(windows.map((window) => window.webContents.id));
  return new Promise((resolve) => {
    let complete = true;
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener(IPC.CANVAS_CMD.FLUSH_RESULT, receive);
      resolve({ complete });
    };
    const receive = (event: Electron.IpcMainEvent, id: unknown, saved: unknown) => {
      if (id !== requestId || !pending.has(event.sender.id)) return;
      pending.delete(event.sender.id);
      if (saved !== true) complete = false;
      if (!pending.size) finish();
    };
    const timer = setTimeout(() => { complete = false; finish(); }, timeoutMs);
    ipcMain.on(IPC.CANVAS_CMD.FLUSH_RESULT, receive);
    for (const window of windows) {
      try { window.webContents.send(IPC.CANVAS_CMD.FLUSH_REQUEST, requestId); } catch { complete = false; }
    }
  });
}
