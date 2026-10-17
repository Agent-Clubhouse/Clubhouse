import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { RendererBatch, RendererReadyMarks, TelemetryState } from '../shared/telemetry/renderer-protocol';

export const telemetry = {
  telemetry: {
    /** Fire-and-forget: main re-validates every item (spec §6.2). */
    emit: (batch: RendererBatch) => ipcRenderer.send(IPC.TELEMETRY.EMIT, batch),
    /** Sent once by the main window after initApp() resolves. */
    rendererReady: (marks?: RendererReadyMarks) => ipcRenderer.send(IPC.TELEMETRY.RENDERER_READY, marks),
    getState: (): Promise<TelemetryState> => ipcRenderer.invoke(IPC.TELEMETRY.GET_STATE),
    onStateChanged: (callback: (state: TelemetryState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: TelemetryState) => callback(state);
      ipcRenderer.on(IPC.TELEMETRY.STATE_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.TELEMETRY.STATE_CHANGED, listener);
      };
    },
  },
};
