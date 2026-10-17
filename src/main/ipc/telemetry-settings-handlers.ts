/**
 * IPC for Settings → Logging → Telemetry export (spec §6.8). All validation
 * happens in main (here and in telemetry/control.ts); the renderer only ever
 * receives a masked TelemetryStatus, never a secret or the hash salt.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { TELEMETRY_LEVELS, type TelemetryLevel } from '../../shared/telemetry/attributes';
import {
  TELEMETRY_DESTINATION_KINDS,
  TELEMETRY_FILTER_PRESETS,
  type OtlpHeaderInput,
  type TelemetryAcknowledgements,
  type TelemetryFilterPreset,
} from '../../shared/telemetry/settings-types';
import * as control from '../telemetry/control';
import { booleanArg, objectArg, stringArg, withValidatedArgs, type ArgValidator } from './validation';

function invalid(argName: string, message: string): never {
  throw new Error(`Invalid argument ${argName}: ${message}`);
}

/** Destination ids are the kinds today (one destination per kind). */
const destinationArg: ArgValidator<string> = (value, argName) => {
  if (typeof value !== 'string' || !(TELEMETRY_DESTINATION_KINDS as readonly string[]).includes(value)) {
    invalid(argName, `must be one of ${TELEMETRY_DESTINATION_KINDS.join(', ')}`);
  }
  return value as string;
};

const presetArg: ArgValidator<TelemetryFilterPreset> = (value, argName) => {
  if (!TELEMETRY_FILTER_PRESETS.includes(value as TelemetryFilterPreset)) invalid(argName, `must be one of ${TELEMETRY_FILTER_PRESETS.join(', ')}`);
  return value as TelemetryFilterPreset;
};

const levelArg: ArgValidator<TelemetryLevel> = (value, argName) => {
  if (!TELEMETRY_LEVELS.includes(value as TelemetryLevel)) invalid(argName, 'must be errors, standard or detailed');
  return value as TelemetryLevel;
};

const ackArg = objectArg<TelemetryAcknowledgements>({
  optional: true,
  validate: (v, argName) => {
    for (const [key, val] of Object.entries(v)) {
      if (key === 'host') {
        if (typeof val !== 'string' || val.length > 300) invalid(`${argName}.host`, 'must be a host string');
      } else if (key === 'consent' || key === 'weakStorage') {
        if (typeof val !== 'boolean') invalid(`${argName}.${key}`, 'must be a boolean');
      } else {
        invalid(`${argName}.${key}`, 'is not a recognized field');
      }
    }
  },
});

const otlpConfigArg = objectArg<control.OtlpConfigInput>({
  validate: (v, argName) => {
    if (typeof v.endpoint !== 'string' || v.endpoint.length > 2048) invalid(`${argName}.endpoint`, 'must be a string');
    if (!Array.isArray(v.headers) || v.headers.length > 20) invalid(`${argName}.headers`, 'must be an array of at most 20 headers');
    v.headers.forEach((h: OtlpHeaderInput, i) => {
      if (!h || typeof h.name !== 'string' || h.name.length > 128) invalid(`${argName}.headers[${i}].name`, 'must be a string');
      if (h.value !== undefined && (typeof h.value !== 'string' || h.value.length > 8192)) {
        invalid(`${argName}.headers[${i}].value`, 'must be a string');
      }
    });
  },
});

const advancedArg = objectArg<control.AdvancedInput>({
  validate: (v, argName) => {
    if (v.sampleRate !== undefined && typeof v.sampleRate !== 'number') invalid(`${argName}.sampleRate`, 'must be a number');
    if (v.otlpTemporality !== undefined && v.otlpTemporality !== 'cumulative' && v.otlpTemporality !== 'delta') {
      invalid(`${argName}.otlpTemporality`, 'must be cumulative or delta');
    }
  },
});

export function registerTelemetrySettingsHandlers(): void {
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.GET_STATUS, () => control.getStatus());
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.SAVE_AZURE, withValidatedArgs(
    [stringArg({ minLength: 1, maxLength: 4096 }), ackArg],
    (_e, connectionString, ack) => control.saveAzureConnectionString(connectionString, ack),
  ));
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.CLEAR_AZURE, () => control.clearAzureConnectionString());
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.SAVE_OTLP, withValidatedArgs(
    [otlpConfigArg, ackArg],
    (_e, input, ack) => control.saveOtlpConfig(input, ack),
  ));
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.CLEAR_OTLP, () => control.clearOtlpConfig());
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.SET_ENABLED, withValidatedArgs(
    [destinationArg, booleanArg(), ackArg],
    (_e, destination, enabled, ack) => control.setEnabled(destination, enabled, ack),
  ));
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.SET_FILTER, withValidatedArgs(
    [destinationArg, levelArg, presetArg],
    (_e, destination, level, preset) => control.setFilter(destination, level, preset),
  ));
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.SET_ADVANCED, withValidatedArgs([advancedArg], (_e, input) => control.setAdvanced(input)));
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.SEND_TEST, withValidatedArgs([destinationArg], (_e, destination) => control.sendTest(destination)));
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.GET_PREVIEW, () => control.getPreview());
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.RESET_ID, () => control.resetInstallId());
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.CLEAR_OFFLINE, () => control.clearOfflineQueue());
  ipcMain.handle(IPC.TELEMETRY_SETTINGS.DELETE_LOCAL_DATA, () => control.deleteLocalData());
}
