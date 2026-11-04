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
 *   itself, so its status goes in a breadcrumb (diagnostics.*) that travels with it. With the
 *   report field on, the same reviewed lines go in the report through the outbox instead, and
 *   no excerpt is sent.
 * - A rejected redeem reply (#2787): the invitation was probably spent and the old session is
 *   gone, but its ref stays, so reports saved now bind to it. They only go out after a new
 *   enrollment and an explicit release. noticeReason goes to the local log, never to the renderer.
 * - Enrollment binding (#2658): open() gives a draft its enrollmentRef, kept in the draft's
 *   snapshot only, never in the review hash, report bytes, logs or anything the renderer sees.
 *   If the enrollment changes under a draft, its prepared report can never send: the draft gets
 *   a new report id and ref, and the user has to review and Send again. An image keeps the
 *   capture's provenance. Reports saved under an earlier enrollment stay held until the user
 *   releases or clears them.
 * - Reviewed bytes (feedback composer contract, sections 2, 3 and 5): the first Send ends
 *   reversibility here too, so the other windows' captures go, and once edits may exist the
 *   original can't be sent. The renderer's bytes are untrusted. Changed content is a new report
 *   id, only one prepared report can send a draft, and unchanged content retries under its id.
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
  FramebriarSubmitAck,
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
import { FEEDBACK_MAX_PNG_BYTES, type FeedbackCaptureResult, type FeedbackCorrelationSummary, type FeedbackDiagnosticLine, type FeedbackDiagnostics, type FeedbackDiagnosticsOutcome, type FeedbackHeldClearResult, type FeedbackHeldReleaseResult, type FeedbackSendInput, type FeedbackSendResult, type FeedbackStatus } from '../../../shared/feedback-types';

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
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Width and height from a PNG's IHDR chunk, or null if the bytes aren't a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
/**
 * Whether a flattened PNG can be this source, or the source fitted down: never larger, and the
 * same shape, allowing for each side having been rounded by up to a pixel.
 */
export function fitsSource(size: { width: number; height: number }, source: { width: number; height: number }): boolean {
  if (size.width < 1 || size.height < 1 || size.width > source.width || size.height > source.height) return false;
  return Math.abs(size.width * source.height - size.height * source.width) <= source.width + source.height;
}
/** Scene codes the renderer may report; anything else becomes 'app'. */
const SCENE = /^[a-z][a-z0-9-]{0,39}$/;
/** The SDK only sends invitations of this shape; anything else fails before any request. */
const INVITATION = /^[A-Za-z0-9_-]{43}$/;
/** A failed connect this slow may have exhausted at least one SDK access-call timeout. */
export const LIKELY_TIMEOUT_MS = ACCESS_TIMEOUT_MS - 500;

/** The SDK refused a 2xx JSON redeem reply: the invitation was probably spent, and no session is left. */
const REJECTED = 'enrollment-response-rejected';

/** Access states that need the user (or a retry) before feedback can be delivered. */
const ACCESS_PROBLEMS = new Set(['offline', 'expired', 'access-required', 'connection-uncertain', REJECTED, 'storage-unavailable', 'migration-required']);
/** In-between states, logged at debug only. */
const ACCESS_TRANSIENT = new Set(['checking', 'connecting', 'disconnecting']);

/** Codes that say a report wasn't saved. After any other failed save, it may have been. */
const NOT_SAVED = new Set(['storage-full', 'invalid-input']);

/** The SDK's per-report cap on breadcrumbs. */
const MAX_REPORT_BREADCRUMBS = 40;
/** How long a diagnostics excerpt keeps retrying in memory before it is given up. */
const EXCERPT_RETRY_MS = 15 * 60_000;
const EXCERPT_CHECK_MS = 30_000;

/** The report's own record of its diagnostics: the breadcrumb code for each outcome. */
export function diagnosticsBreadcrumbCode(outcome: FeedbackDiagnosticsOutcome): string {
  return outcome.status === 'queued' || outcome.status === 'attached' ? `diagnostics.${outcome.status}` : `diagnostics.${outcome.status}.${outcome.reason}`;
}

/** One breadcrumb as the SDK takes it: `atMs` in epoch ms, `code` never user text. */
export interface FeedbackBreadcrumb {
  kind: 'error' | 'performance' | 'event';
  atMs: number;
  code: string;
  value?: number;
}

/**
 * Fresh diagnostics for a carried image: a line's trace references stay only if they point at
 * the trace that came with the pixels, so nothing links the old image to an unrelated trace.
 */
function withoutOtherTraces(diagnostics: FeedbackDiagnostics, { traceId, incident }: Pick<FramebriarSnapshot, 'traceId' | 'incident'>): FeedbackDiagnostics {
  const carried = new Set<string | undefined>([traceId, ...(incident?.traces ?? []).map((trace) => trace.traceId)]);
  return {
    ...diagnostics,
    lines: diagnostics.lines.map((line) => {
      const attrs = line.attrs;
      if (!attrs || (!('traceId' in attrs) && !('spanId' in attrs))) return line;
      if (typeof attrs.traceId === 'string' && carried.has(attrs.traceId)) return line;
      return { ...line, attrs: Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'traceId' && key !== 'spanId')) };
    }),
  };
}

export type FeedbackLogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Local diagnostics sink (appLog in the app). Never pass secrets or user text in meta. */
export type FeedbackLog = (level: FeedbackLogLevel, msg: string, meta?: Record<string, unknown>) => void;

const errorMeta = (err: unknown): Record<string, unknown> => ({
  error: err instanceof Error ? err.message : String(err),
  ...(typeof (err as { code?: unknown })?.code === 'string' ? { code: (err as { code: string }).code } : {}),
});

/** SDK wording that reads as internals, by code. Electron passes only the message to the renderer. */
const USER_TEXT_BY_CODE: Readonly<Record<string, string>> = {
  'feedback-unavailable': 'Feedback isn\'t connected. Connect in Settings, Feedback.',
  'invalid-input': 'This report couldn\'t be saved. Close it and open a new report.',
  conflict: 'This report couldn\'t be saved. Close it and open a new report.',
  'secure-store-unavailable': 'Secure storage isn\'t available right now, so feedback can\'t be used.',
  'invalid-store': 'Saved feedback access couldn\'t be read. Connect again in Settings, Feedback.',
  busy: 'Feedback is busy. Try again.',
};

/**
 * Plain wording for what the renderer shows. The code stays for telemetry, and the SDK's own
 * text has already gone to the local log. Never throws.
 */
function withUserText(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const text = USER_TEXT_BY_CODE[String((err as { code?: unknown }).code)];
  if (text) err.message = text;
  else if (/framebriar/i.test(err.message)) err.message = 'Feedback isn\'t available right now.';
  return err;
}

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
   * Put diagnostics v1 in the report itself. Off, and the app must not turn it on until an
   * approved first live report has verified storage and readback. Once it's on, rolling
   * the API back strands reports over 16 KiB on a permanent 413 and silently strips smaller
   * ones, so a rollback needs a compatible ingestion path or coordinated recovery (#2658).
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
  state: 'disconnected', connected: false, enrolled: false, canCapture: false, notice: null, noticeReason: null, expiresAt: null,
});
const EMPTY_OUTBOX: FramebriarOutboxView = Object.freeze({
  state: 'checking', items: 0, bytes: 0, maxItems: 10, maxBytes: 32 * 1024 * 1024, blocked: 0, heldForEnrollment: 0, heldBytes: 0, releaseToken: null, retention: 'until-delivered-or-cleared',
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
      heldForEnrollment: outbox.heldForEnrollment,
      heldBytes: outbox.heldBytes,
      // The SDK's outbox doesn't refresh on this notice, so an older token can linger. It can't release.
      releaseToken: access.notice === REJECTED ? null : outbox.releaseToken,
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
  /**
   * What a Send with no flattened bytes sends: the capture, or the image a reopened draft carried.
   * Null once edits may exist, because then a Send has to bring its flattened bytes.
   */
  png: Buffer | null;
  /** What flattened bytes must fit. Moves down with each flattened image accepted. */
  size: { width: number; height: number } | null;
  /** The original's hash, so those bytes can be refused after it's dropped. Memory only, never logged. */
  captureSha: string;
}

interface Draft {
  /**
   * What goes to prepare() apart from the image. snapshot.png is always null: the shots hold the
   * bytes. snapshot.enrollmentRef is what binds the report to its enrollment.
   */
  snapshot: FramebriarSnapshot;
  /** Every window captured, then from the first Send that includes an image, only that one. */
  shots: Shot[];
  /** A Send has included an image, so its window can't change and its bytes are the source. */
  imageFixed?: boolean;
  /** Fixed by the first Send: it stays with the pixels, whatever the renderer says later. */
  context?: { scene: string; breadcrumbs: FeedbackBreadcrumb[] };
  /** A Send is running. A second one could leave two prepared reports able to save. */
  sending?: boolean;
  /** A report this draft has since replaced may have been saved, so both may be delivered. */
  earlierMayDeliver?: boolean;
  correlationSummary?: FeedbackCorrelationSummary;
  createdAt: number;
  /** Read once, when feedback opened: what is reviewed is what is sent. */
  diagnostics: FeedbackDiagnostics;
  /** Reports waiting in the outbox when feedback opened; undefined if it couldn't be read. */
  queuedAtCapture?: number;
  /** Fixed with the prepared report, so a retry records the same outcome. */
  diagnosticsOutcome?: FeedbackDiagnosticsOutcome;
  /** Once prepared, retry the same report identity even if saving had an uncertain outcome. */
  prepared?: { key: string; value: Promise<FramebriarPrepared>; mayBeSaved: boolean };
}

type CapturedShot = Shot & { png: Buffer };

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
      // Never the ref itself: it's only an identity for binding reports.
      fb.access.onEnrollmentChange(({ enrollmentRef }) => { this.log('info', 'Feedback enrollment changed', { enrolled: enrollmentRef !== null }); });
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
      throw withUserText(err);
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
      throw withUserText(err);
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
        ...(access.status().noticeReason && { noticeReason: access.status().noticeReason }),
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
      throw withUserText(err);
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
    const opened = await this.sdk().feedback.open().catch((err: unknown) => {
      if ((err as { code?: unknown } | null)?.code !== 'enrollment-changed') throw err;
      throw Object.assign(new Error('Feedback access changed while this report was opening. Try again.'), { code: 'enrollment-changed' });
    });
    const queuedAtCapture = this.readQueued();
    const shots: CapturedShot[] = [];
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
      shots.push({ shotId: `s${i}`, label: source.label, png, size: pngSize(png), captureSha: sha256(png) });
    }
    return this.addDraft(opened, correlation, diagnostics, queuedAtCapture, shots);
  }

  private addDraft(opened: FramebriarSnapshot, correlation: FeedbackCorrelationSnapshot, diagnostics: FeedbackDiagnostics, queuedAtCapture: number | undefined, shots: CapturedShot[], carried: Pick<Draft, 'imageFixed' | 'context' | 'earlierMayDeliver'> = {}): FeedbackCaptureResult {
    const snapshot: FramebriarSnapshot = { ...opened, ...correlation.data, png: null };
    const draftId = randomUUID();
    this.drafts.set(draftId, { snapshot, shots, correlationSummary: correlation.summary, createdAt: this.now(), diagnostics, queuedAtCapture, ...carried });
    while (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value as string);
    const previews = shots.map((shot) => ({ shotId: shot.shotId, label: shot.label, preview: `data:image/png;base64,${shot.png.toString('base64')}` }));
    return { draftId, preview: previews[0]?.preview ?? null, shots: previews, ...(correlation.summary && { correlation: correlation.summary }), diagnostics, ...(this.deps.reportDiagnosticsField === true && { diagnosticsInReport: true as const }) };
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

  /** Never throws: without a count, diagnostics v1 leaves it out. */
  private readQueued(): number | undefined {
    try {
      return this.sdk().outbox.status().items;
    } catch { // telemetry-exempt: only omits an optional count from the report
      return undefined;
    }
  }

  /** What this report will say about its diagnostics. Never throws. */
  private diagnosticsOutcome(fb: Framebriar, draft: Draft, include: boolean, inReport: boolean): FeedbackDiagnosticsOutcome {
    if (draft.diagnostics.status === 'none') return { status: 'none', reason: draft.diagnostics.reason ?? 'no_lines' };
    if (!include) return { status: 'left_out', reason: 'reporter' };
    if (inReport) {
      // The lines travel in the report, through the outbox, so SDK access doesn't matter. Only
      // lines the contract refuses can stop them, and then the report mustn't claim them.
      const { state, lines } = toDiagnosticsV1(draft.diagnostics, { status: 'attached', lines: draft.diagnostics.lines.length });
      return state === 'attached' ? { status: 'attached', lines } : { status: 'none', reason: 'collection_failed' };
    }
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
   * Commit reviewed feedback to the durable outbox. With includeScreenshot the image goes
   * along (imageToSend); otherwise it's text-only (notes required). Resolves once the report is
   * saved locally; delivery and its receipt ("Received") come later. If the enrollment changed,
   * nothing is saved and it resolves with a new draft to review instead.
   */
  async send(input: FeedbackSendInput): Promise<FeedbackSendResult> {
    // Never the image itself: only whether a drawing came along.
    const meta = { draftId: input.draftId ?? null, includeScreenshot: input.includeScreenshot, notesLength: input.notes?.length ?? 0, annotated: input.annotatedPng !== undefined, shotId: input.shotId ?? null };
    // Read before sending: a committed report consumes its draft.
    const shots = this.drafts.get(input.draftId)?.shots.length ?? 0;
    const inReport = this.deps.reportDiagnosticsField === true;
    try {
      const result = await this.sendInner(input, inReport);
      if (result.status === 'enrollment-changed') {
        this.log('info', 'Feedback reopened after an enrollment change', { ...meta, reopenedDraftId: result.draft.draftId });
        recordFeedbackFailed('submit', 'enrollment-changed');
        return result;
      }
      // With the field on, access is no part of sending: a failed read can't undo a saved report.
      const state = inReport ? this.afterSave(() => this.fb?.access.status().state) : this.fb?.access.status().state;
      // The report id links a Framebriar report to this user's local record (a diag line,
      // through appLog); telemetry can't carry it. Don't drop it.
      this.log('info', 'Feedback saved for delivery', { ...meta, id: result.id, status: result.status, state, diagnostics: result.diagnostics ? diagnosticsBreadcrumbCode(result.diagnostics) : null });
      recordFeedbackSubmitted({ screenshot: input.includeScreenshot, annotated: input.includeScreenshot && input.annotatedPng !== undefined, shots, accessState: state ?? 'stopped' });
      return result;
    } catch (err) {
      this.log('warn', 'Feedback send failed', { ...meta, ...errorMeta(err) });
      if (!this.isStartFailure(err)) recordFeedbackFailed('submit', feedbackErrorClass(err));
      throw this.withQueueHint(withUserText(err));
    }
  }

  /** Saved reports take up capacity, so a full queue can consist entirely of ones that can't go yet. Never throws. */
  private withQueueHint(err: unknown): unknown {
    if (!(err instanceof Error) || (err as { code?: unknown }).code !== 'storage-full') return err;
    let held = 0;
    let saved = 0;
    try {
      held = this.fb?.outbox.status().heldForEnrollment ?? 0;
      if (this.fb?.access.status().notice === REJECTED) saved = this.fb.outbox.status().items;
    } catch { // telemetry-exempt: only omits a hint from an error that is already reported
      return err;
    }
    if (held > 0) err.message += ` ${held} held ${held === 1 ? 'report takes' : 'reports take'} up space. You can send or clear them in Settings, Feedback.`;
    else if (saved > 0) err.message += ` ${saved} saved ${saved === 1 ? 'report takes' : 'reports take'} up space. Settings, Feedback says how to send or clear them.`;
    return err;
  }

  /** Never throws. */
  private afterSave<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch (err) { // telemetry-exempt: the report is already saved; logged for diagnosis
      this.log('warn', 'Feedback status could not be read after saving', errorMeta(err));
      return undefined;
    }
  }

  private async sendInner(input: FeedbackSendInput, inReport: boolean): Promise<FeedbackSendResult> {
    await this.start();
    await this.recheckStorage();
    const fb = this.sdk();
    if (!input.draftId) throw Object.assign(new Error('Open feedback again to send a report.'), { code: 'draft-required' });
    const draft = this.drafts.get(input.draftId);
    if (!draft) throw Object.assign(new Error('This feedback draft expired. Open feedback again.'), { code: 'screenshot-expired' });
    if (draft.sending) throw Object.assign(new Error('This report is already being sent.'), { code: 'busy' });
    draft.sending = true;
    try {
      return await this.sendDraft(fb, input, draft, inReport);
    } finally {
      draft.sending = false;
    }
  }

  private async sendDraft(fb: Framebriar, input: FeedbackSendInput, draft: Draft, inReport: boolean): Promise<FeedbackSendResult> {
    const notes = input.notes ?? '';
    if (!input.includeScreenshot && notes.trim() === '') throw Object.assign(new Error('Add a note to send feedback without a screenshot.'), { code: 'notes-required' });
    const png = this.imageToSend(draft, input);
    draft.context ??= {
      scene: input.scene && SCENE.test(input.scene) ? input.scene : 'app',
      breadcrumbs: (this.deps.breadcrumbs?.() ?? []).slice(0, MAX_REPORT_BREADCRUMBS - 1),
    };
    const { scene } = draft.context;
    const includeDiagnostics = input.includeDiagnostics === true;
    // The hash is memory-only and never logged/exported, and leaves out the enrollment ref. Unchanged content retries
    // the prepared report under its id, so a possibly saved report isn't delivered twice.
    const key = createHash('sha256').update(JSON.stringify({ notes, scene, includeCorrelation: input.includeCorrelation !== false, includeDiagnostics, png: png ? sha256(png) : null })).digest('hex');
    if (draft.prepared && draft.prepared.key !== key) {
      // Changed content is a new report with a new id. The old one can never send from here, but it may already be saved.
      draft.earlierMayDeliver ||= draft.prepared.mayBeSaved;
      draft.prepared = undefined;
      draft.diagnosticsOutcome = undefined;
    }
    const outcome = draft.diagnosticsOutcome ?? this.diagnosticsOutcome(fb, draft, includeDiagnostics, inReport);
    // First and within the cap, so the report always says what became of its diagnostics.
    const breadcrumbs: FeedbackBreadcrumb[] = [
      { kind: 'event', atMs: this.now(), code: diagnosticsBreadcrumbCode(outcome), ...((outcome.status === 'queued' || outcome.status === 'attached') && { value: outcome.lines }) },
      ...draft.context.breadcrumbs,
    ];
    let cached = draft.prepared;
    if (!cached) {
      const fresh = {
        key,
        mayBeSaved: false,
        value: fb.feedback.prepare({
          notes,
          context: { scene, breadcrumbs },
          ...(inReport && { diagnostics: toDiagnosticsV1(draft.diagnostics, outcome, { queued: draft.queuedAtCapture }) }),
          ...draft.snapshot,
          png,
          ...(input.includeCorrelation === false && { incident: null, traceId: undefined, spanId: undefined }),
        }),
      };
      cached = fresh;
      draft.prepared = fresh;
      draft.diagnosticsOutcome = outcome;
      // A prepare failure has not reached storage and may safely be corrected.
      void fresh.value.catch(() => { if (draft.prepared === fresh) { draft.prepared = undefined; draft.diagnosticsOutcome = undefined; } });
    }
    let prepared: FramebriarPrepared | undefined;
    let ack: FramebriarSubmitAck;
    try {
      prepared = await cached.value;
      // This instance has no telemetry, so the flag only decides what becomes of a field the
      // report carries: false rewrites it to left_out. The field already holds the user's choice.
      ack = await fb.feedback.submit(prepared, { includeDiagnostics: inReport });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'enrollment-changed') return this.reopenDraft(input.draftId, draft, png);
      if (prepared && !NOT_SAVED.has(String(code))) cached.mayBeSaved = true;
      throw err;
    }
    // Only a committed report consumes the draft: a failed save (e.g. storage full) keeps
    // the reviewed screenshot so the user can retry.
    this.drafts.delete(input.draftId);
    if (inReport) this.afterSave(() => this.emit());
    else this.emit();
    // Never `attached`: those lines are already in the report, and would go twice.
    if (outcome.status === 'queued') {
      const { traceId, spanId } = prepared.report as { traceId?: string; spanId?: string };
      this.sendExcerpt(fb, ack.id, draft.diagnostics.lines, traceId && spanId ? { traceId, spanId } : {});
    }
    return { id: ack.id, status: ack.status, diagnostics: outcome, ...(draft.earlierMayDeliver && { earlierMayDeliver: true as const }) };
  }

  /**
   * The enrollment changed, so the prepared report can never send. Open a new report with a new
   * id and ref, keeping only the image reviewed for this Send (the renderer keeps the text). That
   * image keeps the capture's provenance, so old pixels never get fresh labels, and it's now the
   * draft's source. A report with no image takes fresh values. Diagnostics are always read again:
   * they have their own window and time. Until open() succeeds the old draft stays, unprepared,
   * and its old ref sends the next Send back here.
   */
  private async reopenDraft(draftId: string, draft: Draft, png: Buffer | null): Promise<FeedbackSendResult> {
    draft.earlierMayDeliver ||= draft.prepared?.mayBeSaved;
    draft.prepared = undefined;
    draft.diagnosticsOutcome = undefined;
    const correlation = png ? null : (this.deps.captureCorrelation ?? captureFeedbackCorrelation)(this.now());
    const fresh = this.readDiagnostics();
    let opened: FramebriarSnapshot;
    try {
      opened = await this.sdk().feedback.open();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'enrollment-changed') throw err;
      throw Object.assign(new Error('Feedback access changed while this report was opening. Choose Send again.'), { code: 'enrollment-changed' });
    }
    this.drafts.delete(draftId);
    const carried = { earlierMayDeliver: draft.earlierMayDeliver };
    if (!correlation) {
      const { label, captureSha } = draft.shots[0];
      const shot: CapturedShot = { shotId: 's0', label, png: png as Buffer, size: pngSize(png as Buffer), captureSha };
      const snapshot = { ...draft.snapshot, enrollmentRef: opened.enrollmentRef };
      return { status: 'enrollment-changed', draft: this.addDraft(snapshot, { data: snapshot, summary: draft.correlationSummary }, withoutOtherTraces(fresh, snapshot), this.readQueued(), [shot], { ...carried, imageFixed: true, context: draft.context }) };
    }
    return { status: 'enrollment-changed', draft: this.addDraft(opened, correlation, fresh, this.readQueued(), [], carried) };
  }

  /**
   * Queue the held reports for delivery under the current enrollment. The token must be the one
   * shown when the user confirmed, never one read here: if the enrollment or the held set moved
   * since, the SDK changes nothing and says stale-release.
   */
  async releaseHeldReports(releaseToken: string): Promise<FeedbackHeldReleaseResult> {
    await this.start();
    await this.recheckStorage();
    const { released, remaining, failed, code } = await this.sdk().outbox.releaseHeldReports({ releaseToken });
    this.log(failed > 0 || code ? 'warn' : 'info', 'Feedback held reports release', { released, remaining, failed, code: code ?? null });
    return { released, remaining, failed, ...(code && { code }), status: this.status() };
  }

  /** Discard the held reports only. Takes no token and sends nothing, so it works unenrolled. */
  async clearHeldReports(): Promise<FeedbackHeldClearResult> {
    await this.start();
    await this.recheckStorage();
    const { cleared, remaining, failed, code } = await this.sdk().outbox.clearHeldReports();
    this.log(failed > 0 || code ? 'warn' : 'info', 'Feedback held reports clear', { cleared, remaining, failed, code: code ?? null });
    return { cleared, remaining, failed, ...(code && { code }), status: this.status() };
  }

  /**
   * The bytes this Send carries, or null when it leaves the image out. The first Send ends
   * reversibility, whether or not it includes the image and whatever then happens to the save:
   * only the chosen window stays, and it can't change. From the first sign that edits may exist,
   * a Send with the image has to bring valid flattened bytes, and nothing here can send the
   * original. A Send that leaves the image out is such a sign, because the renderer doesn't say
   * whether it held edits. The capture's own bytes aren't a flattened image, so they count as none.
   */
  private imageToSend(draft: Draft, input: FeedbackSendInput): Buffer | null {
    if (!input.includeScreenshot) {
      if (!draft.imageFixed) for (const shot of draft.shots) shot.png = null;
      return null;
    }
    if (draft.shots.length === 0) throw Object.assign(new Error('This screenshot expired. Capture it again.'), { code: 'screenshot-expired' });
    const flattened = input.annotatedPng === undefined ? null : Buffer.from(input.annotatedPng, 'base64');
    const shot = input.shotId === undefined ? draft.shots[0] : draft.shots.find((s) => s.shotId === input.shotId);
    const edited = flattened !== null && sha256(flattened) !== shot?.captureSha;
    if (edited) for (const each of draft.shots) each.png = null;
    if (!shot) throw Object.assign(new Error('That screenshot is no longer available. Capture it again.'), { code: 'shot-unavailable' });
    draft.shots = [shot];
    draft.imageFixed = true;
    if (edited) return this.checkedFlattened(shot, flattened);
    if (!shot.png) throw Object.assign(new Error('The original screenshot can\'t be sent after an earlier Send. Send this without the screenshot, or close it and open a new report.'), { code: 'flattened-required' });
    return shot.png;
  }

  /**
   * The renderer's flattened image (#2099), which is untrusted: a PNG within the size cap that
   * fits the shot. It's now what any later flatten has to fit, since it's the source.
   */
  private checkedFlattened(shot: Shot, flattened: Buffer): Buffer {
    if (flattened.length > MAX_PNG_BYTES) {
      throw Object.assign(new Error('The screenshot with your drawing is too large to send (8 MiB at most)'), { code: 'invalid-media' });
    }
    const size = pngSize(flattened);
    if (!size) throw Object.assign(new Error('The screenshot with your drawing is not a PNG image'), { code: 'invalid-media' });
    if (!shot.size || !fitsSource(size, shot.size)) {
      throw Object.assign(new Error("The screenshot with your drawing doesn't match the captured screenshot"), { code: 'invalid-media' });
    }
    shot.size = size;
    return flattened;
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
      ...(view.noticeReason && { noticeReason: view.noticeReason }),
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
export type ConnectFailureClass = Extract<FeedbackErrorClass, 'invitation-malformed' | 'busy' | 'storage-unavailable' | 'access-refused' | 'timeout' | 'connection-uncertain' | 'enrollment-response-rejected' | 'unknown'>;

/**
 * Best guess at why a connect returned false (the SDK reports only false). Exported for tests.
 */
export function connectFailureClass(invitation: string, before: string, state: string, notice: string | null, durationMs: number): ConnectFailureClass {
  if (!INVITATION.test(invitation)) return 'invitation-malformed';
  if (before === 'connecting' || before === 'disconnecting') return 'busy';
  if (state === 'storage-unavailable') return 'storage-unavailable';
  if (notice === 'access-required') return 'access-refused';
  if (notice === REJECTED) return REJECTED;
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
    case 'connection-uncertain': return 'request failed or the reply was not JSON; the server may still have accepted the invitation';
    case REJECTED: return 'the server replied, but the reply failed validation here; the invitation was probably used, see noticeReason';
    default: return 'unknown';
  }
}

/** Best guess at why a connect returned false, for the log. Exported for tests. */
export function connectFailureReason(invitation: string, before: string, state: string, notice: string | null, durationMs: number): string {
  return connectFailureText(connectFailureClass(invitation, before, state, notice, durationMs), invitation);
}
