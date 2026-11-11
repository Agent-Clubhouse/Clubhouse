export type AppUpdateMode = 'now' | 'when_idle';

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
