/** Framebriar screenshot feedback: what main shows the renderer. Never carries tokens. */

export type FeedbackAccessState =
  | 'disconnected' | 'checking' | 'connecting' | 'connected' | 'offline' | 'stopped' | 'disconnecting'
  | 'expired' | 'access-required' | 'connection-uncertain' | 'storage-unavailable' | 'migration-required';

export type FeedbackNotice = 'expired' | 'access-required' | 'connection-uncertain' | 'migration-required';


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
  /** ISO time: the 30-day enrollment deadline. */
  expiresAt: string | null;
  storage: { available: true } | { available: false; reason: string };
  outbox: {
    state: string;
    /** Reports saved locally and not yet acknowledged by the server. */
    pending: number;
    /** Reports the server rejected permanently (kept, never retried in a loop). */
    blocked: number;
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
}

export interface FeedbackSendInput {
  /** From capture(); omit for text-only feedback without a capture. */
  draftId?: string;
  notes: string;
  /** false sends the notes without the captured screenshot. */
  includeScreenshot: boolean;
  /** Where in Clubhouse feedback was given, e.g. 'agents' or 'settings'. A code, never user text. */
  scene?: string;
  /**
   * The captured screenshot with the user's drawing baked in, as base64 PNG (no data:
   * prefix). Only used with includeScreenshot; it must match the capture's dimensions.
   */
  annotatedPng?: string;
  /** Which window's screenshot to send (FeedbackShot.shotId); the first when omitted. */
  shotId?: string;
}

/** The feedback capture shortcut's key label per platform (main's menu accelerator is CmdOrCtrl+Shift+2). */
export const FEEDBACK_CAPTURE_SHORTCUT_LABEL = { mac: '⌘⇧2', other: 'Ctrl+Shift+2' } as const;

/** Largest screenshot PNG feedback will send, decoded. */
export const FEEDBACK_MAX_PNG_BYTES = 8 * 1024 * 1024;

export interface FeedbackSendResult {
  id: string;
  /** Saved locally; "Received" arrives later in FeedbackStatus.received. */
  status: 'saved-local';
}
