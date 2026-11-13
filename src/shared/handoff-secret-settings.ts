/** Person-controlled project exceptions; paths are exact portable relative names, never patterns. */
export interface HandoffSecretSettings {
  notSecretPaths: string[];
  historyActionIds: string[];
}
export const HANDOFF_SECRET_MAX_PATHS = 100;
export const HANDOFF_SECRET_MAX_SETTING_BYTES = 32 * 1024;
