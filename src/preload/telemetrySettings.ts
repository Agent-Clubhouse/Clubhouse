import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { TelemetryLevel } from '../shared/telemetry/attributes';
import type {
  OtlpHeaderInput,
  OtlpTemporality,
  TelemetryAcknowledgements,
  TelemetryActionResult,
  TelemetryDestinationKind,
  TelemetryEnableResult,
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
    setEnabled: (destination: TelemetryDestinationKind, enabled: boolean, ack?: TelemetryAcknowledgements): Promise<TelemetryEnableResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SET_ENABLED, destination, enabled, ack),
    setLevel: (level: TelemetryLevel): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SET_LEVEL, level),
    setAdvanced: (input: { sampleRate?: number; otlpTemporality?: OtlpTemporality }): Promise<TelemetryActionResult> =>
      ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SET_ADVANCED, input),
    sendTest: (): Promise<TelemetryTestReport> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.SEND_TEST),
    getPreview: (): Promise<TelemetryPreviewItem[]> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.GET_PREVIEW),
    resetId: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.RESET_ID),
    clearOffline: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.CLEAR_OFFLINE),
    deleteLocalData: (): Promise<TelemetryActionResult> => ipcRenderer.invoke(IPC.TELEMETRY_SETTINGS.DELETE_LOCAL_DATA),
  },
};
