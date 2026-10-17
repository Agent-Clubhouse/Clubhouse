/**
 * Telemetry settings shapes shared by main and renderer (spec §6.8).
 *
 * The renderer only ever sees `TelemetryStatus`: secrets come back masked
 * (last four characters of the instrumentation key or header value) and the
 * hash salt never leaves the main process.
 */
import type { TelemetryLevel } from './attributes';

export type TelemetryDestinationKind = 'azure' | 'otlp';
export type OtlpTemporality = 'cumulative' | 'delta';

/** Bump when what we collect widens materially; forces re-consent. */
export const TELEMETRY_CONSENT_VERSION = 1;

/** Persisted in telemetry-settings.json (0600). Secrets live in telemetry-secret.bin. */
export interface TelemetrySettingsFile {
  enabled: boolean;
  destination: TelemetryDestinationKind;
  level: TelemetryLevel;
  /** Advanced trace sample rate in (0, 1]. */
  sampleRate: number;
  /** OTLP base URL; `/v1/{traces,metrics,logs}` are appended. */
  otlpEndpoint: string;
  /** Header names only; values are in the secret store. */
  otlpHeaderNames: string[];
  otlpTemporality: OtlpTemporality;
  /** The OTLP host the user last confirmed sending to. */
  otlpConfirmedHost?: string;
  /** Highest consent version the user accepted (0 = never). */
  consentVersion: number;
  /** User accepted weak (basic_text) secret storage on Linux. */
  weakStorageAccepted?: boolean;
  installId?: string;
  hashSalt?: string;
  /** App version seen at the previous start, for `clubhouse.startup.kind`. */
  lastVersion?: string;
}

export type SecureStorageState = 'available' | 'weak' | 'unavailable';

export interface TelemetryStatus {
  /** `experimental.telemetry` is on; the section is hidden otherwise. */
  available: boolean;
  enabled: boolean;
  /** An exporter is running right now. */
  running: boolean;
  destination: TelemetryDestinationKind;
  level: TelemetryLevel;
  sampleRate: number;
  otlpTemporality: OtlpTemporality;
  azure: { configured: boolean; ikeyLast4?: string; host?: string };
  otlp: {
    configured: boolean;
    endpoint: string;
    host?: string;
    headers: Array<{ name: string; last4: string }>;
    confirmedHost?: string;
  };
  installId?: string;
  consentAccepted: boolean;
  secureStorage: SecureStorageState;
  weakStorageAccepted: boolean;
  offlineItems: number;
  /** Why the last start failed, in plain words. */
  lastError?: string;
}

export type TelemetryActionResult =
  | { ok: true; status: TelemetryStatus }
  | { ok: false; reason: string; message: string; status: TelemetryStatus };

/** Confirmations the user can give with an enable request. */
export interface TelemetryAcknowledgements {
  consent?: boolean;
  /** The host the confirm step named. */
  host?: string;
  weakStorage?: boolean;
}

export type TelemetryConfirmation = 'consent' | 'destination' | 'weak_storage' | 'switch_destination';

export type TelemetryEnableResult =
  | TelemetryActionResult
  | { ok: false; reason: 'needs_confirmation'; needs: TelemetryConfirmation[]; host?: string; status: TelemetryStatus };

export interface OtlpHeaderInput {
  name: string;
  /** Omit to keep the stored value for an existing header. */
  value?: string;
}

export interface TelemetryTestReport {
  ok: boolean;
  latencyMs?: number;
  httpStatus?: number;
  message: string;
}

export interface TelemetryPreviewItem {
  signal: 'traces' | 'metrics' | 'logs';
  name: string;
  time: number;
  attributes: Record<string, string | number | boolean>;
  value?: number;
}
