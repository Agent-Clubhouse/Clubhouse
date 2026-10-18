/**
 * Chat idle timeout setting (#2104): how long a chat agent may sit idle before
 * it's put to sleep. Uses the managed settings factory (no custom IPC).
 */
import { createSettingsStore } from './settings-store-factory';
import { CHAT_IDLE_SETTINGS } from '../../shared/settings-definitions';

export const useChatIdleSettingsStore = createSettingsStore(
  CHAT_IDLE_SETTINGS as import('../../shared/settings-definitions').SettingsDefinition<Record<string, unknown>> & typeof CHAT_IDLE_SETTINGS,
);
