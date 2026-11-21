import { readDisplaySettings, ownDisplayValue, displayInput, agentDisplayInput, type DisplayValue } from './display-settings';
import type { ResolvedIdleSleep } from '../../shared/idle-sleep';
import { createManagedSettings } from './managed-settings';
import { CHAT_IDLE_SETTINGS } from '../../shared/settings-definitions';
import { normalizeIdleSleep, resolveIdleSleep, type AgentIdleSleep } from '../../shared/idle-sleep';

/** The chat idle timeout setting (#2104). Registered with the other managed settings. */
export const chatIdleSettings = createManagedSettings(CHAT_IDLE_SETTINGS, { displaySnapshot: true });

/**
 * Each durable agent's own auto-sleep (#2143), kept here so the idle timer can
 * read it synchronously. Set when a chat session starts and whenever the
 * agent's config changes it; agents without an entry inherit.
 */
const agentIdleSleep = new Map<string, AgentIdleSleep>();
const listeners = new Map<string, Set<() => void>>();

export function setAgentIdleSleep(agentId: string, value: unknown): void {
  const next = normalizeIdleSleep(value);
  const previous = agentIdleSleep.get(agentId) ?? 'inherit';
  if (next === 'inherit') agentIdleSleep.delete(agentId); else agentIdleSleep.set(agentId, next);
  if (next === previous) return;
  for (const listener of listeners.get(agentId) ?? []) {
    try {
      listener();
    } catch {
      // telemetry-exempt: the only listener re-arms a timer; one failing must not stop the others.
    }
  }
}

/** Called when the agent's auto-sleep changes, so a running session re-arms its timer. */
export function onAgentIdleSleepChange(agentId: string, listener: () => void): () => void {
  let set = listeners.get(agentId);
  if (!set) listeners.set(agentId, set = new Set());
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0 && listeners.get(agentId) === set) listeners.delete(agentId);
  };
}

/** The idle timeout in ms, agent over app; 0 means the agent never idle-sleeps. */
export function chatIdleTimeoutMs(agentId?: string): number {
  const own = agentId ? agentIdleSleep.get(agentId) : undefined;
  return resolveIdleSleep(own, chatIdleSettings.getSettings().idleTimeoutMinutes).minutes * 60_000;
}

/** For tests. */
export function clearAgentIdleSleep(): void {
  agentIdleSleep.clear();
  listeners.clear();
}

/** Preserve agent/host provenance and known Never=0 without loading the ordinary store. */
export function readIdleSleepForDisplay(value: unknown): DisplayValue<ResolvedIdleSleep> {
  if (value === 'never' || typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { state: 'ok', value: resolveIdleSleep(value, 0), inputs: [agentDisplayInput('Auto-sleep override')] };
  }
  if (value !== undefined && value !== 'inherit') return { state: 'unavailable', inputs: [agentDisplayInput('Auto-sleep override')] };
  const evidence = readDisplaySettings(chatIdleSettings.store, CHAT_IDLE_SETTINGS.filename), inputs = [displayInput('Host auto-sleep default', evidence)];
  if (evidence.state !== 'ok') return { state: 'unavailable', inputs };
  const configured = ownDisplayValue(evidence.raw, 'idleTimeoutMinutes');
  const minutes = configured === undefined ? CHAT_IDLE_SETTINGS.defaults.idleTimeoutMinutes : configured;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return { state: 'unavailable', inputs };
  return { state: 'ok', value: resolveIdleSleep('inherit', minutes), inputs };
}
