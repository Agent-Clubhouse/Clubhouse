/**
 * The Dispatcher's personality and first-run setup on the main side (#3047).
 * What a personality is and what setup sends are in
 * shared/dispatcher-personality.ts and shared/dispatcher-setup.ts.
 *
 * - The personality and the setup state are saved in dispatcher-settings.json,
 *   not on either agent's record, so they are the same on every provider.
 *   dispatcher-service adds the personality to the chat's instructions.
 * - Until the user finishes setup or puts it off, nothing is saved: setup is
 *   pending whenever its agent exists. It is an upgrade when that agent was
 *   there before this version (dispatcher-service tells by a marker it writes
 *   only when it creates the agent).
 * - Try it out runs one prompt on the chosen model through the one-off
 *   runner (headless-prompt.ts): an empty folder, no session kept, no tools,
 *   no Clubhouse MCP. It never starts, wakes or messages an agent.
 */

import { resolveDispatcherModels } from './dispatcher-behavior';
import { getSettings, updateSettings } from './dispatcher-settings';
import { runHeadlessPrompt, type HeadlessPromptRequest, type HeadlessPromptResult } from '../headless-prompt';
import { appLog } from '../log-service';
import {
  normalizeDispatcherPersonality,
  tryItOutPrompt,
  type DispatcherPersonality,
} from '../../../shared/dispatcher-personality';
import {
  NO_DISPATCHER_SETUP,
  normalizeSetupState,
  type DispatcherSetupState,
  type DispatcherSetupStatus,
  type TryItOutRequest,
  type TryItOutResult,
} from '../../../shared/dispatcher-setup';
import type { DispatcherBehavior, DispatcherBehaviorAuto, DispatcherBehaviorModels } from '../../../shared/dispatcher-behavior';

const NS = 'core:dispatcher';
/** A first reply can include a CLI's cold start, so it gets longer than the rewrite step. */
export const TRY_IT_OUT_TIMEOUT_MS = 60_000;

/** Its personality. Concise until a person picks. */
export function getDispatcherPersonality(): DispatcherPersonality {
  return normalizeDispatcherPersonality(getSettings().personality);
}

/** Save a personality. Returns whether it changed. */
export async function saveDispatcherPersonality(value: unknown): Promise<boolean> {
  const next = normalizeDispatcherPersonality(value);
  const current = getDispatcherPersonality();
  const saved = getSettings().personality;
  if (saved && current.preset === next.preset && current.text === next.text) return false;
  await updateSettings((s) => ({ ...s, personality: next }));
  return true;
}

/**
 * Whether its agent was there before this version, as dispatcher-service last
 * found it: true for an upgrade, false for one Clubhouse created with setup,
 * null before the Dispatcher was first turned on here.
 */
let upgradeFound: boolean | null = null;

/** Called by dispatcher-service each time it brings the Dispatcher's agent in line. */
export function noteDispatcherOrigin(upgrade: boolean | null): void {
  upgradeFound = upgrade;
}

/**
 * Whether its view shows setup. Nothing saved means not set up yet, so a new
 * install writes nothing until the user acts: the default stays unwritten.
 * Nothing to show before its agent exists.
 */
export function getDispatcherSetup(): DispatcherSetupState {
  const saved = normalizeSetupState(getSettings().setup);
  if (saved) return saved;
  if (upgradeFound === null) return NO_DISPATCHER_SETUP;
  return { status: 'pending', upgrade: upgradeFound };
}

/** Save where setup stands. Keeps whether it was an upgrade. Returns whether it changed. */
export async function saveDispatcherSetupStatus(status: DispatcherSetupStatus): Promise<boolean> {
  const saved = normalizeSetupState(getSettings().setup);
  if (saved?.status === status) return false;
  const upgrade = saved?.upgrade ?? upgradeFound ?? false;
  await updateSettings((s) => ({ ...s, setup: { status, upgrade } }));
  return true;
}

/** For tests. */
export function _resetDispatcherSetupForTesting(): void {
  upgradeFound = null;
}

export interface TryItOutDeps {
  resolve?: (provider: string, level: DispatcherBehavior) => Promise<DispatcherBehaviorModels>;
  run?: (req: HeadlessPromptRequest) => Promise<HeadlessPromptResult>;
}

/**
 * Try it out (#3047): one sample question to the model the chat would use at
 * this Behavior on this provider, with this name and personality. A provider
 * without Auto models uses its default model, as the Dispatcher would. Saves
 * nothing and contacts no agent. Never throws.
 */
export async function tryDispatcherPersonality(req: TryItOutRequest, deps: TryItOutDeps = {}): Promise<TryItOutResult> {
  let model = 'default';
  let effort: string | null = null;
  try {
    const resolved = await (deps.resolve ?? resolveDispatcherModels)(req.provider, req.behavior);
    if (resolved.ok === true) ({ model, effort } = resolved.models.chat);
  } catch {
    // telemetry-exempt: Try it out falls back to the provider's default model, as the Dispatcher does without Auto
  }
  const result = await (deps.run ?? runHeadlessPrompt)({
    provider: req.provider,
    model,
    effort,
    prompt: tryItOutPrompt(req.name, req.personality),
    timeoutMs: TRY_IT_OUT_TIMEOUT_MS,
  }).catch((err: unknown): HeadlessPromptResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  appLog(NS, 'info', 'Dispatcher setup tried a personality', {
    meta: { provider: req.provider, behavior: req.behavior, preset: req.personality.preset, ok: result.ok },
  });
  if (result.ok === false) return { ok: false, error: `Couldn’t get a reply. ${result.error}` };
  return { ok: true, text: result.text };
}

/**
 * Whether Auto gives a level its models on a provider, asked of the CLI's
 * model list as a start would. For setup's Behavior step, before anything is
 * saved, so "Set up Auto" shows for the provider being picked.
 */
export async function checkDispatcherBehavior(provider: string, level: DispatcherBehavior): Promise<DispatcherBehaviorAuto> {
  try {
    const resolved = await resolveDispatcherModels(provider, level);
    return resolved.ok === false ? { ready: false, code: resolved.code } : { ready: true };
  } catch {
    // telemetry-exempt: shown as Auto not ready, which offers Set up Auto
    return { ready: false, code: 'no_valid_mapping' };
  }
}
