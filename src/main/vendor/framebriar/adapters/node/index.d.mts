// Clubhouse-owned typings for the vendored Framebriar Node SDK (index.mjs). Not part of
// the vendored file set: scripts/vendor-framebriar.mjs keeps *.d.mts files when it
// re-vendors. Covers the surface Clubhouse uses; see adapters/node/README.md upstream.

export declare const FRAMEBRIAR_ENDPOINT: string;

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export type FramebriarAccessState =
  | 'disconnected' | 'checking' | 'connecting' | 'connected' | 'offline' | 'stopped' | 'disconnecting'
  | 'expired' | 'access-required' | 'connection-uncertain' | 'storage-unavailable' | 'migration-required';

export type FramebriarNotice = 'expired' | 'access-required' | 'connection-uncertain' | 'migration-required';

export interface FramebriarAccessView {
  state: FramebriarAccessState;
  connected: boolean;
  enrolled: boolean;
  canCapture: boolean;
  notice: FramebriarNotice | null;
  /** ISO time: the 30-day enrollment deadline. */
  expiresAt: string | null;
}

export interface FramebriarOutboxView {
  state: 'checking' | 'available' | 'storage-unavailable' | string;
  items: number;
  bytes: number;
  maxItems: number;
  maxBytes: number;
  blocked: number;
  retention: 'until-delivered-or-cleared';
}

export interface FramebriarReceipt {
  id: string;
  status?: string;
  gameId?: string;
}

export interface FramebriarAccess {
  readonly endpoint: string;
  readonly gameId: string;
  status(): FramebriarAccessView;
  subscribe(fn: (view: FramebriarAccessView) => void): () => void;
  start(): Promise<FramebriarAccessView>;
  stop(): void;
  connect(invitation: string): Promise<boolean>;
  disconnect(): Promise<{ forgotten: boolean; revoked: boolean | null }>;
  getToken(): Promise<string | undefined>;
  dispose(): void;
}

export interface FramebriarOutbox {
  status(): FramebriarOutboxView;
  subscribe(fn: (view: FramebriarOutboxView) => void): () => void;
  onReceipt(fn: (receipt: FramebriarReceipt) => void): () => void;
  clear(): Promise<void>;
  dispose(): void;
}

export interface FramebriarSnapshot {
  readonly png: Buffer | null;
  readonly capturedAt: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface FramebriarPrepared {
  readonly report: Readonly<Record<string, unknown> & { id: string; traceId?: string; spanId?: string }>;
  readonly png: Buffer | null;
}

export interface FramebriarSubmitAck {
  id: string;
  gameId: string;
  status: 'saved-local';
  sent: false;
  diagnostics: 'included' | 'skipped' | 'unavailable';
}

export interface FramebriarFeedback {
  readonly sessionId: string;
  eligible(): boolean;
  open(): Promise<FramebriarSnapshot>;
  prepare(input: {
    notes?: string;
    context?: { scene?: string; breadcrumbs?: Array<{ kind: 'error' | 'performance' | 'event'; atMs: number; code: string; value?: number }> };
    png?: Buffer | null;
    capturedAt?: string;
    traceId?: string;
    spanId?: string;
  }): Promise<FramebriarPrepared>;
  submit(prepared: FramebriarPrepared, opts?: { includeDiagnostics?: boolean }): Promise<FramebriarSubmitAck>;
}

export interface FramebriarTelemetry {
  readonly sessionId: string;
  readonly enabled: boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface FramebriarStore {
  probe(): { available: boolean; reason?: string; backend?: string | null };
}

export interface Framebriar {
  readonly store: FramebriarStore;
  readonly access: FramebriarAccess;
  readonly outbox: FramebriarOutbox;
  readonly telemetry: FramebriarTelemetry | undefined;
  readonly feedback: FramebriarFeedback;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CreateFramebriarOptions {
  safeStorage: SafeStorageLike;
  dataDir: string;
  appId: string;
  appVersion?: string;
  buildSha?: string | null;
  endpoint?: string;
  telemetry?: 'continuous' | 'excerpt-only' | 'off';
  capture?: () => Promise<Buffer | Uint8Array | null>;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  captureErrors?: boolean;
  now?: () => number;
  onAccessChange?: (view: FramebriarAccessView) => void;
  onOutboxChange?: (view: FramebriarOutboxView) => void;
  onReceipt?: (receipt: FramebriarReceipt) => void;
}

export declare function createFramebriar(options: CreateFramebriarOptions): Framebriar;

export declare function otlpEndpoint(access: Pick<FramebriarAccess, 'endpoint'>, signal: 'traces' | 'logs' | 'metrics'): string;
export declare function otlpExporterOptions(
  access: Pick<FramebriarAccess, 'endpoint' | 'getToken'>,
  signal: 'traces' | 'logs' | 'metrics',
): { url: string; headers: () => Promise<Record<string, string>> };
