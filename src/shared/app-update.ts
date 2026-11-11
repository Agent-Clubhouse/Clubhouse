export type AppUpdateMode = 'now' | 'when_idle';

export const APP_UPDATE_FAILURE_MESSAGES = {
  check: 'The update could not be checked.',
  download: 'The update could not be downloaded.',
  prepare: 'The installer could not be prepared.',
  install: 'The installer could not be applied. Update Clubhouse from the desktop.',
  missing: 'The installer is missing or out of date. Download the update again from the desktop.',
  restart: 'Restart failed. Request the update again.',
  version_changed: 'A newer update became available; request again.',
  feed: 'The update feed could not be verified. Request the update again.',
} as const;
export type AppUpdateFailureCategory = keyof typeof APP_UPDATE_FAILURE_MESSAGES;

/** Only this fixed message crosses devices; the original failure stays in cause for local logs. */
export class AppUpdateError extends Error {
  readonly cause?: unknown;

  constructor(readonly category: AppUpdateFailureCategory, options?: { cause?: unknown }) {
    super(APP_UPDATE_FAILURE_MESSAGES[category]);
    this.cause = options?.cause;
  }
}

export interface AppUpdateApproval {
  version: string;
  workingAgents: Array<{ agentId: string; name: string }>;
}

export interface AppUpdateRequest {
  requestId: string;
  state: 'pending_approval' | 'waiting_for_idle' | 'restarting' | 'failed' | 'cancelled';
  version: string;
  /** Approval expiry, or the idle deadline after approval. */
  expiresAt: string | null;
  error: string | null;
}

export interface AppUpdateStatus {
  state: 'none' | 'available' | 'downloading' | 'ready' | 'unsupported';
  currentVersion: string;
  availableVersion: string | null;
  /** Percent, 0 to 100. Windows downloads during installation. */
  downloadProgress: number;
  reason: string | null;
  request: AppUpdateRequest | null;
}

export const APP_UPDATE_CHANGED_EVENT = 'app_update:changed';
export const APP_UPDATE_IDLE_WAIT_MS = 30 * 60 * 1000;
