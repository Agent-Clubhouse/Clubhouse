/**
 * Screenshot feedback through Framebriar (github.com/masra91/framebriar), the user's own
 * feedback service. Main process only: the renderer never sees the invitation, tokens or
 * the outbox; it gets status views and a reviewed preview over IPC.
 *
 * - Enrollment needs only an invitation (no URL or key): the endpoint is fixed by the SDK.
 * - The refresh credential is stored with Electron safeStorage; there is no plaintext
 *   fallback, so a missing keyring shows as `storage-unavailable`.
 * - Capture is the Clubhouse window's own contents (webContents.capturePage), never the desktop.
 * - Framebriar telemetry is off; Clubhouse's OpenTelemetry pipeline stays separate.
 * - Diagnostics go to the local log (`core:feedback`): access and outbox transitions, and
 *   each connect, capture and send with its outcome. Invitations, tokens, notes and
 *   screenshots are never logged; only states, counts, sizes, durations and report ids.
 */

import { randomUUID } from 'crypto';
import type {
  Framebriar,
  FramebriarAccessView,
  FramebriarOutboxView,
  FramebriarReceipt,
  FramebriarSnapshot,
  SafeStorageLike,
} from '../../vendor/framebriar/adapters/node/index.mjs';
import { createFramebriar, otlpExporterOptions } from '../../vendor/framebriar/adapters/node/index.mjs';
import { ACCESS_TIMEOUT_MS } from '../../vendor/framebriar/adapters/node/access.mjs';
import type { FramebriarTelemetryExport } from '../../telemetry/destinations/framebriar-source';
import { FEEDBACK_MAX_PNG_BYTES, type FeedbackCaptureResult, type FeedbackSendInput, type FeedbackSendResult, type FeedbackStatus } from '../../../shared/feedback-types';

export const FRAMEBRIAR_APP_ID = 'clubhouse';
/** Reviewed drafts are dropped if the review isn't finished in time. */
const DRAFT_TTL_MS = 30 * 60_000;
/** Remembered "Received" acknowledgements, newest first. */
const RECEIPT_MEMORY = 20;
/** Open reviews kept at once (each holds a screenshot); the oldest is dropped beyond this. */
const MAX_DRAFTS = 5;
/** Framebriar's media limit (protocol LIMITS.media). */
const MAX_PNG_BYTES = FEEDBACK_MAX_PNG_BYTES;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Width and height from a PNG's IHDR chunk, or null if the bytes aren't a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
/** Scene codes the renderer may report; anything else becomes 'app'. */
const SCENE = /^[a-z][a-z0-9-]{0,39}$/;
/** The SDK only sends invitations of this shape; anything else fails before any request. */
const INVITATION = /^[A-Za-z0-9_-]{43}$/;
/** A failed connect this slow may have exhausted at least one SDK access-call timeout. */
export const LIKELY_TIMEOUT_MS = ACCESS_TIMEOUT_MS - 500;

/** Access states that need the user (or a retry) before feedback can be delivered. */
const ACCESS_PROBLEMS = new Set(['offline', 'expired', 'access-required', 'connection-uncertain', 'storage-unavailable', 'migration-required']);
/** In-between states, logged at debug only. */
const ACCESS_TRANSIENT = new Set(['checking', 'connecting', 'disconnecting']);

/** The SDK's per-report cap on breadcrumbs. */
const MAX_REPORT_BREADCRUMBS = 40;

/** One breadcrumb as the SDK takes it: `atMs` in epoch ms, `code` never user text. */
export interface FeedbackBreadcrumb {
  kind: 'error' | 'performance' | 'event';
  atMs: number;
  code: string;
  value?: number;
}

export type FeedbackLogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Local diagnostics sink (appLog in the app). Never pass secrets or user text in meta. */
export type FeedbackLog = (level: FeedbackLogLevel, msg: string, meta?: Record<string, unknown>) => void;

const errorMeta = (err: unknown): Record<string, unknown> => ({
  error: err instanceof Error ? err.message : String(err),
  ...(typeof (err as { code?: unknown })?.code === 'string' ? { code: (err as { code: string }).code } : {}),
});

export interface FeedbackServiceDeps {
  safeStorage: SafeStorageLike;
  dataDir: string;
  appVersion: string;
  /** The build commit (7 to 40 hex), or null (#2098). */
  buildSha?: string | null;
  /** Recent app events for the report, newest first, at most 40 (#2098). Defaults to none. */
  breadcrumbs?: () => FeedbackBreadcrumb[];
  isOnline: () => boolean;
  /** For tests: the SDK factory (defaults to the vendored createFramebriar). */
  create?: typeof createFramebriar;
  now?: () => number;
  /** Local diagnostics; defaults to none. */
  log?: FeedbackLog;
}

const DISCONNECTED_ACCESS: FramebriarAccessView = Object.freeze({
  state: 'disconnected', connected: false, enrolled: false, canCapture: false, notice: null, expiresAt: null,
});
const EMPTY_OUTBOX: FramebriarOutboxView = Object.freeze({
  state: 'checking', items: 0, bytes: 0, maxItems: 10, maxBytes: 32 * 1024 * 1024, blocked: 0, retention: 'until-delivered-or-cleared',
});

/** What the renderer sees while Feedback isn't running (switch off, or before start). */
export function stoppedFeedbackStatus(): FeedbackStatus {
  return toFeedbackStatus(false, { available: true }, DISCONNECTED_ACCESS, EMPTY_OUTBOX, []);
}

/** Mapping from SDK views to the renderer's status. Pure, for tests. */
export function toFeedbackStatus(
  started: boolean,
  storage: { available: boolean; reason?: string },
  access: FramebriarAccessView,
  outbox: FramebriarOutboxView,
  received: readonly string[],
): FeedbackStatus {
  const storageUnavailable = !storage.available || access.state === 'storage-unavailable';
  return {
    started,
    state: access.state,
    connected: access.connected,
    enrolled: access.enrolled,
    canCapture: access.canCapture === true && !storageUnavailable,
    notice: access.notice,
    expiresAt: access.expiresAt,
    storage: storageUnavailable
      ? { available: false, reason: storage.reason ?? 'storage-unavailable' }
      : { available: true },
    outbox: {
      state: outbox.state,
      pending: outbox.items,
      blocked: outbox.blocked,
      bytes: outbox.bytes,
      maxItems: outbox.maxItems,
      maxBytes: outbox.maxBytes,
    },
    received: [...received],
  };
}

/** The SDK accepts [A-Za-z0-9._+-]{1,40}; Clubhouse versions fit, but never fail start over it. */
export function sdkVersion(version: string): string | undefined {
  return /^[A-Za-z0-9._+-]{1,40}$/.test(version) ? version : undefined;
}

interface Draft {
  snapshot: FramebriarSnapshot;
  createdAt: number;
}

export class FeedbackService {
  private fb: Framebriar | null = null;
  private starting: Promise<void> | null = null;
  private readonly drafts = new Map<string, Draft>();
  private readonly received: string[] = [];
  private readonly listeners = new Set<(status: FeedbackStatus) => void>();
  private readonly now: () => number;
  private readonly log: FeedbackLog;
  private lastAccess: FramebriarAccessView | null = null;
  private lastOutbox: FramebriarOutboxView | null = null;

  constructor(private readonly deps: FeedbackServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** Subscribe to status changes (access, outbox, receipts). */
  onChange(listener: (status: FeedbackStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Start once (idempotent). Restores enrollment silently and resumes the outbox. */
  start(): Promise<void> {
    if (this.fb) return Promise.resolve();
    if (this.starting) return this.starting;
    const create = this.deps.create ?? createFramebriar;
    this.starting = (async () => {
      const fb = create({
        safeStorage: this.deps.safeStorage,
        dataDir: this.deps.dataDir,
        appId: FRAMEBRIAR_APP_ID,
        appVersion: sdkVersion(this.deps.appVersion),
        buildSha: this.deps.buildSha ?? null,
        telemetry: 'off',
        // No SDK-side capture: captureDraft grabs the calling window itself, so two
        // windows capturing at once can never get each other's screenshot.
        capture: () => Promise.resolve(null),
        isOnline: this.deps.isOnline,
        onAccessChange: (view) => { this.noteAccess(view); this.emit(); },
        onOutboxChange: (view) => { this.noteOutbox(view); this.emit(); },
        onReceipt: (receipt) => this.noteReceipt(receipt),
      });
      this.fb = fb;
      const t0 = this.now();
      await fb.start();
      const { state, notice, outbox } = this.status();
      this.log('info', 'Feedback started', { state, notice, pending: outbox.pending, blocked: outbox.blocked, durationMs: this.now() - t0 });
      this.emit();
    })().catch((err) => {
      this.log('warn', 'Feedback start failed', errorMeta(err));
      throw err;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  get isStarted(): boolean {
    return this.fb !== null;
  }

  status(): FeedbackStatus {
    const fb = this.fb;
    if (!fb) return toFeedbackStatus(false, { available: true }, DISCONNECTED_ACCESS, EMPTY_OUTBOX, this.received);
    let storage: { available: boolean; reason?: string };
    try {
      storage = fb.store.probe();
    } catch { // telemetry-exempt: shown to the user as storage-unavailable
      storage = { available: false, reason: 'probe-failed' };
    }
    return toFeedbackStatus(true, storage, fb.access.status(), fb.outbox.status(), this.received);
  }

  /** Explicit enrollment; the SDK retries transient failures twice with the same attempt id. */
  async connect(invitation: string): Promise<{ connected: boolean; status: FeedbackStatus }> {
    await this.start();
    const access = this.sdk().access;
    const trimmed = invitation.trim();
    const before = access.status().state;
    this.log('info', 'Feedback connect started', { from: before });
    const t0 = this.now();
    let connected: boolean;
    try {
      connected = await access.connect(trimmed);
    } catch (err) {
      this.log('error', 'Feedback connect threw', { ...errorMeta(err), durationMs: this.now() - t0 });
      throw err;
    }
    const durationMs = this.now() - t0;
    const status = this.status();
    if (connected) {
      this.log('info', 'Feedback connected', { durationMs, expiresAt: status.expiresAt });
    } else {
      this.log('warn', 'Feedback connect failed', {
        durationMs, state: status.state, notice: status.notice, reason: connectFailureReason(trimmed, before, status.state, status.notice, durationMs),
      });
    }
    return { connected, status };
  }

  /** Forget locally (queued feedback stays and is delivered after a later enrollment) and revoke. */
  async disconnect(): Promise<{ forgotten: boolean; revoked: boolean | null; status: FeedbackStatus }> {
    await this.start();
    const result = await this.sdk().access.disconnect();
    this.log(result.forgotten ? 'info' : 'warn', 'Feedback disconnect', { forgotten: result.forgotten, revoked: result.revoked });
    return { ...result, status: this.status() };
  }

  /**
   * Snapshot now, before any review UI is drawn, and return a draft id plus a data: URL
   * preview. `grab` must capture only Clubhouse's own window contents.
   */
  async captureDraft(grab: () => Promise<Buffer | null>): Promise<FeedbackCaptureResult> {
    try {
      const result = await this.captureDraftInner(grab);
      this.log('info', 'Feedback screenshot captured', { draftId: result.draftId, hasScreenshot: result.preview !== null, drafts: this.drafts.size });
      return result;
    } catch (err) {
      this.log('warn', 'Feedback capture failed', errorMeta(err));
      throw err;
    }
  }

  private async captureDraftInner(grab: () => Promise<Buffer | null>): Promise<FeedbackCaptureResult> {
    await this.start();
    this.pruneDrafts();
    // open() checks eligibility and records the moment (and trace) feedback opened.
    const opened = await this.sdk().feedback.open();
    let png: Buffer | null;
    try {
      png = await grab();
    } catch {
      // telemetry-exempt: surfaced to the user as a capture failure
      throw Object.assign(new Error('Screenshot capture failed'), { code: 'capture-failed' });
    }
    if (png && png.length > MAX_PNG_BYTES) {
      this.log('debug', 'Feedback screenshot too large', { bytes: png.length, maxBytes: MAX_PNG_BYTES });
      throw Object.assign(new Error('The screenshot is too large to send (8 MiB at most)'), { code: 'invalid-media' });
    }
    if (png && (png.length <= PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE))) {
      throw Object.assign(new Error('The screenshot is not a PNG image'), { code: 'invalid-media' });
    }
    const snapshot: FramebriarSnapshot = { ...opened, png: png ?? null };
    const draftId = randomUUID();
    this.drafts.set(draftId, { snapshot, createdAt: this.now() });
    while (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value as string);
    return {
      draftId,
      preview: snapshot.png ? `data:image/png;base64,${snapshot.png.toString('base64')}` : null,
    };
  }

  /**
   * Commit reviewed feedback to the durable outbox. With includeScreenshot the captured PNG
   * goes along; otherwise it's text-only (notes required). Resolves once the report is saved
   * locally; delivery and its receipt ("Received") come later.
   */
  async send(input: FeedbackSendInput): Promise<FeedbackSendResult> {
    // Never the image itself: only whether a drawing came along.
    const meta = { draftId: input.draftId ?? null, includeScreenshot: input.includeScreenshot, notesLength: input.notes?.length ?? 0, annotated: input.annotatedPng !== undefined };
    try {
      const result = await this.sendInner(input);
      this.log('info', 'Feedback saved for delivery', { ...meta, id: result.id, status: result.status, state: this.fb?.access.status().state });
      return result;
    } catch (err) {
      this.log('warn', 'Feedback send failed', { ...meta, ...errorMeta(err) });
      throw err;
    }
  }

  private async sendInner(input: FeedbackSendInput): Promise<FeedbackSendResult> {
    await this.start();
    const fb = this.sdk();
    const draft = input.draftId ? this.drafts.get(input.draftId) : undefined;
    if (input.includeScreenshot && !draft?.snapshot.png) throw new Error('This screenshot expired. Capture it again.');
    const notes = input.notes ?? '';
    if (!input.includeScreenshot && notes.trim() === '') throw new Error('Add a note to send feedback without a screenshot.');
    const scene = input.scene && SCENE.test(input.scene) ? input.scene : 'app';
    const png = input.includeScreenshot && draft ? this.annotatedOrCaptured(draft.snapshot.png!, input.annotatedPng) : null;
    const breadcrumbs = (this.deps.breadcrumbs?.() ?? []).slice(0, MAX_REPORT_BREADCRUMBS);
    const prepared = await fb.feedback.prepare({
      notes,
      context: { scene, breadcrumbs },
      ...(input.includeScreenshot && draft
        ? { ...draft.snapshot, png }
        : { png: null, ...(draft ? { capturedAt: draft.snapshot.capturedAt } : {}) }),
    });
    const ack = await fb.feedback.submit(prepared, { includeDiagnostics: false });
    // Only a committed report consumes the draft: a failed save (e.g. storage full) keeps
    // the reviewed screenshot so the user can retry.
    if (input.draftId) this.drafts.delete(input.draftId);
    this.emit();
    return { id: ack.id, status: ack.status };
  }

  /**
   * The user's marked-up copy of the capture (#2099), or the capture itself. The drawing
   * may only mark up the capture: it must be a PNG of the same width and height, within
   * the size cap. The draft keeps the original, so a failed save can be retried.
   */
  private annotatedOrCaptured(captured: Buffer, annotatedBase64: string | undefined): Buffer {
    if (annotatedBase64 === undefined) return captured;
    const annotated = Buffer.from(annotatedBase64, 'base64');
    if (annotated.length > MAX_PNG_BYTES) {
      throw Object.assign(new Error('The screenshot with your drawing is too large to send (8 MiB at most)'), { code: 'invalid-media' });
    }
    const size = pngSize(annotated);
    const expected = pngSize(captured);
    if (!size) throw Object.assign(new Error('The screenshot with your drawing is not a PNG image'), { code: 'invalid-media' });
    if (!expected || size.width !== expected.width || size.height !== expected.height) {
      throw Object.assign(new Error("The screenshot with your drawing doesn't match the captured screenshot"), { code: 'invalid-media' });
    }
    return annotated;
  }

  cancel(draftId: string): void {
    if (this.drafts.delete(draftId)) this.log('debug', 'Feedback draft cancelled', { draftId });
  }

  /**
   * True while telemetry may go to Framebriar: connected, or enrolled but briefly
   * offline (the token refreshes on reconnect). Expired, revoked or disconnected
   * enrollment stops it.
   */
  get telemetryConnected(): boolean {
    const access = this.fb?.access.status();
    return !!access && (access.connected || access.state === 'offline');
  }

  /**
   * Framebriar's OTLP endpoints for Clubhouse's own telemetry pipeline (spec §6.11):
   * URL and headers from the SDK's otlpExporterOptions (the token is fetched at export
   * time and never leaves main), plus the feedback session id for correlation.
   */
  telemetryExport(): FramebriarTelemetryExport | null {
    const fb = this.fb;
    if (!fb || !this.telemetryConnected) return null;
    return {
      host: new URL(fb.access.endpoint).host,
      options: (signal) => otlpExporterOptions(fb.access, signal),
      sessionId: fb.feedback.sessionId,
    };
  }

  async shutdown(): Promise<void> {
    this.drafts.clear();
    this.listeners.clear();
    const fb = this.fb;
    this.fb = null;
    if (fb) this.log('info', 'Feedback stopping', { pending: fb.outbox.status().items });
    await fb?.shutdown();
  }

  private sdk(): Framebriar {
    if (!this.fb) throw new Error('Feedback is not running');
    return this.fb;
  }

  /** Logs access transitions: problems at warn, so a failure is never silent. */
  private noteAccess(view: FramebriarAccessView): void {
    const prev = this.lastAccess;
    this.lastAccess = view;
    if (prev && prev.state === view.state && prev.notice === view.notice) return;
    const level: FeedbackLogLevel = ACCESS_PROBLEMS.has(view.state) ? 'warn' : ACCESS_TRANSIENT.has(view.state) ? 'debug' : 'info';
    this.log(level, `Feedback access: ${view.state}`, {
      from: prev?.state ?? null, notice: view.notice, enrolled: view.enrolled, expiresAt: view.expiresAt,
    });
  }

  /** Logs outbox transitions: queue changes, deliveries, and reports that can't be delivered. */
  private noteOutbox(view: FramebriarOutboxView): void {
    const prev = this.lastOutbox;
    this.lastOutbox = view;
    const meta = { pending: view.items, blocked: view.blocked, bytes: view.bytes };
    if (!prev || prev.state !== view.state) {
      this.log(view.state === 'storage-unavailable' ? 'warn' : 'info', `Feedback outbox: ${view.state}`, { from: prev?.state ?? null, ...meta });
      return;
    }
    if (view.blocked > prev.blocked) {
      this.log('warn', 'Feedback report can\'t be delivered and stays on this computer', meta);
    } else if (view.items !== prev.items || view.blocked !== prev.blocked) {
      this.log('debug', view.items > prev.items ? 'Feedback report queued' : 'Feedback report left the outbox', meta);
    }
  }

  private noteReceipt(receipt: FramebriarReceipt): void {
    if (!receipt?.id) return;
    this.log('info', 'Feedback delivered', { id: receipt.id, status: receipt.status ?? null });
    const i = this.received.indexOf(receipt.id);
    if (i >= 0) this.received.splice(i, 1);
    this.received.unshift(receipt.id);
    this.received.length = Math.min(this.received.length, RECEIPT_MEMORY);
    this.emit();
  }

  private pruneDrafts(): void {
    const cutoff = this.now() - DRAFT_TTL_MS;
    for (const [id, d] of this.drafts) if (d.createdAt < cutoff) this.drafts.delete(id);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const status = this.status();
    for (const fn of this.listeners) {
      try { fn(status); } catch { /* telemetry-exempt: a status listener can't affect enrollment */ }
    }
  }
}

/**
 * Best guess at why a connect returned false, for the log (the SDK reports only false).
 * Exported for tests.
 */
export function connectFailureReason(invitation: string, before: string, state: string, notice: string | null, durationMs: number): string {
  if (!INVITATION.test(invitation)) return `invitation-malformed (length ${invitation.length}); nothing was sent`;
  if (before === 'connecting' || before === 'disconnecting') return 'another connect or disconnect was in progress; nothing was sent';
  if (state === 'storage-unavailable') return 'secure storage failed while saving the enrollment';
  if (notice === 'access-required') return 'server refused the invitation (expired, revoked, used up, or not for this app)';
  if (notice === 'connection-uncertain' && durationMs >= LIKELY_TIMEOUT_MS) {
    return `request may have timed out (the SDK waits ${ACCESS_TIMEOUT_MS / 1000} s per call and retries twice); the server may still have accepted the invitation, so retry the same one`;
  }
  if (notice === 'connection-uncertain') return 'request failed or the response was rejected; the server may still have accepted the invitation';
  return 'unknown';
}
