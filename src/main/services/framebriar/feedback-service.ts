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
 *   screenshots are never logged; only states, counts, sizes, durations and ids. In the
 *   app this is appLog, which writes local-only diag lines (#2299, #2384): the saved and
 *   delivered lines carry the report id maintainers match a Framebriar report by.
 * - The same lifecycle goes to telemetry (feedback-telemetry.ts, #2309) as states, counts
 *   and error classes only. The report id is never an attribute.
 * - Recent diagnostics (feedback-diagnostics.ts, #2658): the allowlisted lines the reporter
 *   reviewed go after the report is saved, as a Framebriar telemetry excerpt tagged with its
 *   id, and only then. They can never hold up or fail the report. A report can't carry them
 *   itself, so its status goes in a breadcrumb (diagnostics.*) that travels with it.
 */

import { createHash, randomUUID } from 'crypto';
import { captureFeedbackCorrelation, type FeedbackCorrelationSnapshot } from '../../telemetry/feedback-incident';
import type {
  Framebriar,
  FramebriarTelemetry,
  FramebriarAccessView,
  FramebriarOutboxView,
  FramebriarReceipt,
  FramebriarSnapshot,
  FramebriarPrepared,
  SafeStorageLike,
} from '../../vendor/framebriar/adapters/node/index.mjs';
import { createFramebriar, createTelemetry, otlpExporterOptions } from '../../vendor/framebriar/adapters/node/index.mjs';
import { ACCESS_TIMEOUT_MS } from '../../vendor/framebriar/adapters/node/access.mjs';
import { toDiagnosticsV1 } from './feedback-diagnostics-v1';
import type { FramebriarTelemetryExport } from '../../telemetry/destinations/framebriar-source';
import {
  feedbackErrorClass,
  recordFeedbackAccess,
  recordFeedbackCaptured,
  recordFeedbackConnected,
  recordFeedbackDelivered,
  recordFeedbackFailed,
  recordFeedbackSubmitted,
  type FeedbackErrorClass,
} from '../../telemetry/feedback-telemetry';
import { FEEDBACK_MAX_PNG_BYTES, type FeedbackCaptureResult, type FeedbackDiagnosticLine, type FeedbackDiagnostics, type FeedbackDiagnosticsOutcome, type FeedbackSendInput, type FeedbackSendResult, type FeedbackStatus } from '../../../shared/feedback-types';

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
/** How long a diagnostics excerpt keeps retrying in memory before it is given up. */
const EXCERPT_RETRY_MS = 15 * 60_000;
const EXCERPT_CHECK_MS = 30_000;

/** The report's own record of its diagnostics: the breadcrumb code for each outcome. */
export function diagnosticsBreadcrumbCode(outcome: FeedbackDiagnosticsOutcome): string {
  return outcome.status === 'queued' ? 'diagnostics.queued' : `diagnostics.${outcome.status}.${outcome.reason}`;
}

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
  /** Recent allowlisted log lines to review, read when a report opens (#2658). Defaults to none. */
  diagnostics?: () => FeedbackDiagnostics;
  /**
   * Put diagnostics v1 in the report itself. Off, and the app must not turn it on until
   * Framebriar confirms the API deploy and an SDK tag: today's API strips the field from a
   * small report and answers a large one with a permanent 413 that blocks the outbox.
   */
  reportDiagnosticsField?: boolean;
  /** For tests: the SDK's telemetry factory, used only for diagnostics excerpts. */
  createExcerptTelemetry?: typeof createTelemetry;
  isOnline: () => boolean;
  /** For tests: the SDK factory (defaults to the vendored createFramebriar). */
  create?: typeof createFramebriar;
  now?: () => number;
  /** Synchronous opening snapshot; the default uses only bounded, validated local references. */
  captureCorrelation?: (now: number) => FeedbackCorrelationSnapshot;
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
      ...(outbox.correlationWaiting ? { correlationWaiting: outbox.correlationWaiting } : {}),
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

/** One window's screenshot in a draft (#2100). */
interface Shot {
  shotId: string;
  label: string;
  png: Buffer;
}

interface Draft {
  /** snapshot.png is the first shot: the window feedback was started from. */
  snapshot: FramebriarSnapshot;
  shots: Shot[];
  createdAt: number;
  /** Read once, when feedback opened: what is reviewed is what is sent. */
  diagnostics: FeedbackDiagnostics;
  /** Fixed with the prepared report, so a retry records the same outcome. */
  diagnosticsOutcome?: FeedbackDiagnosticsOutcome;
  /** Once prepared, retry the same report identity even if saving had an uncertain outcome. */
  prepared?: { key: string; value: Promise<FramebriarPrepared> };
}

/** A window to screenshot. The first one is the window feedback was started from. */
export interface CaptureSource {
  label: string;
  grab: () => Promise<Buffer | null>;
}

export class FeedbackService {
  private fb: Framebriar | null = null;
  private starting: Promise<void> | null = null;
  private readonly drafts = new Map<string, Draft>();
  private readonly received: string[] = [];
  private readonly excerpts = new Set<FramebriarTelemetry>();
  private readonly listeners = new Set<(status: FeedbackStatus) => void>();
  private readonly now: () => number;
  private readonly log: FeedbackLog;
  private lastAccess: FramebriarAccessView | null = null;
  private lastOutbox: FramebriarOutboxView | null = null;
  /** The last access state telemetry reported (in-between states are skipped). */
  private lastSettledAccess: { state: string; notice: string | null } | null = null;
  /** Start failures already recorded, so a capture or send waiting on start isn't counted again. */
  private readonly startFailures = new WeakSet<object>();
  /**
   * The last secure-storage probe. The check is async (Electron 46 has only the async
   * safeStorage API), so status() reads this copy. Start probes before it restores the
   * enrollment; actions and status requests probe again.
   */
  private storage: { available: boolean; reason?: string } | null = null;

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
      await this.probeStorage(fb);
      await fb.start();
      const { state, notice, outbox } = this.status();
      this.log('info', 'Feedback started', { state, notice, pending: outbox.pending, blocked: outbox.blocked, durationMs: this.now() - t0 });
      this.emit();
    })().catch((err) => {
      this.log('warn', 'Feedback start failed', errorMeta(err));
      recordFeedbackFailed('start', feedbackErrorClass(err));
      if (err && typeof err === 'object') this.startFailures.add(err);
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
    // Not probed yet only while start is probing: the enrollment isn't restored, so
    // canCapture is still false.
    return toFeedbackStatus(true, this.storage ?? { available: true }, fb.access.status(), fb.outbox.status(), this.received);
  }

  /** status() after starting and probing secure storage again (the IPC status request). */
  async currentStatus(): Promise<FeedbackStatus> {
    await this.start();
    await this.recheckStorage();
    return this.status();
  }

  /** Probes secure storage for status(); true when the result changed. */
  private async probeStorage(fb: Framebriar): Promise<boolean> {
    let next: { available: boolean; reason?: string };
    try {
      const { available, reason } = await fb.store.probeAsync();
      next = available ? { available } : { available, reason };
    } catch { // telemetry-exempt: shown to the user as storage-unavailable
      next = { available: false, reason: 'probe-failed' };
    }
    // Shut down while probing: the result belongs to a stopped SDK.
    if (this.fb !== fb) return false;
    const prev = this.storage;
    this.storage = next;
    return !prev || prev.available !== next.available || prev.reason !== next.reason;
  }

  private async recheckStorage(): Promise<void> {
    const fb = this.fb;
    if (fb && await this.probeStorage(fb)) this.emit();
  }

  /** Explicit enrollment; the SDK retries transient failures twice with the same attempt id. */
  async connect(invitation: string): Promise<{ connected: boolean; status: FeedbackStatus }> {
    await this.start();
    await this.recheckStorage();
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
      recordFeedbackFailed('connect', feedbackErrorClass(err));
      throw err;
    }
    const durationMs = this.now() - t0;
    const status = this.status();
    if (connected) {
      this.log('info', 'Feedback connected', { durationMs, expiresAt: status.expiresAt });
      recordFeedbackConnected();
    } else {
      const failure = connectFailureClass(trimmed, before, status.state, status.notice, durationMs);
      this.log('warn', 'Feedback connect failed', {
        durationMs, state: status.state, notice: status.notice, reason: connectFailureText(failure, trimmed),
      });
      recordFeedbackFailed('connect', failure);
    }
    return { connected, status };
  }

  /** Forget locally (queued feedback stays and is delivered after a later enrollment) and revoke. */
  async disconnect(): Promise<{ forgotten: boolean; revoked: boolean | null; status: FeedbackStatus }> {
    await this.start();
    await this.recheckStorage();
    const result = await this.sdk().access.disconnect();
    this.log(result.forgotten ? 'info' : 'warn', 'Feedback disconnect', { forgotten: result.forgotten, revoked: result.revoked });
    return { ...result, status: this.status() };
  }

  /**
   * Snapshot now, before any review UI is drawn, and return a draft id plus data: URL
   * previews. Each source must capture only one of Clubhouse's own windows. The first
   * source is the window feedback started from: if it fails, capture fails. Other
   * windows that fail or are unusable are left out (#2100). `trigger` is for telemetry only.
   */
  async captureDraft(sources: CaptureSource[] | (() => Promise<Buffer | null>), trigger: 'button' | 'shortcut' = 'button'): Promise<FeedbackCaptureResult> {
    const list = typeof sources === 'function' ? [{ label: 'This window', grab: sources }] : sources;
    try {
      const result = await this.captureDraftInner(list);
      this.log('info', 'Feedback screenshot captured', { draftId: result.draftId, hasScreenshot: result.preview !== null, shots: result.shots.length, windows: list.length, drafts: this.drafts.size });
      recordFeedbackCaptured({ screenshot: result.preview !== null, shots: result.shots.length, windows: list.length, trigger });
      return result;
    } catch (err) {
      this.log('warn', 'Feedback capture failed', errorMeta(err));
      if (!this.isStartFailure(err)) recordFeedbackFailed('capture', feedbackErrorClass(err));
      throw err;
    }
  }

  /** Why a grabbed image can't be sent, or null when it can. */
  private invalidShot(png: Buffer): Error | null {
    if (png.length > MAX_PNG_BYTES) {
      this.log('debug', 'Feedback screenshot too large', { bytes: png.length, maxBytes: MAX_PNG_BYTES });
      return Object.assign(new Error('The screenshot is too large to send (8 MiB at most)'), { code: 'invalid-media' });
    }
    if (png.length <= PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return Object.assign(new Error('The screenshot is not a PNG image'), { code: 'invalid-media' });
    }
    return null;
  }

  private async captureDraftInner(sources: CaptureSource[]): Promise<FeedbackCaptureResult> {
    // Snapshot the app pipeline before async capture/review. The feedback SDK
    // deliberately has its own telemetry off and cannot supply this context.
    const correlation = (this.deps.captureCorrelation ?? captureFeedbackCorrelation)(this.now());
    const diagnostics = this.readDiagnostics();
    await this.start();
    await this.recheckStorage();
    this.pruneDrafts();
    // open() checks eligibility and records the moment (and trace) feedback opened.
    const opened = await this.sdk().feedback.open();
    const shots: Shot[] = [];
    for (const [i, source] of sources.entries()) {
      let png: Buffer | null;
      try {
        png = await source.grab();
      } catch {
        // telemetry-exempt: surfaced to the user as a capture failure (first window), else skipped
        if (i === 0) throw Object.assign(new Error('Screenshot capture failed'), { code: 'capture-failed' });
        this.log('debug', 'Feedback skipped a window that could not be captured', { index: i });
        continue;
      }
      if (!png) {
        if (i === 0) break; // No screenshot of the starting window: text-only, as before.
        continue;
      }
      const invalid = this.invalidShot(png);
      if (invalid) {
        if (i === 0) throw invalid;
        continue;
      }
      shots.push({ shotId: `s${i}`, label: source.label, png });
    }
    const snapshot: FramebriarSnapshot = { ...opened, ...correlation.data, png: shots[0]?.png ?? null };
    const draftId = randomUUID();
    this.drafts.set(draftId, { snapshot, shots, createdAt: this.now(), diagnostics });
    while (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value as string);
    const previews = shots.map((shot) => ({ shotId: shot.shotId, label: shot.label, preview: `data:image/png;base64,${shot.png.toString('base64')}` }));
    return { draftId, preview: previews[0]?.preview ?? null, shots: previews, ...(correlation.summary && { correlation: correlation.summary }), diagnostics };
  }

  /** Never throws: a report opens the same whether or not its diagnostics could be read. */
  private readDiagnostics(): FeedbackDiagnostics {
    const at = new Date(this.now()).toISOString();
    const none: FeedbackDiagnostics = { status: 'none', reason: 'no_lines', windowStart: at, windowEnd: at, lines: [], bytes: 0, dropped: 0 };
    try {
      return this.deps.diagnostics?.() ?? none;
    } catch (err) { // telemetry-exempt: logged here and recorded in the report as collection_failed
      this.log('warn', 'Feedback diagnostics could not be read', errorMeta(err));
      return { ...none, reason: 'collection_failed' };
    }
  }

  /** What this report will say about its diagnostics. Never throws. */
  private diagnosticsOutcome(fb: Framebriar, draft: Draft | undefined, include: boolean): FeedbackDiagnosticsOutcome {
    if (!draft) return { status: 'none', reason: 'no_review' };
    if (draft.diagnostics.status === 'none') return { status: 'none', reason: draft.diagnostics.reason ?? 'no_lines' };
    if (!include) return { status: 'left_out', reason: 'reporter' };
    try {
      // The SDK's own rule for sending telemetry. Offline still counts: it retries.
      const { enrolled, notice, state } = fb.access.status();
      if (!enrolled || notice !== null || state === 'disconnected' || state === 'disconnecting' || state === 'connecting') return { status: 'none', reason: 'not_connected' };
    } catch { // telemetry-exempt: recorded in the report as not_connected
      return { status: 'none', reason: 'not_connected' };
    }
    return { status: 'queued', lines: draft.diagnostics.lines.length };
  }

  /**
   * Send the reviewed lines, tagged with the saved report's id. One short-lived instance per
   * report, in excerpt-only mode, so nothing else ever goes along. Never throws.
   */
  private sendExcerpt(fb: Framebriar, id: string, lines: readonly FeedbackDiagnosticLine[], trace: { traceId?: string; spanId?: string }): void {
    let telemetry: FramebriarTelemetry | undefined;
    const finish = (level: FeedbackLogLevel, msg: string) => {
      this.log(level, msg, { id, lines: lines.length });
      if (telemetry) this.excerpts.delete(telemetry);
      telemetry?.dispose();
    };
    try {
      telemetry = (this.deps.createExcerptTelemetry ?? createTelemetry)({ access: fb.access, buildSha: this.deps.buildSha ?? null, mode: 'excerpt-only', sessionId: fb.feedback.sessionId });
      this.excerpts.add(telemetry);
      for (const line of lines) {
        const attrs: Record<string, string | number> = { 'clubhouse.ns': line.ns };
        for (const [key, value] of Object.entries(line.attrs ?? {})) attrs[`clubhouse.${key}`] = value;
        telemetry.log(line.level, line.event, attrs, { time: Date.parse(line.at), parent: null });
      }
      const started = this.now();
      const active = telemetry;
      const settle = () => {
        if (!this.excerpts.has(active)) return; // Shut down meanwhile.
        const { sent, buffered, dropped, forbidden } = active.stats();
        if (forbidden) return finish('warn', 'Feedback diagnostics refused by the server');
        if (buffered === 0) return finish(sent > 0 && dropped === 0 ? 'info' : 'warn', sent > 0 && dropped === 0 ? 'Feedback diagnostics sent' : 'Feedback diagnostics not all sent');
        if (this.now() - started >= EXCERPT_RETRY_MS) return finish('warn', 'Feedback diagnostics given up after retrying');
        setTimeout(settle, EXCERPT_CHECK_MS).unref?.();
      };
      void active.feedbackSubmitted({ reportId: id, ...trace, includeDiagnostics: true }).then(settle, () => finish('warn', 'Feedback diagnostics could not be sent'));
    } catch (err) { // telemetry-exempt: the report is already saved; logged for its id
      this.log('warn', 'Feedback diagnostics could not be sent', { id, ...errorMeta(err) });
      if (telemetry) this.excerpts.delete(telemetry);
      try { telemetry?.dispose(); } catch { /* telemetry-exempt: the failure is logged above */ }
    }
  }

  /**
   * Commit reviewed feedback to the durable outbox. With includeScreenshot the captured PNG
   * goes along; otherwise it's text-only (notes required). Resolves once the report is saved
   * locally; delivery and its receipt ("Received") come later.
   */
  async send(input: FeedbackSendInput): Promise<FeedbackSendResult> {
    // Never the image itself: only whether a drawing came along.
    const meta = { draftId: input.draftId ?? null, includeScreenshot: input.includeScreenshot, notesLength: input.notes?.length ?? 0, annotated: input.annotatedPng !== undefined, shotId: input.shotId ?? null };
    // Read before sending: a committed report consumes its draft.
    const shots = input.draftId ? this.drafts.get(input.draftId)?.shots.length ?? 0 : 0;
    try {
      const result = await this.sendInner(input);
      const state = this.fb?.access.status().state;
      // The report id links a Framebriar report to this user's local record (a diag line,
      // through appLog); telemetry can't carry it. Don't drop it.
      this.log('info', 'Feedback saved for delivery', { ...meta, id: result.id, status: result.status, state, diagnostics: result.diagnostics ? diagnosticsBreadcrumbCode(result.diagnostics) : null });
      recordFeedbackSubmitted({ screenshot: input.includeScreenshot, annotated: input.includeScreenshot && input.annotatedPng !== undefined, shots, accessState: state ?? 'stopped' });
      return result;
    } catch (err) {
      this.log('warn', 'Feedback send failed', { ...meta, ...errorMeta(err) });
      if (!this.isStartFailure(err)) recordFeedbackFailed('submit', feedbackErrorClass(err));
      throw err;
    }
  }

  private async sendInner(input: FeedbackSendInput): Promise<FeedbackSendResult> {
    await this.start();
    await this.recheckStorage();
    const fb = this.sdk();
    const draft = input.draftId ? this.drafts.get(input.draftId) : undefined;
    if (input.draftId && !draft) throw Object.assign(new Error('This feedback draft expired. Open feedback again.'), { code: 'screenshot-expired' });
    if (input.includeScreenshot && !draft?.snapshot.png) throw Object.assign(new Error('This screenshot expired. Capture it again.'), { code: 'screenshot-expired' });
    const notes = input.notes ?? '';
    if (!input.includeScreenshot && notes.trim() === '') throw Object.assign(new Error('Add a note to send feedback without a screenshot.'), { code: 'notes-required' });
    const scene = input.scene && SCENE.test(input.scene) ? input.scene : 'app';
    const png = input.includeScreenshot && draft ? this.annotatedOrCaptured(this.chosenShot(draft, input.shotId), input.annotatedPng) : null;
    const includeDiagnostics = input.includeDiagnostics === true;
    const outcome = draft?.diagnosticsOutcome ?? this.diagnosticsOutcome(fb, draft, includeDiagnostics);
    // First and within the cap, so the report always says what became of its diagnostics.
    const breadcrumbs: FeedbackBreadcrumb[] = [
      { kind: 'event', atMs: this.now(), code: diagnosticsBreadcrumbCode(outcome), ...(outcome.status === 'queued' && { value: outcome.lines }) },
      ...(this.deps.breadcrumbs?.() ?? []).slice(0, MAX_REPORT_BREADCRUMBS - 1),
    ];
    // The hash is memory-only and never logged/exported. It prevents a retry from
    // silently replacing a possibly saved report with a different reviewed payload.
    const key = createHash('sha256').update(JSON.stringify({ notes, scene, includeCorrelation: input.includeCorrelation !== false, includeDiagnostics, png: png ? createHash('sha256').update(png).digest('hex') : null })).digest('hex');
    if (draft?.prepared && draft.prepared.key !== key) {
      throw Object.assign(new Error('Retry the feedback unchanged, or close it and open a new report to make changes.'), { code: 'feedback-review-changed' });
    }
    const prepare = () => fb.feedback.prepare({
      notes,
      context: { scene, breadcrumbs },
      ...(this.deps.reportDiagnosticsField === true && draft && { diagnostics: toDiagnosticsV1(draft.diagnostics, outcome) }),
      ...(input.includeScreenshot && draft
        ? { ...draft.snapshot, png }
        : { ...(draft?.snapshot ?? {}), png: null }),
      ...(input.includeCorrelation === false && { incident: null, traceId: undefined, spanId: undefined }),
    });
    if (draft && !draft.prepared) {
      const cached = { key, value: prepare() };
      draft.prepared = cached;
      draft.diagnosticsOutcome = outcome;
      // A prepare failure has not reached storage and may safely be corrected.
      void cached.value.catch(() => { if (draft.prepared === cached) { draft.prepared = undefined; draft.diagnosticsOutcome = undefined; } });
    }
    const prepared = await (draft?.prepared?.value ?? prepare());
    const ack = await fb.feedback.submit(prepared, { includeDiagnostics: false });
    // Only a committed report consumes the draft: a failed save (e.g. storage full) keeps
    // the reviewed screenshot so the user can retry.
    if (input.draftId) this.drafts.delete(input.draftId);
    this.emit();
    if (outcome.status === 'queued' && draft) {
      const { traceId, spanId } = prepared.report as { traceId?: string; spanId?: string };
      this.sendExcerpt(fb, ack.id, draft.diagnostics.lines, traceId && spanId ? { traceId, spanId } : {});
    }
    return { id: ack.id, status: ack.status, diagnostics: outcome };
  }

  /** The screenshot the user picked (#2100); the starting window's when none was picked. */
  private chosenShot(draft: Draft, shotId: string | undefined): Buffer {
    if (shotId === undefined) return draft.snapshot.png!;
    const shot = draft.shots.find((s) => s.shotId === shotId);
    if (!shot) throw Object.assign(new Error('That screenshot is no longer available. Capture it again.'), { code: 'shot-unavailable' });
    return shot.png;
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
    for (const excerpt of this.excerpts) {
      try { excerpt.dispose(); } catch { /* telemetry-exempt: shutting down */ }
    }
    this.excerpts.clear();
    const fb = this.fb;
    this.fb = null;
    this.storage = null;
    if (fb) this.log('info', 'Feedback stopping', { pending: fb.outbox.status().items });
    await fb?.shutdown();
  }

  private isStartFailure(err: unknown): boolean {
    return !!err && typeof err === 'object' && this.startFailures.has(err);
  }

  private sdk(): Framebriar {
    if (!this.fb) throw Object.assign(new Error('Feedback is not running'), { code: 'not-running' });
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
    this.noteSettledAccess(view);
  }

  /** Reports settled access changes to telemetry, `from` the previous settled state. */
  private noteSettledAccess(view: FramebriarAccessView): void {
    if (ACCESS_TRANSIENT.has(view.state)) return;
    const prev = this.lastSettledAccess;
    if (prev && prev.state === view.state && prev.notice === view.notice) return;
    this.lastSettledAccess = { state: view.state, notice: view.notice };
    recordFeedbackAccess(prev?.state ?? null, view.state, view.notice);
  }

  /** Logs outbox transitions: queue changes, deliveries, and reports that can't be delivered. */
  private noteOutbox(view: FramebriarOutboxView): void {
    const prev = this.lastOutbox;
    this.lastOutbox = view;
    const meta = { pending: view.items, blocked: view.blocked, bytes: view.bytes };
    if (!prev || prev.state !== view.state) {
      this.log(view.state === 'storage-unavailable' ? 'warn' : 'info', `Feedback outbox: ${view.state}`, { from: prev?.state ?? null, ...meta });
      if (view.state === 'storage-unavailable') recordFeedbackFailed('deliver', 'storage-unavailable');
      return;
    }
    if (view.blocked > prev.blocked) {
      this.log('warn', 'Feedback report can\'t be delivered and stays on this computer', meta);
      recordFeedbackFailed('deliver', 'undeliverable');
    } else if (view.items !== prev.items || view.blocked !== prev.blocked) {
      this.log('debug', view.items > prev.items ? 'Feedback report queued' : 'Feedback report left the outbox', meta);
    }
  }

  private noteReceipt(receipt: FramebriarReceipt): void {
    if (!receipt?.id) return;
    // The report id, as in the saved line above.
    this.log('info', 'Feedback delivered', { id: receipt.id, status: receipt.status ?? null });
    recordFeedbackDelivered();
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

/** Why a connect returned false, as a telemetry error class. */
export type ConnectFailureClass = Extract<FeedbackErrorClass, 'invitation-malformed' | 'busy' | 'storage-unavailable' | 'access-refused' | 'timeout' | 'connection-uncertain' | 'unknown'>;

/**
 * Best guess at why a connect returned false (the SDK reports only false). Exported for tests.
 */
export function connectFailureClass(invitation: string, before: string, state: string, notice: string | null, durationMs: number): ConnectFailureClass {
  if (!INVITATION.test(invitation)) return 'invitation-malformed';
  if (before === 'connecting' || before === 'disconnecting') return 'busy';
  if (state === 'storage-unavailable') return 'storage-unavailable';
  if (notice === 'access-required') return 'access-refused';
  if (notice === 'connection-uncertain' && durationMs >= LIKELY_TIMEOUT_MS) return 'timeout';
  if (notice === 'connection-uncertain') return 'connection-uncertain';
  return 'unknown';
}

/** The local log's wording for a connect failure class. */
function connectFailureText(failure: ConnectFailureClass, invitation: string): string {
  switch (failure) {
    case 'invitation-malformed': return `invitation-malformed (length ${invitation.length}); nothing was sent`;
    case 'busy': return 'another connect or disconnect was in progress; nothing was sent';
    case 'storage-unavailable': return 'secure storage failed while saving the enrollment';
    case 'access-refused': return 'server refused the invitation (expired, revoked, used up, or not for this app)';
    case 'timeout': return `request may have timed out (the SDK waits ${ACCESS_TIMEOUT_MS / 1000} s per call and retries twice); the server may still have accepted the invitation, so retry the same one`;
    case 'connection-uncertain': return 'request failed or the response was rejected; the server may still have accepted the invitation';
    default: return 'unknown';
  }
}

/** Best guess at why a connect returned false, for the log. Exported for tests. */
export function connectFailureReason(invitation: string, before: string, state: string, notice: string | null, durationMs: number): string {
  return connectFailureText(connectFailureClass(invitation, before, state, notice, durationMs), invitation);
}
