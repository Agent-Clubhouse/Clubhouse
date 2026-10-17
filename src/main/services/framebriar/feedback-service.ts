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
import { createFramebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import type { FeedbackCaptureResult, FeedbackSendInput, FeedbackSendResult, FeedbackStatus } from '../../../shared/feedback-types';

export const FRAMEBRIAR_APP_ID = 'clubhouse';
/** Reviewed drafts are dropped if the review isn't finished in time. */
const DRAFT_TTL_MS = 30 * 60_000;
/** Remembered "Received" acknowledgements, newest first. */
const RECEIPT_MEMORY = 20;
/** Open reviews kept at once (each holds a screenshot); the oldest is dropped beyond this. */
const MAX_DRAFTS = 5;
/** Framebriar's media limit (protocol LIMITS.media). */
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Scene codes the renderer may report; anything else becomes 'app'. */
const SCENE = /^[a-z][a-z0-9-]{0,39}$/;

export interface FeedbackServiceDeps {
  safeStorage: SafeStorageLike;
  dataDir: string;
  appVersion: string;
  isOnline: () => boolean;
  /** For tests: the SDK factory (defaults to the vendored createFramebriar). */
  create?: typeof createFramebriar;
  now?: () => number;
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

  constructor(private readonly deps: FeedbackServiceDeps) {
    this.now = deps.now ?? Date.now;
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
        telemetry: 'off',
        // No SDK-side capture: captureDraft grabs the calling window itself, so two
        // windows capturing at once can never get each other's screenshot.
        capture: () => Promise.resolve(null),
        isOnline: this.deps.isOnline,
        onAccessChange: () => this.emit(),
        onOutboxChange: () => this.emit(),
        onReceipt: (receipt) => this.noteReceipt(receipt),
      });
      this.fb = fb;
      await fb.start();
      this.emit();
    })().finally(() => { this.starting = null; });
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

  /** Redeem an invitation. Never retried automatically; the caller clears its field at once. */
  async connect(invitation: string): Promise<{ connected: boolean; status: FeedbackStatus }> {
    await this.start();
    const connected = await this.sdk().access.connect(invitation.trim());
    return { connected, status: this.status() };
  }

  /** Forget locally (queued feedback stays and is delivered after a later enrollment) and revoke. */
  async disconnect(): Promise<{ forgotten: boolean; revoked: boolean | null; status: FeedbackStatus }> {
    await this.start();
    const result = await this.sdk().access.disconnect();
    return { ...result, status: this.status() };
  }

  /**
   * Snapshot now, before any review UI is drawn, and return a draft id plus a data: URL
   * preview. `grab` must capture only Clubhouse's own window contents.
   */
  async captureDraft(grab: () => Promise<Buffer | null>): Promise<FeedbackCaptureResult> {
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
    await this.start();
    const fb = this.sdk();
    const draft = input.draftId ? this.drafts.get(input.draftId) : undefined;
    if (input.includeScreenshot && !draft?.snapshot.png) throw new Error('This screenshot expired. Capture it again.');
    const notes = input.notes ?? '';
    if (!input.includeScreenshot && notes.trim() === '') throw new Error('Add a note to send feedback without a screenshot.');
    const scene = input.scene && SCENE.test(input.scene) ? input.scene : 'app';
    const prepared = await fb.feedback.prepare({
      notes,
      context: { scene },
      ...(input.includeScreenshot && draft
        ? { ...draft.snapshot }
        : { png: null, ...(draft ? { capturedAt: draft.snapshot.capturedAt } : {}) }),
    });
    const ack = await fb.feedback.submit(prepared, { includeDiagnostics: false });
    // Only a committed report consumes the draft: a failed save (e.g. storage full) keeps
    // the reviewed screenshot so the user can retry.
    if (input.draftId) this.drafts.delete(input.draftId);
    this.emit();
    return { id: ack.id, status: ack.status };
  }

  cancel(draftId: string): void {
    this.drafts.delete(draftId);
  }

  async shutdown(): Promise<void> {
    this.drafts.clear();
    this.listeners.clear();
    const fb = this.fb;
    this.fb = null;
    await fb?.shutdown();
  }

  private sdk(): Framebriar {
    if (!this.fb) throw new Error('Feedback is not running');
    return this.fb;
  }

  private noteReceipt(receipt: FramebriarReceipt): void {
    if (!receipt?.id) return;
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
