/**
 * The Dispatcher's Behavior (#3045): one setting, Light, Standard or Thorough,
 * that covers which models it uses and how often it works on its own. This is
 * the one place that says what each level means. Main and renderer both read
 * it, and the upkeep and check-in Actions (#3040) read the frequency buckets.
 *
 * Models come from the Auto mapping (shared/helper-routing.ts): each level
 * names an Auto level per role, and the provider's mapping turns that into a
 * model and effort (services/helper-routing.ts resolveAutoLevel). A provider
 * with no mapping (any provider without presets) keeps the model it has, and
 * the frequencies still apply.
 *
 * Frequencies are named buckets, never times. What a bucket means in minutes
 * belongs to #3040 and can be tuned without touching this table, and no UI
 * text promises an exact frequency.
 */

import type { AutoLevel } from './helper-routing';

export const DISPATCHER_BEHAVIORS = ['light', 'standard', 'thorough'] as const;
export type DispatcherBehavior = (typeof DISPATCHER_BEHAVIORS)[number];

export const DEFAULT_DISPATCHER_BEHAVIOR: DispatcherBehavior = 'standard';

export function isDispatcherBehavior(value: unknown): value is DispatcherBehavior {
  return (DISPATCHER_BEHAVIORS as readonly unknown[]).includes(value);
}

/** A saved value, or the default for anything missing or unknown. Never throws. */
export function normalizeDispatcherBehavior(value: unknown): DispatcherBehavior {
  return isDispatcherBehavior(value) ? value : DEFAULT_DISPATCHER_BEHAVIOR;
}

/**
 * The Dispatcher's two agents (#3036): `chat`, the one the user talks to, and
 * `work`, the one that does the work. No user-facing text names them.
 */
export const DISPATCHER_ROLES = ['chat', 'work'] as const;
export type DispatcherRole = (typeof DISPATCHER_ROLES)[number];

/** How often it checks in on agents by itself. `none` runs no check-ins at all. */
export const CHECK_IN_FREQUENCIES = ['none', 'occasionally', 'frequently'] as const;
export type CheckInFrequency = (typeof CHECK_IN_FREQUENCIES)[number];

/** When memory upkeep runs: always nightly, plus after idle stretches for the higher levels. */
export const UPKEEP_FREQUENCIES = ['nightly', 'nightly_and_long_idle', 'nightly_and_each_idle'] as const;
export type UpkeepFrequency = (typeof UPKEEP_FREQUENCIES)[number];

export interface DispatcherBehaviorPlan {
  /** The Auto level each agent runs on. */
  models: Readonly<Record<DispatcherRole, AutoLevel>>;
  checkIns: CheckInFrequency;
  upkeep: UpkeepFrequency;
}

/**
 * What each level means. Light: the fast tier for both, no check-ins, nightly
 * upkeep. Standard: balanced for both, occasional check-ins. Thorough: the
 * strongest model for the work and balanced for the chat, frequent check-ins.
 * Thorough's work uses Auto's maximum, which follows Hard until a person
 * maps it (AUTO_LEVEL_FOLLOWS).
 */
export const DISPATCHER_BEHAVIOR_PLANS: Readonly<Record<DispatcherBehavior, DispatcherBehaviorPlan>> = {
  light: { models: { chat: 'easy', work: 'easy' }, checkIns: 'none', upkeep: 'nightly' },
  standard: { models: { chat: 'medium', work: 'medium' }, checkIns: 'occasionally', upkeep: 'nightly_and_long_idle' },
  thorough: { models: { chat: 'medium', work: 'maximum' }, checkIns: 'frequently', upkeep: 'nightly_and_each_idle' },
};

export function dispatcherBehaviorPlan(level: unknown): DispatcherBehaviorPlan {
  return DISPATCHER_BEHAVIOR_PLANS[normalizeDispatcherBehavior(level)];
}

/** The words for each level. They say "occasionally" and "frequently", never a time. */
export const DISPATCHER_BEHAVIOR_LABELS: Readonly<Record<DispatcherBehavior, { label: string; description: string }>> = {
  light: { label: 'Light', description: 'Fast models, and it doesn’t check in on its own. Keeps usage low.' },
  standard: { label: 'Standard', description: 'Balanced models. Checks in on your agents occasionally.' },
  thorough: { label: 'Thorough', description: 'The strongest models for the work. Checks in frequently.' },
};

/**
 * Whether the provider's Auto mapping can give this level its models.
 * `auto_not_supported`: the provider has no mapping at all (no presets).
 * `no_valid_mapping`: it has one, but nothing it maps for this level is offered now.
 */
export type DispatcherBehaviorAuto =
  | { ready: true }
  | { ready: false; code: 'auto_not_supported' | 'no_valid_mapping' };

/** The Behavior as main reports it on DispatcherState. */
export interface DispatcherBehaviorState {
  level: DispatcherBehavior;
  /** The provider the Dispatcher runs on, or null before it was created. */
  provider: string | null;
  auto: DispatcherBehaviorAuto;
}

export const DEFAULT_DISPATCHER_BEHAVIOR_STATE: DispatcherBehaviorState = {
  level: DEFAULT_DISPATCHER_BEHAVIOR,
  provider: null,
  auto: { ready: true },
};

/**
 * The line shown when Auto can't give the models, or null when it can.
 * `providerName` is the provider's display name.
 */
export function behaviorAutoNote(auto: DispatcherBehaviorAuto, providerName: string): string | null {
  if (auto.ready === true) return null;
  if (auto.code === 'auto_not_supported') {
    return `Auto doesn’t support ${providerName} yet, so it runs on ${providerName}’s default model. Behavior still sets how often it checks in.`;
  }
  return `Auto has no model for this level on ${providerName} right now, so it keeps the model it has until Auto is set up.`;
}

/** "Set up Auto" is offered only where setting up the mapping can fix it. */
export function canSetUpAuto(auto: DispatcherBehaviorAuto): boolean {
  return auto.ready === false && auto.code === 'no_valid_mapping';
}

/** One resolved model per role, or why Auto couldn't give them. */
export type DispatcherBehaviorModels =
  | { ok: true; models: Record<DispatcherRole, { model: string; effort: string | null }> }
  | { ok: false; code: 'auto_not_supported' | 'no_valid_mapping'; message: string };

type LevelResolution =
  | { ok: true; model: string; effort: string | null }
  | { ok: false; code: 'auto_not_supported' | 'no_valid_mapping'; message: string };

/**
 * The models a level runs on for a provider, through `resolve` (main passes
 * resolveAutoLevel). Each Auto level is resolved once. The first failure wins:
 * a level is all or nothing, so the two agents never end up on mismatched tiers.
 */
export async function resolveBehaviorModels(
  provider: string,
  level: DispatcherBehavior,
  resolve: (provider: string, level: AutoLevel) => Promise<LevelResolution>,
): Promise<DispatcherBehaviorModels> {
  const plan = dispatcherBehaviorPlan(level);
  const cache = new Map<AutoLevel, Promise<LevelResolution>>();
  const models = {} as Record<DispatcherRole, { model: string; effort: string | null }>;
  for (const role of DISPATCHER_ROLES) {
    const auto = plan.models[role];
    if (!cache.has(auto)) cache.set(auto, resolve(provider, auto));
    const result = await cache.get(auto)!;
    if (result.ok === false) return { ok: false, code: result.code, message: result.message };
    models[role] = { model: result.model, effort: result.effort };
  }
  return { ok: true, models };
}
