/**
 * Chat runtime preferences: the `chat` flag and the per-provider Chat / CLI
 * choice. With the flag saved off, every agent runs in the terminal.
 */

import { createSettingsStore } from './settings-store';
import * as experimentalSettings from './experimental-settings';
import { readDisplaySettings, ownDisplayValue, displayInput, agentDisplayInput, type DisplayValue } from './display-settings';
import { CHAT_DRIVER_IDS } from '../../shared/chat';
import type { AgentRuntimeMode, ChatDriverId, ChatRuntimeSettings } from '../../shared/chat';

/** The flag's id in experimental settings (Settings › Agents & providers › Chat view). */
export const CHAT_EXPERIMENTAL_FLAG = 'chat';

/** Mode a provider gets when the flag is on and the user hasn't chosen. */
export const DEFAULT_CHAT_PROVIDER_MODE: AgentRuntimeMode = 'chat';

let chatTipRuntimeReadUncertain = false;
function validRuntimeSettings(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry) &&
    (!('mode' in entry) || entry.mode === 'chat' || entry.mode === 'terminal')
  );
}
const store = createSettingsStore<ChatRuntimeSettings>('chat-runtime-settings.json', {}, undefined, {
  audit: { key: 'chat_runtime' },
  displaySnapshot: true,
  onLoad: (result) => {
    if ('error' in result) {
      chatTipRuntimeReadUncertain = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
      return;
    }
    try { chatTipRuntimeReadUncertain = !validRuntimeSettings(JSON.parse(result.raw)); }
    catch { chatTipRuntimeReadUncertain = true; } // telemetry-exempt: the toast defers
  },
});

export function isChatTipRuntimeReadUncertain(): boolean { return chatTipRuntimeReadUncertain; }
export const getSettings = store.get;
export async function saveSettings(settings: ChatRuntimeSettings): Promise<void> {
  await store.save(settings);
  chatTipRuntimeReadUncertain = !validRuntimeSettings(settings);
}

/** Chat is on in every build unless the flag is saved off, or the file that may say so can't be read. */
export function isChatEnabled(): boolean {
  return experimentalSettings.isGraduatedFeatureOn(CHAT_EXPERIMENTAL_FLAG);
}

export interface ResolvedRuntimeMode {
  mode: AgentRuntimeMode;
  driver?: ChatDriverId;
}

/** Effective mode for a provider, honouring a per-agent override. */
export function resolveRuntimeMode(provider: string, agentOverride?: AgentRuntimeMode): ResolvedRuntimeMode {
  if (!isChatEnabled()) return { mode: 'terminal' };
  const setting = getSettings()[provider];
  // Copilot has one chat driver, the SDK. A saved driver from an older build
  // (copilot_acp, or copilot_sdk) is kept on disk for downgrades but never read.
  const driver: ChatDriverId | undefined = provider === 'copilot-cli' ? 'copilot_sdk' : setting?.driver;
  return {
    mode: agentOverride ?? setting?.mode ?? DEFAULT_CHAT_PROVIDER_MODE,
    ...(driver ? { driver } : {}),
  };
}

/** Passive next-start preference evidence; current runtime receipts are separate. */
export function readRuntimeModeForDisplay(provider: string, agentOverride?: unknown): DisplayValue<ResolvedRuntimeMode> {
  const own = agentOverride === undefined ? [] : [agentDisplayInput('Runtime override')];
  if (agentOverride !== undefined && agentOverride !== 'chat' && agentOverride !== 'terminal') return { state: 'unavailable', inputs: own };
  // Terminal is independent of both the flag and provider Chat driver.
  if (agentOverride === 'terminal') return { state: 'ok', value: { mode: 'terminal' }, inputs: own };
  const flag = experimentalSettings.readGraduatedFlagForDisplay(CHAT_EXPERIMENTAL_FLAG);
  const flagInputs = [...own, ...flag.inputs];
  if (flag.state !== 'ok') return { state: 'unavailable', inputs: flagInputs };
  if (!flag.value) return { state: 'ok', value: { mode: 'terminal' }, inputs: flagInputs };
  const evidence = readDisplaySettings(store, 'chat-runtime-settings.json');
  const inputs = [...flagInputs, displayInput('Provider runtime preference', evidence)];
  if (evidence.state !== 'ok') return { state: 'unavailable', inputs };
  const raw = ownDisplayValue(evidence.raw, provider);
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) return { state: 'unavailable', inputs };
  const setting = (raw ?? {}) as Record<string, unknown>;
  const configuredMode = ownDisplayValue(setting, 'mode');
  const mode = agentOverride !== undefined ? agentOverride : configuredMode !== undefined ? configuredMode : DEFAULT_CHAT_PROVIDER_MODE;
  if (mode !== 'chat' && mode !== 'terminal') return { state: 'unavailable', inputs };
  if (mode === 'terminal') return { state: 'ok', value: { mode }, inputs };
  const configuredDriver = ownDisplayValue(setting, 'driver');
  // Retired Copilot driver keys remain ignored exactly as in the launch resolver.
  const driver = provider === 'copilot-cli' ? 'copilot_sdk' : configuredDriver;
  if (driver !== undefined && (typeof driver !== 'string' || !CHAT_DRIVER_IDS.includes(driver as ChatDriverId))) return { state: 'unavailable', inputs };
  return { state: 'ok', value: { mode, ...(driver ? { driver: driver as ChatDriverId } : {}) }, inputs };
}
