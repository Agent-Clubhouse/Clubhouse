import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { TelemetryLevel } from '../shared/telemetry/attributes';
import type {
  OtlpHeaderInput,
  OtlpTemporality,
  TelemetryAcknowledgements,
  TelemetryActionResult,
  TelemetryEnableResult,
  TelemetryFilterPreset,
  TelemetryPreviewItem,
  TelemetryStatus,
  TelemetryTestReport,
} from '../shared/telemetry/settings-types';


export const telemetrySettings = {
  telemetrySettings: {
    getStatus: (): Promise<TelemetryStatus> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.GET_STATUS),
    saveAzure: (connectionString: string, ack?: TelemetryAcknowledgements): Promise<TelemetryEnableResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SAVE_AZURE, connectionString, ack),
    clearAzure: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.CLEAR_AZURE),
    saveOtlp: (input: { endpoint: string; headers: OtlpHeaderInput[] }, ack?: TelemetryAcknowledgements): Promise<TelemetryEnableResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SAVE_OTLP, input, ack),
    clearOtlp: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.CLEAR_OTLP),
    setEnabled: (destinationId: string, enabled: boolean, ack?: TelemetryAcknowledgements): Promise<TelemetryEnableResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SET_ENABLED, destinationId, enabled, ack),
    setFilter: (destinationId: string, level: TelemetryLevel, preset: TelemetryFilterPreset): Promise<TelemetryActionResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SET_FILTER, destinationId, level, preset),
    setAdvanced: (input: { sampleRate?: number; otlpTemporality?: OtlpTemporality }): Promise<TelemetryActionResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SET_ADVANCED, input),
    sendTest: (destinationId: string): Promise<TelemetryTestReport> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SEND_TEST, destinationId),
    getPreview: (): Promise<TelemetryPreviewItem[]> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.GET_PREVIEW),
    resetId: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.RESET_ID),
    clearOffline: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.CLEAR_OFFLINE),
    deleteLocalData: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.DELETE_LOCAL_DATA),
  },
};
