/**
 * The Dispatcher's Behavior on the main side (#3045): the saved level, the
 * accessor other services read (the group chat, #3043; upkeep and check-ins,
 * #3040), and the models a level resolves to on a provider through the Auto
 * mapping. What each level means is in shared/dispatcher-behavior.ts.
 *
 * dispatcher-service applies the models to its two agents and reports the
 * level on DispatcherState; this module holds no agent state of its own beyond
 * the last Auto result per provider and level, so the state can say "Auto
 * isn't set up" without asking a CLI on every read.
 */

import {
  dispatcherBehaviorPlan,
  isDispatcherBehavior,
  normalizeDispatcherBehavior,
  resolveBehaviorModels,
  type DispatcherBehavior,
  type DispatcherBehaviorAuto,
  type DispatcherBehaviorModels,
  type DispatcherBehaviorPlan,
} from '../../../shared/dispatcher-behavior';
import { isPresetProvider } from '../../../shared/helper-routing';
import { resolveAutoLevel } from '../helper-routing';
import { getSettings, updateSettings } from './dispatcher-settings';

type BehaviorListener = (level: DispatcherBehavior) => void;
const listeners = new Set<BehaviorListener>();

/** The last Auto result per `provider:level`, from the last time the models were resolved. */
const lastAuto = new Map<string, DispatcherBehaviorAuto>();

/** The Dispatcher's Behavior level. Standard until a person picks another. */
export function getDispatcherBehavior(): DispatcherBehavior {
  return normalizeDispatcherBehavior(getSettings().behavior);
}

/** The current level's plan: the Auto level per agent and the frequency buckets. */
export function getDispatcherBehaviorPlan(): DispatcherBehaviorPlan {
  return dispatcherBehaviorPlan(getDispatcherBehavior());
}

/**
 * Called with the new level after it changes, from the composer chip, Settings
 * or a phone. Listeners run synchronously. Returns an unsubscribe function.
 */
export function onDispatcherBehaviorChanged(listener: BehaviorListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Save a level. Throws for anything that isn't one. Returns whether it changed. */
export async function saveDispatcherBehavior(level: unknown): Promise<boolean> {
  if (!isDispatcherBehavior(level)) throw new Error(`Unknown Behavior: ${String(level)}. Use light, standard or thorough.`);
  if (getSettings().behavior === level) return false;
  await updateSettings((current) => ({ ...current, behavior: level }));
  for (const listener of listeners) listener(level);
  return true;
}

/**
 * The models a level runs on for a provider, checked against the CLI's list
 * like a helper start. Remembers the outcome, so behaviorAuto reports it.
 */
export async function resolveDispatcherModels(provider: string, level: DispatcherBehavior = getDispatcherBehavior()): Promise<DispatcherBehaviorModels> {
  const result = await resolveBehaviorModels(provider, level, resolveAutoLevel);
  lastAuto.set(`${provider}:${level}`, result.ok === false ? { ready: false, code: result.code } : { ready: true });
  return result;
}

/**
 * Whether Auto gives the level its models on this provider, without asking a
 * CLI: a provider with no mapping never does, and otherwise the last
 * resolution decides, ready until one has run.
 */
export function behaviorAuto(provider: string | null | undefined, level: DispatcherBehavior = getDispatcherBehavior()): DispatcherBehaviorAuto {
  if (!provider) return { ready: true };
  if (!isPresetProvider(provider)) return { ready: false, code: 'auto_not_supported' };
  return lastAuto.get(`${provider}:${level}`) ?? { ready: true };
}

/** For tests. */
export function _resetDispatcherBehaviorForTesting(): void {
  lastAuto.clear();
  listeners.clear();
}
