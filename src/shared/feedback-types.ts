/** Framebriar screenshot feedback: what main shows the renderer. Never carries tokens. */

export type FeedbackAccessState =
  | 'disconnected' | 'checking' | 'connecting' | 'connected' | 'offline' | 'stopped' | 'disconnecting'
  | 'expired' | 'access-required' | 'connection-uncertain' | 'enrollment-response-rejected' | 'storage-unavailable' | 'migration-required';

export type FeedbackNotice = 'expired' | 'access-required' | 'connection-uncertain' | 'enrollment-response-rejected' | 'migration-required';


export interface FeedbackStatus {
  /** The SDK is running (it starts with the app). */
  started: boolean;
  state: FeedbackAccessState;
  connected: boolean;
  enrolled: boolean;
  /** Show the Feedback button only when true. */
  canCapture: boolean;
  /** Persistent notice to show outside Settings until replaced or Disconnect. */
  notice: FeedbackNotice | null;
  /** ISO time: the enrollment deadline, set per invitation (30 days by default, up to 365). */
  expiresAt: string | null;
  storage: { available: true } | { available: false; reason: string };
  outbox: {
    state: string;
    /** Reports saved locally and not yet acknowledged by the server. */
    pending: number;
    /** Reports the server rejected permanently (kept, never retried in a loop). */
    blocked: number;
    /** Retained unchanged until the current service session supports incident metadata. */
    correlationWaiting?: number;
    /** Part of pending: reports saved under another enrollment, which wait for the user's choice. */
    heldForEnrollment: number;
    heldBytes: number;
    /** Opaque, what a release confirms. Null when nothing is held or there's no active enrollment. */
    releaseToken: string | null;
    bytes: number;
    maxItems: number;
    maxBytes: number;
  };
  /** Report ids the server acknowledged ("Received"), newest first, this app run. */
  received: string[];
}

/** One Clubhouse window's screenshot in a draft (#2100). */
export interface FeedbackShot {
  shotId: string;
  /** The window, e.g. "Main window" or a pop-out's title. */
  label: string;
  /** data:image/png;base64 preview. */
  preview: string;
}

export interface FeedbackCaptureResult {
  draftId: string;
  /** data:image/png;base64 preview of the first shot, or null when no screenshot could be taken. */
  preview: string | null;
  /** Every window captured; the first is the window feedback started from. */
  shots: FeedbackShot[];
  correlation?: FeedbackCorrelationSummary;
  /** Recent diagnostics to review (#2658); what is shown here is exactly what can be sent. */
  diagnostics?: FeedbackDiagnostics;
  /** Set when reviewed diagnostics would go in the report itself rather than separately. */
  diagnosticsInReport?: true;
}

/** The bounds on a report's diagnostics, and how long Framebriar's telemetry store keeps them. */
export const FEEDBACK_DIAGNOSTICS = { windowMinutes: 30, maxLines: 200, maxBytes: 48 * 1024, retentionDays: 30 } as const;

/** One allowlisted log line: never a raw message or raw meta (feedback-diagnostics.ts). */
export interface FeedbackDiagnosticLine {
  /** ISO time. */
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  ns: string;
  /** A fixed name for what happened, never the log message. */
  event: string;
  attrs?: Record<string, string | number>;
}

/** Why a report has no diagnostics. */
export type FeedbackDiagnosticsNoneReason = 'no_lines' | 'collection_failed' | 'no_review' | 'not_connected';

export interface FeedbackDiagnostics {
  status: 'available' | 'none';
  reason?: FeedbackDiagnosticsNoneReason;
  windowStart: string;
  windowEnd: string;
  lines: FeedbackDiagnosticLine[];
  bytes: number;
  /** Recent lines past the line or byte bound, the oldest, left out. */
  dropped: number;
}

/**
 * What happened to a report's diagnostics. `queued`: they travel apart from the report, in
 * memory, and are lost if Clubhouse quits before they are sent. `attached`: they are in the
 * report itself, saved in the outbox with it.
 */
export type FeedbackDiagnosticsOutcome =
  | { status: 'queued'; lines: number }
  | { status: 'attached'; lines: number }
  | { status: 'left_out'; reason: 'reporter' }
  | { status: 'none'; reason: FeedbackDiagnosticsNoneReason };

export interface FeedbackCorrelationSummary {
  scope: 'incident' | 'trace-only';
  capturedAt: string;
  traceCount: number;
  phoneCount: number;
  hostCount: number;
  connectionCount: number;
}

export interface FeedbackSendInput {
  /** From capture(). A report is always one the user reviewed. */
  draftId: string;
  notes: string;
  /** false sends the notes without the captured screenshot. */
  includeScreenshot: boolean;
  /** false removes the opening snapshot's incident and legacy trace/span references. */
  includeCorrelation?: boolean;
  /** true sends the diagnostics reviewed with this draft. Anything else leaves them out. */
  includeDiagnostics?: boolean;
  /** Where in Clubhouse feedback was given, e.g. 'agents' or 'settings'. A code, never user text. */
  scene?: string;
  /**
   * The flattened image: the screenshot with the user's edits baked in, as base64 PNG (no
   * data: prefix). It must be the size of the image it was made from, or fitted down from it with
   * the same aspect ratio. Once a Send has brought one, every later Send with the image has to
   * bring one too: main never falls back to the original. A Send that leaves the image out brings
   * it as well, if there are marks: the report has no media, but the edits are final all the same.
   * A draft reopened with a flattened image needs it on every Send with the image: its own bytes,
   * or a new flatten if there are marks.
   */
  annotatedPng?: string;
  /**
   * Which window's screenshot this Send is about (FeedbackShot.shotId); the first when omitted.
   * Also on a Send that leaves the image out: the first Send fixes the window either way.
   */
  shotId?: string;
  /**
   * Only on a Send that leaves the image out and brings no flattened image: the window named by
   * shotId, which it needs, has no edits, so main may keep its capture for a later Send. Without
   * both, main assumes there may be edits and drops the capture. It only keeps what main still
   * holds. It never brings a capture back.
   */
  noEdits?: true;
}

/** The feedback capture shortcut's key label per platform (main's menu accelerator is CmdOrCtrl+Shift+2). */
export const FEEDBACK_CAPTURE_SHORTCUT_LABEL = { mac: '⌘⇧2', other: 'Ctrl+Shift+2' } as const;

/** Largest screenshot PNG feedback will send, decoded. */
export const FEEDBACK_MAX_PNG_BYTES = 8 * 1024 * 1024;

export type FeedbackSendResult =
  | {
    id: string;
    /** Saved locally; "Received" arrives later in FeedbackStatus.received. */
    status: 'saved-local';
    diagnostics?: FeedbackDiagnosticsOutcome;
    /** An earlier version of this report may have been saved too, so both may be delivered. */
    earlierMayDeliver?: true;
  }
  /** Nothing was saved: the enrollment changed, and this new draft needs a review and a new Send. */
  | { status: 'enrollment-changed'; draft: FeedbackCaptureResult };

export type FeedbackHeldCode = 'stale-release' | 'not-enrolled' | 'storage-unavailable';

/** Released reports are queued for delivery, not delivered. */
export interface FeedbackHeldReleaseResult {
  released: number;
  remaining: number;
  failed: number;
  code?: FeedbackHeldCode;
  status: FeedbackStatus;
}

export interface FeedbackHeldClearResult {
  cleared: number;
  remaining: number;
  failed: number;
  code?: FeedbackHeldCode;
  status: FeedbackStatus;
}

/**
 * A feedback breadcrumb from an app window (#2303): a view change, a runtime
 * switch or a long-frame burst. Main checks the code against the few the
 * renderer may add (breadcrumbs.ts) and drops anything else.
 */
export interface RendererBreadcrumb {
  kind: 'error' | 'performance' | 'event';
  code: string;
  value?: number;
}
