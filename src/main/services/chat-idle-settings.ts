import { createManagedSettings } from './managed-settings';
import { CHAT_IDLE_SETTINGS } from '../../shared/settings-definitions';

/** The chat idle timeout setting (#2104). Registered with the other managed settings. */
export const chatIdleSettings = createManagedSettings(CHAT_IDLE_SETTINGS);

/** The idle timeout in ms; 0 means chat agents never idle-sleep. */
export function chatIdleTimeoutMs(): number {
  const minutes = chatIdleSettings.getSettings().idleTimeoutMinutes;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}
