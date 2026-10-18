/**
 * Telemetry settings shapes shared by main and renderer (spec §6.8).
 *
 * The renderer only ever sees `TelemetryStatus`: secrets come back masked
 * (last four characters of the instrumentation key or header value) and the
 * hash salt never leaves the main process.
 */
import type { TelemetryLevel } from './attributes';

/**
 * Destination kinds. Each kind has an adapter in
 * src/main/telemetry/destinations/registry.ts; adding a kind means adding it
 * here, to `clubhouse.telemetry.destination` in the attribute registry, and
 * one adapter.
 */
export type TelemetryDestinationKind = 'azure' | 'otlp' | 'framebriar';
export const TELEMETRY_DESTINATION_KINDS: readonly TelemetryDestinationKind[] = ['azure', 'otlp', 'framebriar'];
export type OtlpTemporality = 'cumulative' | 'delta';

/**
 * What a destination receives on top of its level (spec §6.11).
 * `all`: everything its level allows. `user_activity`: errors and exceptions,
 * crashes, feature use and the agent and chat lifecycle, without Detailed
 * high-volume spans and with almost no metrics.
 */
export type TelemetryFilterPreset = 'all' | 'user_activity';
export const TELEMETRY_FILTER_PRESETS: readonly TelemetryFilterPreset[] = ['all', 'user_activity'];

/** OTLP destination settings (no secrets; header values are in the secret store). */
export interface OtlpDestinationSettings {
  /** Base URL; `/v1/{traces,metrics,logs}` are appended. */
  endpoint: string;
  /** Header names only. */
  headerNames: string[];
  temporality: OtlpTemporality;
}

/** One configured destination. Several can be enabled at once. */
export interface TelemetryDestinationEntry {
  /** Stable id. One destination per kind today, so the id is the kind. */
  id: string;
  kind: TelemetryDestinationKind;
  enabled: boolean;
  level: TelemetryLevel;
  preset: TelemetryFilterPreset;
  /** The host the user last confirmed sending to (kinds with user-entered endpoints). */
  confirmedHost?: string;
  otlp?: OtlpDestinationSettings;
  /** Framebriar (the developer's feedback service): no user fields, only the user's Off. */
  framebriar?: FramebriarDestinationSettings;
}

/**
 * The developer destination follows Feedback (spec §6.11): its `enabled` is
 * derived, true exactly while Feedback is connected, telemetry is allowed
 * (experiment and consent), its host is confirmed, and the user hasn't
 * switched it off. Since #2097 it doesn't need another destination on.
 */
export interface FramebriarDestinationSettings {
  /** The user turned it off themselves ("Not now", or its switch): it stays off until they turn it on. */
  userOff: boolean;
}

/** Bump when what we collect widens materially; forces re-consent. */
export const TELEMETRY_CONSENT_VERSION = 1;

/** Persisted in telemetry-settings.json (0600). Secrets live in telemetry-secret.bin. */
export interface TelemetrySettingsFile {
  /** Every known destination, enabled or not, in display order. */
  destinations: TelemetryDestinationEntry[];
  /** Advanced trace sample rate in (0, 1]. Sampling is global, not per destination. */
  sampleRate: number;
  /** Highest consent version the user accepted (0 = never). */
  consentVersion: number;
  /** User accepted weak (basic_text) secret storage on Linux. */
  weakStorageAccepted?: boolean;
  installId?: string;
  hashSalt?: string;
  /** App version seen at the previous start, for `clubhouse.startup.kind`. */
  lastVersion?: string;
  /**
   * The developer-destination rule this file has been migrated to: 2 once the
   * #2097 migration ran (a destination that only sent alongside the user's
   * own export doesn't start alone after the update).
   */
  developerRule?: number;
}

export type SecureStorageState = 'available' | 'weak' | 'unavailable';

/** A destination's export health, from its own export results this session. */
export interface TelemetryDestinationHealth {
  /** off: not enabled. pending: enabled, nothing exported yet. error: could not start. */
  state: 'off' | 'pending' | 'ok' | 'failing' | 'error';
  lastSuccessAt?: number;
  lastFailureAt?: number;
  /** Plain-words reason for the last failure or start error. */
  message?: string;
}

export interface TelemetryDestinationStatus {
  id: string;
  kind: TelemetryDestinationKind;
  label: string;
  enabled: boolean;
  level: TelemetryLevel;
  preset: TelemetryFilterPreset;
  configured: boolean;
  /** Where data goes, shown in consent and on the panel. */
  host?: string;
  /** Exporting in the current session. */
  active: boolean;
  health: TelemetryDestinationHealth;
  /** Items wait in the offline queue when the network is down (Azure only). */
  offlineQueue: boolean;
  /** Framebriar only: the user switched it off, so don't offer it again. */
  userOff?: boolean;
}

export interface TelemetryStatus {
  /** `experimental.telemetry` is on; the section is hidden otherwise. */
  available: boolean;
  /** At least one destination is enabled (with consent recorded). */
  enabled: boolean;
  /** An exporter is running right now. */
  running: boolean;
  destinations: TelemetryDestinationStatus[];
  sampleRate: number;
  azure: { configured: boolean; ikeyLast4?: string; host?: string };
  otlp: {
    configured: boolean;
    endpoint: string;
    host?: string;
    headers: Array<{ name: string; last4: string }>;
    confirmedHost?: string;
    temporality: OtlpTemporality;
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
  /** Framebriar's host, when the confirm step also named it (it follows this destination on). */
  followHost?: string;
  weakStorage?: boolean;
}

export type TelemetryConfirmation = 'consent' | 'destination' | 'weak_storage';

export type TelemetryEnableResult =
  | TelemetryActionResult
  | {
      ok: false;
      reason: 'needs_confirmation';
      needs: TelemetryConfirmation[];
      /** The host being turned on (the one `ack.host` must name). */
      host?: string;
      /** Every host that would receive data once this is confirmed, for the consent dialog. */
      hosts?: string[];
      /** Framebriar's host when it is among `hosts` unconfirmed (the one `ack.followHost` must name). */
      followHost?: string;
      status: TelemetryStatus;
    };

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
  /** The destination the item was sent to. */
  destination?: string;
  name: string;
  time: number;
  attributes: Record<string, string | number | boolean>;
  value?: number;
}
