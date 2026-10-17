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

export interface FeedbackCaptureResult {
  draftId: string;
  /** data:image/png;base64 preview, or null when no screenshot could be taken. */
  preview: string | null;
}

export interface FeedbackSendInput {
  /** From capture(); omit for text-only feedback without a capture. */
  draftId?: string;
  notes: string;
  /** false sends the notes without the captured screenshot. */
  includeScreenshot: boolean;
  /** Where in Clubhouse feedback was given, e.g. 'agents' or 'settings'. A code, never user text. */
  scene?: string;
}

export interface FeedbackSendResult {
  id: string;
  /** Saved locally; "Received" arrives later in FeedbackStatus.received. */
  status: 'saved-local';
}
