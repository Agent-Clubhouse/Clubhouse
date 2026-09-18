import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { RunListQuery, GoobersConnectionState } from '../shared/goobers-types';

export const goobers = {
  goobers: {
    getState: (): Promise<GoobersConnectionState | unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.GET_STATE),
    validateRoot: (rootPath: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.VALIDATE_ROOT, { path: rootPath }),
    connect: (): Promise<GoobersConnectionState | unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.CONNECT),
    disconnect: (): Promise<void> =>
      ipcRenderer.invoke(IPC.GOOBERS.DISCONNECT),
    listGaggles: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.LIST_GAGGLES),
    listWorkflows: (gaggle: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.LIST_WORKFLOWS, { gaggle }),
    listRuns: (query?: RunListQuery): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.LIST_RUNS, query),
    getRun: (runId: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.GET_RUN, { runId }),
    getRunEvents: (runId: string, cursor?: string, limit?: number): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.GET_RUN_EVENTS, { runId, cursor, limit }),
    getStageAttempts: (runId: string, stage: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.GET_STAGE_ATTEMPTS, { runId, stage }),
    cancelRun: (runId: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.CANCEL_RUN, { runId }),
    daemonStatus: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.DAEMON_STATUS),
    daemonStart: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.DAEMON_START),
    daemonStop: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.DAEMON_STOP),
    openRunDir: (runId: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.OPEN_RUN_DIR, { runId }),
    telemetryErrors: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.TELEMETRY_ERRORS),
    workItems: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC.GOOBERS.WORK_ITEMS),
    onStateChanged: (callback: (state: GoobersConnectionState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: GoobersConnectionState) => callback(state);
      ipcRenderer.on(IPC.GOOBERS.STATE_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.GOOBERS.STATE_CHANGED, listener); };
    },
    onDataInvalidated: (callback: (payload: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(IPC.GOOBERS.DATA_INVALIDATED, listener);
      return () => { ipcRenderer.removeListener(IPC.GOOBERS.DATA_INVALIDATED, listener); };
    },
  },
};
