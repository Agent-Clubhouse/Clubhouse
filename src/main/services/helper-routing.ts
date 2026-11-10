/**
 * Helper presets and what a start decides from them (#2671,
 * docs/helper-auto-routing.md). Stage 2: `difficulty` picks a model and effort on
 * one CLI. Explicit arguments win over a preset.
 *
 * Presets are checked against the CLI's own list when written and again when
 * used. A saved value is never rewritten: one no longer offered shows as stale,
 * the built-in is used if it's valid and says so, and otherwise the start is
 * refused. Nothing falls back to the CLI's default model.
 */

import { createHash, randomUUID } from 'crypto';
import {
  AUTO_CANDIDATE_PROVIDERS,
  AUTO_LEVEL_FOLLOWS,
  AUTO_LEVELS,
  BUILTIN_PRESETS,
  HELPER_DIFFICULTIES,
  HELPER_ROUTING_LABELS,
  HELPER_ROUTING_POLICY_VERSION,
  QUOTA_LOW_PERCENT,
  QUOTA_NEAR_LIMIT_PERCENT,
  QUOTA_STALE_MS,
  PRESET_PROVIDERS,
  routingLabel,
  isAutoBoundLevel,
  isAutoCandidateProvider,
  isAutoLevel,
  isHelperDifficulty,
  isPresetModel,
  isPresetProvider,
  type AutoCandidateProvider,
  type AutoLevel,
  type HelperDifficulty,
  type HelperAutoView,
  type HelperRouting,
  type HelperRoutingFallback,
  type HelperRoutingSkip,
  type QuotaDecisionView,
  type QuotaView,
  type QuotaWindowView,
  type HelperRoutingFieldSource,
  type HelperRoutingSettings,
  type HelperRoutingUpdate,
  type PresetCell,
  type PresetCellState,
  type PresetCellView,
  type PresetChoice,
  type PresetProvider,
  type PresetStaleReason,
  type ProviderRoutingView,
  type SavedPresets,
} from '../../shared/helper-routing';
import { isEffortValue } from '../../shared/agent-helpers';
import { getAllProviders, getProvider } from '../orchestrators';
import type { OrchestratorId } from '../orchestrators';
import { helperPresetsChanged } from '../telemetry/feature-events';
import { appLog } from './log-service';
import { forceProviderQuota, isProviderCoolingDown, readProviderQuota } from './provider-quota';
import { setRoutingPolicyListener } from './helper-routing-changes';
import { checkHelperEffort, checkHelperModel, modelListFor } from './model-check';
import * as orchestrationSettings from './orchestration-settings';
import { appendSettingsAudit, type SettingsAuditSurface } from './settings-audit';
import { AUTO_TIERS, decideAutoProvider, type AutoCandidate, type AutoDecision } from './helper-auto-policy';
import { _resetHelperAutoStateForTesting, reserveAutoDecision, rotationCursors } from './helper-auto-state';
import type { DecisionCandidate, DecisionQuota, DecisionQuotaWindow, HelperDecisionRecord } from '../../shared/telemetry/helper-usage-contract';
import { getSettings as getOrchestratorSettings } from './orchestrator-settings';
import { readProjectAgentDefaults, updateProjectAgentDefaults } from './agent-settings-service';
import type { DurableAgentConfig } from '../../shared/types';
import { decideHelperAuto, type ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Checking a cell ──────────────────────────────────────────────────────

/** The id that means "pass no --model". */
const CLI_DEFAULT_MODEL = 'default';

/**
 * Ids that leave the model to the CLI, so a preset can't name them: Clubhouse's
 * `default`, and Copilot's own `auto`, where Copilot picks (#3085).
 */
function leavesModelToCli(provider: string, model: string): boolean {
  return model === CLI_DEFAULT_MODEL || (provider === 'copilot-cli' && model === 'auto');
}

interface CellCheck {
  state: PresetCellState;
  staleReason?: PresetStaleReason;
  /** Why it is stale, or what couldn't be checked: a sentence for a person. */
  message?: string;
}

/** Check a model and effort against the CLI's list. Never throws. */
async function checkCell(provider: string, cell: PresetCell): Promise<CellCheck> {
  // A difficulty must not run on whatever the CLI happens to default to.
  if (leavesModelToCli(provider, cell.model)) {
    return { state: 'stale', staleReason: 'model_unavailable', message: 'A preset has to name a model, not leave it to the CLI.' };
  }
  const model = await checkHelperModel(provider, cell.model);
  if (model.ok === false) return { state: 'stale', staleReason: 'model_unavailable', message: model.message };
  if (!cell.effort) return model.warning ? { state: 'unverified', message: model.warning } : { state: 'valid' };
  const effort = await checkHelperEffort(provider, cell.model, cell.effort);
  if (effort.ok === false) return { state: 'stale', staleReason: 'effort_unavailable', message: effort.message };
  const warning = model.warning ?? effort.warning;
  return warning ? { state: 'unverified', message: warning } : { state: 'valid' };
}

interface ResolvedCell {
  cell: PresetCell;
  source: 'custom_mapping' | 'builtin_mapping';
  fallback: HelperRoutingFallback;
  warning?: string;
  /** A minimum or maximum that used its difficulty's cell instead of its own. */
  follows?: HelperDifficulty;
}

/**
 * The cell a start uses: the saved one, else the built-in if the saved one is
 * stale, with a fallback code saying so. Null when neither is valid.
 *
 * A minimum or maximum (#3044) has no built-in. Unset, it uses its difficulty's
 * cell (AUTO_LEVEL_FOLLOWS), resolved the same way. Saved but no longer
 * offered, it does the same, with `builtin_preset` saying the saved choice
 * wasn't used.
 */
async function resolveCell(
  provider: PresetProvider,
  level: AutoLevel,
): Promise<{ resolved: ResolvedCell | null; problems: string[] }> {
  if (isAutoBoundLevel(level)) return resolveBoundCell(provider, level);
  const difficulty = level;
  const custom = orchestrationSettings.getPresets()[provider]?.[difficulty];
  const builtin = BUILTIN_PRESETS[provider][difficulty];
  const problems: string[] = [];
  if (custom) {
    const check = await checkCell(provider, custom);
    if (check.state !== 'stale') {
      return {
        resolved: {
          cell: custom, source: 'custom_mapping',
          fallback: check.state === 'unverified' ? 'model_unverified' : 'none',
          ...(check.message && { warning: check.message }),
        },
        problems,
      };
    }
    problems.push(`your saved choice (${check.message})`);
  }
  const check = await checkCell(provider, builtin);
  if (check.state === 'stale') {
    problems.push(`the default (${check.message})`);
    return { resolved: null, problems };
  }
  return {
    resolved: {
      cell: builtin, source: 'builtin_mapping',
      // A stale saved choice is the bigger thing to say; the warning still carries an unverified one.
      fallback: custom ? 'builtin_preset' : check.state === 'unverified' ? 'model_unverified' : 'none',
      ...(check.message && { warning: check.message }),
    },
    problems,
  };
}

async function resolveBoundCell(
  provider: PresetProvider,
  level: 'minimum' | 'maximum',
): Promise<{ resolved: ResolvedCell | null; problems: string[] }> {
  const custom = orchestrationSettings.getPresets()[provider]?.[level];
  const problems: string[] = [];
  if (custom) {
    const check = await checkCell(provider, custom);
    if (check.state !== 'stale') {
      return {
        resolved: {
          cell: custom, source: 'custom_mapping',
          fallback: check.state === 'unverified' ? 'model_unverified' : 'none',
          ...(check.message && { warning: check.message }),
        },
        problems,
      };
    }
    problems.push(`your saved ${level} (${check.message})`);
  }
  const follows = AUTO_LEVEL_FOLLOWS[level];
  const followed = await resolveCell(provider, follows);
  problems.push(...followed.problems.map((p) => `${follows}: ${p}`));
  if (!followed.resolved) return { resolved: null, problems };
  return {
    resolved: { ...followed.resolved, follows, ...(custom && { fallback: 'builtin_preset' as const }) },
    problems,
  };
}

// ── An Auto level, for callers other than start_helper ───────────────────

export type AutoLevelResolution =
  | {
    ok: true;
    provider: PresetProvider;
    level: AutoLevel;
    model: string;
    /** Null passes no level, so the CLI picks. */
    effort: string | null;
    source: 'custom_mapping' | 'builtin_mapping';
    fallback: HelperRoutingFallback;
    /** Set when a minimum or maximum used this difficulty's cell instead of its own. */
    follows?: HelperDifficulty;
    /** The list may be out of date, so the choice couldn't be fully checked. */
    warning?: string;
  }
  | { ok: false; code: 'auto_not_supported' | 'no_valid_mapping'; message: string };

/**
 * The model and effort a provider runs an Auto level on (#3044), checked
 * against its CLI's list like a helper start. For callers that pick a model
 * themselves at a fixed level, such as the minimum. It
 * doesn't depend on the Auto provider switch, which only governs choosing
 * between providers, and it never falls back to a CLI's default model.
 *
 * Copilot has a mapping too (#3085), though `cli: "auto"` doesn't choose it. A
 * provider without presets returns `auto_not_supported`, so the caller picks
 * its own fallback. Never throws for a bad provider or level.
 */
export async function resolveAutoLevel(provider: string, level: AutoLevel): Promise<AutoLevelResolution> {
  if (!isAutoLevel(level)) {
    return { ok: false, code: 'no_valid_mapping', message: `${String(level)} isn't an Auto level. Use one of ${AUTO_LEVELS.join(', ')}.` };
  }
  if (!isPresetProvider(provider)) {
    return { ok: false, code: 'auto_not_supported', message: `${provider} has no Auto mapping.` };
  }
  const { resolved, problems } = await resolveCell(provider, level);
  if (!resolved) {
    return { ok: false, code: 'no_valid_mapping', message: `No ${level} level for ${provider} is offered now: ${problems.join('; ')}` };
  }
  return {
    ok: true,
    provider,
    level,
    model: resolved.cell.model,
    effort: resolved.cell.effort,
    source: resolved.source,
    fallback: resolved.fallback,
    ...(resolved.follows && { follows: resolved.follows }),
    ...(resolved.warning && { warning: resolved.warning }),
  };
}

/** The provider's minimum level: its cheapest mapped model, for small background steps. */
export function resolveProviderMinimum(provider: string): Promise<AutoLevelResolution> {
  return resolveAutoLevel(provider, 'minimum');
}

/** The provider's maximum level: its strongest mapped model. */
export function resolveProviderMaximum(provider: string): Promise<AutoLevelResolution> {
  return resolveAutoLevel(provider, 'maximum');
}

// ── What a start decides ─────────────────────────────────────────────────

export const AUTO_CLI = 'auto';

export interface StartPlanRequest {
  /** Whether this orchestrator may use Auto, for `cli: "auto"`. */
  auto?: HelperAutoView;
  /** Who is asking. Auto doesn't use it: no orchestrator's choice is favored. */
  orchestratorId?: string;
  cli?: string;
  model?: string;
  effort?: string;
  difficulty?: string;
  /** The CLI the helper gets when nothing else names one. */
  orchestratorCli?: string;
  /** The project the helper is created in: Auto checks its CLIs there. */
  projectPath: string;
}

/** One provider Auto could still use, with what it would run. */
interface AutoOption {
  provider: AutoCandidateProvider;
  cell: ResolvedCell;
  quota: QuotaView;
  /** Provider: see candidateKey. */
  key: string;
}

export interface StartPlan {
  /** Auto, waiting to be decided under the start lock: see decideAutoPlan. */
  pendingAuto?: { options: AutoOption[]; skipped: Record<string, HelperRoutingSkip>; difficulty: HelperDifficulty; orchestratorCli?: string };
  /** An Auto decision's record, once made. Its id is the reservation's; the caller adds the helper id. */
  decision?: HelperDecisionRecord;
  provider?: string;
  model?: string;
  effort?: string;
  routing: HelperRouting;
  /** A preset that couldn't be fully checked. */
  warning?: string;
}

export type StartPlanResult =
  | { ok: true; plan: StartPlan | null }
  /** `message` is for the orchestrator. `userReason` follows "because" in what a person who approved the start reads. */
  | { ok: false; code: 'no_valid_mapping' | 'auto_not_supported' | 'auto_off' | 'no_candidate'; message: string; userReason: string; decision?: HelperDecisionRecord };

/**
 * The order is: the request, then a preset (with `difficulty`), then nothing
 * passed, so the CLI's own default. A preset's effort
 * belongs to its model, so it isn't used when the model came from elsewhere.
 * Returns no plan for a start that asked for nothing: that is today's path, and
 * it records nothing.
 */
export async function planHelperStart(request: StartPlanRequest): Promise<StartPlanResult> {
  const { cli, model, effort, difficulty, orchestratorCli } = request;
  if (!cli && !model && !effort && !difficulty) return { ok: true, plan: null };

  if (cli === AUTO_CLI) {
    if (!request.auto?.effective) return autoOffRefusal(request.auto);
    // Only a difficulty: minimum and maximum (#3044) are mapping levels, not something a start asks for.
    if (!isHelperDifficulty(difficulty)) {
      return {
        ok: false,
        code: 'no_valid_mapping',
        message: `cli "auto" needs a difficulty: ${HELPER_DIFFICULTIES.join(', ')}.`,
        userReason: 'it named no difficulty Auto can use.',
      };
    }
    return prepareAuto(request);
  }
  const namedCli = cli;
  const provider = namedCli ?? orchestratorCli;
  const providerSource: HelperRoutingFieldSource = namedCli ? 'request' : 'orchestrator';
  let resolvedModel = model;
  let modelSource: HelperRoutingFieldSource = model ? 'request' : 'cli_default';
  let resolvedEffort = effort;
  let effortSource: HelperRoutingFieldSource = effort ? 'request' : 'cli_default';
  let fallback: HelperRoutingFallback = 'none';
  let warning: string | undefined;
  const validDifficulty = isHelperDifficulty(difficulty) ? difficulty : null;

  if (validDifficulty) {
    if (!isPresetProvider(provider)) {
      return {
        ok: false,
        code: 'auto_not_supported',
        message: `${provider ?? 'This CLI'} has no presets, so difficulty can't pick for it. Name a model with list_models instead.`,
        userReason: `${provider ?? 'its CLI'} has no presets.`,
      };
    }
    if (!resolvedModel) {
      const { resolved, problems } = await resolveCell(provider, validDifficulty);
      if (!resolved) {
        return {
          ok: false,
          code: 'no_valid_mapping',
          message: `No ${validDifficulty} preset for ${provider} is offered now: ${problems.join('; ')} ` +
            'Name a model with list_models, or ask the user to update Settings > Smart selection.',
          userReason: `no ${validDifficulty} preset for ${provider} is offered now. Change it in Settings > Smart selection.`,
        };
      }
      resolvedModel = resolved.cell.model;
      modelSource = resolved.source;
      fallback = resolved.fallback;
      warning = resolved.warning;
      if (!effort && resolved.cell.effort) {
        resolvedEffort = resolved.cell.effort;
        effortSource = resolved.source;
      }
    }
  }

  const usedPreset = modelSource === 'custom_mapping' || modelSource === 'builtin_mapping';
  // 'default' passes no --model, and is saved as no model.
  const passedModel = resolvedModel && resolvedModel !== 'default' ? resolvedModel : undefined;
  return {
    ok: true,
    plan: {
      ...(provider && { provider }),
      ...(passedModel && { model: passedModel }),
      ...(resolvedEffort && { effort: resolvedEffort }),
      ...(warning && { warning }),
      routing: {
        mode: validDifficulty ? 'preset' : 'explicit',
        balanced: false,
        decidedAt: new Date().toISOString(),
        policyVersion: HELPER_ROUTING_POLICY_VERSION,
        requested: { provider: cli ?? null, model: model ?? null, effort: effort ?? null, difficulty: validDifficulty },
        resolved: { provider: provider ?? null, model: passedModel ?? null, effort: resolvedEffort ?? null, difficulty: validDifficulty },
        source: { provider: providerSource, model: modelSource, effort: effortSource },
        reason: usedPreset ? 'preset_on_cli' : 'explicit_request',
        fallback,
        context: { status: 'none' },
      },
    },
  };
}

// ── Auto ─────────────────────────────────────────────────────────────────

function decisionQuota(quota: QuotaView): QuotaDecisionView {
  return {
    state: quota.state,
    asOf: quota.asOf,
    ...(quota.unknownReason && { unknownReason: quota.unknownReason }),
    ...(quota.limitingWindow && { limitingWindow: quota.limitingWindow }),
  };
}

async function providerUsable(provider: string, projectPath: string): Promise<boolean> {
  try {
    const instance = getProvider(provider as OrchestratorId);
    if (!instance) return false;
    return (await instance.checkAvailability()).available;
  } catch (err) {
    // telemetry-exempt: logged; a provider that can't be checked isn't a candidate.
    appLog('core:mcp', 'warn', 'Auto: could not check a provider', { meta: { provider, projectPath, error: err instanceof Error ? err.name : 'unknown' } });
    return false;
  }
}

/**
 * What a candidate runs under: its provider, on the one login the local
 * environment has. A proxy for a subscription, never more. `:default` is the
 * suffix Auto's saved tie history used before profiles were removed (#2749).
 */
function candidateKey(provider: string): string {
  return `${provider}:default`;
}

/**
 * What Auto can choose from, read before the start lock, because a list or a
 * quota read can take a CLI handshake. The choice waits for the lock, so a burst
 * of starts sees each other's.
 */
async function prepareAuto(request: StartPlanRequest): Promise<StartPlanResult> {
  const { projectPath, orchestratorCli } = request;
  const difficulty = request.difficulty as HelperDifficulty;
  const enabled = getOrchestratorSettings().enabled ?? [];
  const skipped: Record<string, HelperRoutingSkip> = {};
  // Copilot has a mapping but isn't a candidate (#3085), so it's skipped like a provider without one.
  for (const other of getAllProviders()) {
    if (!isAutoCandidateProvider(other.id) && (enabled.length === 0 || enabled.includes(other.id))) skipped[other.id] = 'auto_not_supported';
  }
  const options: AutoOption[] = [];
  await Promise.all(AUTO_CANDIDATE_PROVIDERS.map(async (provider) => {
    if (enabled.length > 0 && !enabled.includes(provider)) { skipped[provider] = 'cli_disabled'; return; }
    if (!(await providerUsable(provider, projectPath))) { skipped[provider] = 'cli_unavailable'; return; }
    if (await isProviderCoolingDown(provider)) { skipped[provider] = 'cooling_down'; return; }
    const { resolved } = await resolveCell(provider, difficulty);
    if (!resolved) { skipped[provider] = 'no_valid_mapping'; return; }
    const quota = await readProviderQuota(provider, { model: resolved.cell.model });
    options.push({ provider, cell: resolved, quota, key: candidateKey(provider) });
  }));
  // A stable order for what's shown. The choice doesn't depend on it.
  options.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const usable = options.filter((o) => o.quota.state !== 'exhausted' && o.quota.state !== 'near_limit');
  if (usable.length === 0) return noCandidate(difficulty, skipped, options, orchestratorCli);
  return {
    ok: true,
    plan: {
      pendingAuto: { options, skipped, difficulty, ...(orchestratorCli && { orchestratorCli }) },
      routing: {} as HelperRouting,
    },
  };
}

function noCandidate(
  difficulty: HelperDifficulty,
  skipped: Record<string, HelperRoutingSkip>,
  options: readonly AutoOption[],
  orchestratorCli: string | undefined,
  context: { load?: Readonly<Record<string, AutoLoad>>; decision?: AutoDecision } = {},
): Extract<StartPlanResult, { ok: false }> {
  const all = { ...skipped };
  for (const option of options) {
    if (option.quota.state === 'exhausted') all[option.provider] = 'quota_exhausted';
    else if (option.quota.state === 'near_limit') all[option.provider] = 'quota_near_limit';
  }
  const reasons = Object.entries(all).map(([provider, code]) => `${provider}: ${routingLabel('skipped', code)}`).join('; ');
  return {
    ok: false,
    code: 'no_candidate',
    message: `Auto has no provider for a ${difficulty} task right now (${reasons}). Tell the user, or name a CLI. Don't retry in a loop.`,
    userReason: `no provider can take a ${difficulty} task right now (${reasons}).`,
    decision: autoDecisionRecord({ decisionId: randomUUID(), now: Date.now(), difficulty, orchestratorCli, options, skipped: all, load: context.load ?? {}, ...(context.decision && { decision: context.decision }) }),
  };
}

/** Helpers on a provider: those running or starting, and reservations not yet seen live. */
export interface AutoLoad {
  live: number;
  reserved: number;
}

const percentBp = (percent: number | null | undefined): number | undefined => (typeof percent === 'number' && Number.isFinite(percent) ? Math.round(percent * 100) : undefined);
const epochOf = (iso: string | null | undefined): number | undefined => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

function decisionWindow(name: DecisionQuotaWindow['name'], window: QuotaWindowView): DecisionQuotaWindow {
  const usedBp = percentBp(window.usedPercent);
  const resetsAtMs = epochOf(window.resetsAt);
  return { name, ...(usedBp !== undefined && { usedBp }), ...(resetsAtMs !== undefined && { resetsAtMs }) };
}

/** A quota view as the decision record keeps it: basis points and epoch ms, with nothing unavailable filled in. */
function recordQuota(quota: QuotaView): DecisionQuota {
  const asOfMs = epochOf(quota.asOf);
  const windows = [
    ...(quota.weekly ? [decisionWindow('weekly', quota.weekly)] : []),
    ...(quota.fiveHour ? [decisionWindow('fiveHour', quota.fiveHour)] : []),
    ...(quota.modelWindows ?? []).map((w) => decisionWindow('model', w)),
  ];
  return {
    state: quota.state,
    source: quota.source,
    ...(asOfMs !== undefined && { asOfMs }),
    ...(quota.unknownReason && { unknownReason: quota.unknownReason }),
    quality: quota.state !== 'unknown' ? 'fresh' : quota.unknownReason === 'stale' ? 'stale' : 'unknown',
    ...(windows.length > 0 && { windows }),
  };
}

/** Which cells the options used, so two decisions on the same mapping compare equal. */
function mappingFingerprint(options: readonly AutoOption[]): string {
  const cells = options.map((o) => [o.provider, o.cell.cell.model, o.cell.cell.effort, o.cell.source]).sort();
  return createHash('sha256').update(JSON.stringify(cells)).digest('hex').slice(0, 16);
}

/**
 * The record of an Auto decision, for #2747's ledger: every registered provider,
 * what each was seen as, and how the choice was made. A refusal gets one too.
 */
function autoDecisionRecord(args: {
  decisionId: string;
  now: number;
  difficulty: HelperDifficulty;
  orchestratorCli: string | undefined;
  options: readonly AutoOption[];
  skipped: Readonly<Record<string, HelperRoutingSkip>>;
  load: Readonly<Record<string, AutoLoad>>;
  decision?: AutoDecision;
  routing?: HelperRouting;
}): HelperDecisionRecord {
  const { decisionId, now, difficulty, orchestratorCli, options, skipped, load, decision, routing } = args;
  const evaluations = new Map((decision?.evaluations ?? []).map((e) => [e.provider, e]));
  const chosen = decision?.ok ? decision.provider : undefined;
  const loadOf = (provider: string) => load[provider] ?? { live: 0, reserved: 0 };
  const candidates: DecisionCandidate[] = getAllProviders().map(({ id }) => {
    const option = options.find((o) => o.provider === id);
    const evaluation = evaluations.get(id);
    const excluded = evaluation?.excluded ?? skipped[id];
    if (!option) return { provider: id, eligible: false, ...(excluded && { excluded }), load: loadOf(id) };
    const effort = option.cell.cell.effort;
    return {
      provider: id,
      eligible: !excluded,
      ...(excluded && { excluded }),
      mapped: { model: option.cell.cell.model, effort, source: option.cell.source, verified: option.cell.fallback !== 'model_unverified' },
      load: loadOf(id),
      quota: recordQuota(option.quota),
      accountKnown: false,
      ...(evaluation?.tier && { tier: AUTO_TIERS.indexOf(evaluation.tier) }),
      ...(evaluation && {
        score: {
          basis: evaluation.score.basis,
          ...(evaluation.score.weeklyUsedBp !== undefined && { weeklyUsedBp: evaluation.score.weeklyUsedBp }),
          ...(evaluation.score.cyclePhaseBp !== undefined && { cyclePhaseBp: evaluation.score.cyclePhaseBp }),
          ...(evaluation.score.targetBp !== undefined && { targetBp: evaluation.score.targetBp }),
          ...(evaluation.score.pressureBp !== undefined && { pressureBp: evaluation.score.pressureBp }),
          ...(evaluation.rank !== undefined && { rank: evaluation.rank }),
        },
      }),
      ...(id === chosen && { chosen: true }),
    };
  });
  const sources = new Set(options.map((o) => o.cell.source));
  const tie = decision?.ok ? decision.tie : undefined;
  const enabled = getOrchestratorSettings().enabled ?? [];
  return {
    decisionId,
    decidedAtMs: now,
    policyVersion: HELPER_ROUTING_POLICY_VERSION,
    mode: 'auto',
    outcome: routing ? 'chosen' : 'refused',
    ...(!routing && { refusalCode: 'no_candidate' as const }),
    ...(orchestratorCli && { orchestratorProvider: orchestratorCli }),
    requested: { provider: AUTO_CLI, model: null, effort: null, difficulty },
    resolved: routing?.resolved ?? { provider: null, model: null, effort: null, difficulty },
    // A refusal chose nothing, so it has no sources and no reason of its own: its candidates say why.
    ...(routing && { source: routing.source, reason: routing.reason }),
    fallback: routing?.fallback ?? 'candidate_skipped',
    mappingRevision: helperRoutingRevision(),
    mappingFingerprint: mappingFingerprint(options),
    mappingKind: sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : sources.has('custom_mapping') ? 'custom' : 'builtin',
    settings: { autoEnabled: true, enabledProviders: enabled.length > 0 ? enabled.length : getAllProviders().length },
    thresholds: AUTO_THRESHOLDS,
    candidates,
    ...(tie && {
      tie: {
        setSize: tie.set.length,
        bandBp: tie.bandBp,
        reason: tie.cursorKey ? 'rotation' as const : tie.byLoad ? 'lower_load' as const : 'none' as const,
        byLoad: tie.byLoad,
        ...(tie.cursorKey && { cursorKey: tie.cursorKey }),
        ...(tie.cursorBefore !== undefined && { cursorBefore: tie.set.indexOf(tie.cursorBefore) }),
        ...(tie.cursorAfter !== undefined && { cursorAfter: tie.set.indexOf(tie.cursorAfter) }),
      },
    }),
  };
}

/** The numbers policy 2 ran with, so a record can be replayed. It has no reservation expiry, sticky time or margin. */
const AUTO_THRESHOLDS = { quotaLowBp: QUOTA_LOW_PERCENT * 100, quotaNearLimitBp: QUOTA_NEAR_LIMIT_PERCENT * 100, quotaStaleMs: QUOTA_STALE_MS };

/**
 * The record of a start Auto didn't decide: an explicit or preset start, or one
 * that asked for nothing and runs on the orchestrator's CLI. Only what the start
 * itself resolved; no candidates were compared, so none are listed. Routing is
 * unchanged by it.
 */
export function startDecisionRecord(routing: HelperRouting | undefined, launched: { provider?: string; model?: string; effort?: string }, now = Date.now()): HelperDecisionRecord {
  return {
    decisionId: randomUUID(),
    decidedAtMs: now,
    policyVersion: routing?.policyVersion ?? HELPER_ROUTING_POLICY_VERSION,
    mode: routing?.mode ?? 'explicit',
    outcome: 'chosen',
    requested: routing?.requested ?? { provider: null, model: null, effort: null, difficulty: null },
    resolved: routing?.resolved ?? { provider: launched.provider ?? null, model: launched.model ?? null, effort: launched.effort ?? null, difficulty: null },
    ...(routing
      ? { source: routing.source, reason: routing.reason, fallback: routing.fallback }
      : launched.provider ? { source: { provider: 'orchestrator' as const } } : {}),
    candidates: [],
  };
}

/**
 * Make Auto's choice, under the start lock, from what prepareAuto read and the
 * load right now, and hold the provider for it. Decided once: nothing moves this
 * helper later. The caller commits the reservation once the helper exists and
 * settles it when the start ends: see helper-auto-state.
 */
export function decideAutoPlan(plan: StartPlan, load: Readonly<Record<string, AutoLoad>>, now = Date.now()): StartPlanResult {
  const pending = plan.pendingAuto;
  if (!pending) return { ok: true, plan };
  const { options, skipped, difficulty, orchestratorCli } = pending;
  const total = (provider: string) => (load[provider]?.live ?? 0) + (load[provider]?.reserved ?? 0);
  const candidates: AutoCandidate[] = options.map((o) => {
    const weekly = o.quota.weekly;
    return {
      key: o.key,
      provider: o.provider,
      quotaState: o.quota.state,
      ...(weekly && { weekly: { usedPercent: weekly.usedPercent, resetsAtMs: epochOf(weekly.resetsAt) ?? null } }),
      verified: o.cell.fallback !== 'model_unverified',
      load: total(o.provider),
    };
  });
  const decision = decideAutoProvider({ now, candidates, cursors: rotationCursors() });
  if (decision.ok === false) return noCandidate(difficulty, skipped, options, orchestratorCli, { load, decision });
  const chosen = options.find((o) => o.key === decision.key)!;
  const allSkipped: Record<string, HelperRoutingSkip> = { ...skipped };
  for (const e of decision.evaluations) if (e.excluded) allSkipped[e.provider] = e.excluded;
  const { cell } = chosen;
  const effort = cell.cell.effort ?? undefined;
  const decisionId = randomUUID();
  const routing: HelperRouting = {
    mode: 'auto',
    balanced: true,
    decidedAt: new Date(now).toISOString(),
    policyVersion: HELPER_ROUTING_POLICY_VERSION,
    decisionId,
    requested: { provider: AUTO_CLI, model: null, effort: null, difficulty },
    resolved: { provider: decision.provider, model: cell.cell.model, effort: effort ?? null, difficulty },
    source: { provider: 'auto', model: cell.source, effort: effort ? cell.source : 'cli_default' },
    reason: decision.reason,
    // Copilot can never be chosen, so its being skipped isn't a fallback.
    fallback: cell.fallback !== 'none' ? cell.fallback : Object.values(allSkipped).some((code) => code !== 'auto_not_supported') ? 'candidate_skipped' : 'none',
    context: { status: 'none' },
    load: Object.fromEntries(options.map((o) => [o.provider, total(o.provider)])),
    quota: Object.fromEntries(options.map((o) => [o.provider, decisionQuota(o.quota)])),
    quotaBasis: decision.tier === 'unmeasured' ? 'unknown_fallback' : 'known',
    ...(Object.keys(allSkipped).length > 0 && { skipped: allSkipped }),
  };
  const { cursorKey, cursorAfter } = decision.tie;
  reserveAutoDecision(decisionId, { provider: decision.provider, key: decision.key, ...(cursorKey && cursorAfter && { rotation: { cursorKey, key: cursorAfter } }) }, now);
  return {
    ok: true,
    plan: {
      provider: decision.provider,
      model: cell.cell.model,
      ...(effort && { effort }),
      routing,
      decision: autoDecisionRecord({ decisionId, now, difficulty, orchestratorCli, options, skipped, load, decision, routing }),
      ...(cell.warning && { warning: cell.warning }),
    },
  };
}

/**
 * Whether `cli: "auto"` is allowed, at the scope asked about. A project can
 * turn it off and never on, so a cloned repository can't spend another
 * provider's quota. Then the orchestrator's own choice, then the app's.
 */
export async function readHelperAuto(context: {
  projectPath?: string;
  agent?: { config: DurableAgentConfig; policy: ResolvedOrchestrationPolicy };
  dispatcher?: boolean;
} = {}): Promise<HelperAutoView> {
  const app = orchestrationSettings.getAutoHelpers();
  const { projectPath, agent, dispatcher } = context;
  if (dispatcher) {
    // The Dispatcher doesn't start helpers, and nothing here is its to change.
    return { effective: false, source: 'dispatcher_locked', reason: 'dispatcher_locked', scopes: { app: { value: app, editable: false }, agent: { value: null, editable: false } } };
  }
  const projectOff = projectPath ? (await readProjectAgentDefaults(projectPath)).helperAuto === 'off' : false;
  const policy = agent?.policy;
  // Its own switch, MCP or not. A saved value comes back with MCP, and clearing or turning it off still works without.
  const stored = agent?.config.orchestration?.autoHelpers ?? null;
  return {
    ...decideHelperAuto({ app, projectOff, ...(policy && { policy }) }),
    scopes: {
      app: { value: app, editable: true },
      ...(projectPath && { project: { value: projectOff ? 'off' as const : null, choices: ['off', null] as ['off', null], editable: true } }),
      ...(agent && {
        // Personas were retired (#2901): always null, kept for clients that read it.
        persona: { value: null, editable: false as const },
        agent: { value: stored, editable: true },
      }),
    },
  };
}

/** The refusal for `cli: "auto"` while it's off, saying why. */
export function autoOffRefusal(auto: HelperAutoView | undefined): Extract<StartPlanResult, { ok: false }> {
  const why = routingLabel('autoOff', auto?.reason ?? 'not_enabled');
  return { ok: false, code: 'auto_off', message: `Auto provider is off for you: ${why}. Name a CLI, or ask the user to turn it on.`, userReason: `Auto provider is off: ${why}.` };
}

// ── The settings ─────────────────────────────────────────────────────────

/** Moves when a cell's state changes without a write. In memory: a restart is a new revision anyway. */
let stateEpoch = 0;
let lastStateSignature: string | null = null;

type ChangeListener = (revision: string) => void;
const listeners = new Set<ChangeListener>();

export function onHelperRoutingChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastEmitted: string | null = null;

function emitChanged(): void {
  const revision = helperRoutingRevision();
  if (revision === lastEmitted) return;
  lastEmitted = revision;
  for (const listener of listeners) {
    try {
      listener(revision);
    } catch (err) {
      // telemetry-exempt: logged; one listener doesn't stop the others
      appLog('core:mcp', 'warn', 'A helper routing listener failed', { meta: { error: errorText(err) } });
    }
  }
}

/** For the snapshot: a saved value or a cell's state changed since a client last looked. Reads nothing from a CLI. */
export function helperRoutingRevision(): string {
  return `r${orchestrationSettings.getPresetsRevision()}.${stateEpoch}`;
}

/** The saved part of a revision. A stale write is about saved values, not a list that changed. */
function savedPartOf(revision: string): number | null {
  const match = /^r(\d+)\.\d+$/.exec(revision);
  return match ? Number(match[1]) : null;
}

async function viewCell(provider: PresetProvider, level: AutoLevel): Promise<PresetCellView> {
  if (isAutoBoundLevel(level)) return viewBoundCell(provider, level);
  const difficulty = level;
  const custom = orchestrationSettings.getPresets()[provider]?.[difficulty] ?? null;
  const builtin = BUILTIN_PRESETS[provider][difficulty];
  const shown = await checkCell(provider, custom ?? builtin);
  const { resolved } = await resolveCell(provider, difficulty);
  const fallback = resolved?.fallback;
  return {
    effective: resolved?.cell ?? null,
    source: resolved?.source === 'custom_mapping' || (!resolved && custom) ? 'custom' : 'builtin',
    state: shown.state,
    ...(shown.staleReason && { staleReason: shown.staleReason }),
    ...(fallback && fallback !== 'none' && { fallback }),
    custom,
    builtin,
    editable: true,
  };
}

/**
 * A minimum or maximum. Without a usable choice of its own it shows its
 * difficulty's cell, with `follows` naming it; a stale saved one keeps its own
 * state, so Settings can say so and offer Reset.
 */
async function viewBoundCell(provider: PresetProvider, level: 'minimum' | 'maximum'): Promise<PresetCellView> {
  const follows = AUTO_LEVEL_FOLLOWS[level];
  const custom = orchestrationSettings.getPresets()[provider]?.[level] ?? null;
  const followed = await viewCell(provider, follows);
  if (!custom) return { ...followed, custom: null, follows };
  const shown = await checkCell(provider, custom);
  if (shown.state !== 'stale') {
    return {
      effective: custom,
      source: 'custom',
      state: shown.state,
      ...(shown.state === 'unverified' && { fallback: 'model_unverified' as const }),
      custom,
      builtin: followed.builtin,
      editable: true,
    };
  }
  return {
    effective: followed.effective,
    source: 'custom',
    state: 'stale',
    ...(shown.staleReason && { staleReason: shown.staleReason }),
    ...(followed.effective && { fallback: 'builtin_preset' as const }),
    custom,
    builtin: followed.builtin,
    editable: true,
    follows,
  };
}

async function viewProvider(provider: PresetProvider, refresh: boolean): Promise<ProviderRoutingView> {
  const instance = getProvider(provider as OrchestratorId);
  let choices: Extract<ProviderRoutingView, { autoEligible: true }>['choices'] = { source: 'fallback', asOf: null, models: [] };
  const forcedQuota = refresh ? forceProviderQuota(provider) : null;
  let listSource = 'none';
  let modelCount = 0;
  let listFailed = false;
  if (instance) {
    try {
      // App-wide: presets are app-wide, so this is what a write takes.
      // Forced first, so the cells below read the new list from the cache.
      const list = await modelListFor(instance, refresh);
      if (list) {
        listSource = list.source;
        modelCount = list.models.length;
        const models: PresetChoice[] = list.models.filter((m) => !m.hidden && !leavesModelToCli(provider, m.id)).map((m) => ({ id: m.id, label: m.label, efforts: m.efforts ?? [] }));
        choices = { source: list.source, asOf: new Date(list.fetchedAt).toISOString(), models };
      }
    } catch (err) {
      // telemetry-exempt: logged; the page shows the saved choices as unverified
      listFailed = true;
      appLog('core:mcp', 'warn', 'Helper presets: could not list models', { meta: { provider, error: errorText(err) } });
    }
  }
  const [cells, quota] = await Promise.all([
    Promise.all(AUTO_LEVELS.map((level) => viewCell(provider, level))),
    forcedQuota ? forcedQuota.then((forced) => forced.quota) : readProviderQuota(provider),
  ]);
  if (forcedQuota) {
    const quotaOutcome = (await forcedQuota).outcome;
    const quotaProblem = quotaOutcome === 'failed' || quotaOutcome === 'timed_out' ? `quota_${quotaOutcome}` : null;
    const outcome = [...(listFailed ? ['list_failed'] : []), ...(quotaProblem ? [quotaProblem] : [])].join('+') || 'ok';
    appLog('core:mcp', 'info', 'Helper presets: asked a CLI again', { meta: { provider, source: listSource, models: modelCount, outcome } });
  }
  return {
    autoEligible: true,
    autoCandidate: isAutoCandidateProvider(provider),
    quota,
    choices,
    cells: Object.fromEntries(AUTO_LEVELS.map((level, i) => [level, cells[i]])) as Record<AutoLevel, PresetCellView>,
  };
}

/**
 * The page's data. A CLI's list can take a handshake, cached for about ten
 * minutes. Cells and `choices` are app-wide, since a write is; `projectPath`
 * adds that project's Auto setting. Reads made without one also notice a cell whose state changed, and move the
 * revision. `refresh` asks each preset CLI again first, for its app-wide list and
 * its limits, for someone who just signed in. A project's own list isn't forced.
 */
export async function readHelperRouting(options: { projectPath?: string; autoContext?: Parameters<typeof readHelperAuto>[0]; refresh?: boolean } = {}): Promise<HelperRoutingSettings> {
  // Keys go in in PRESET_PROVIDERS order, not the order the reads finish, so the page's sections don't move (#3186).
  const views = await Promise.all(PRESET_PROVIDERS.map((p) => viewProvider(p, options.refresh === true)));
  const providers: Record<string, ProviderRoutingView> = {};
  PRESET_PROVIDERS.forEach((p, i) => { providers[p] = views[i]; });
  for (const other of getAllProviders()) {
    if (!isPresetProvider(other.id)) {
      providers[other.id] = { autoEligible: false, reason: 'auto_not_supported', quota: await readProviderQuota(other.id), cells: null };
    }
  }
  if (!options.projectPath) {
    const signature = JSON.stringify(PRESET_PROVIDERS.map((p) => {
      const view = providers[p];
      return view.autoEligible ? AUTO_LEVELS.map((level) => view.cells[level].state) : null;
    }));
    const changed = lastStateSignature !== null && lastStateSignature !== signature;
    lastStateSignature = signature;
    if (changed) {
      stateEpoch++;
      emitChanged();
    }
  }
  const auto = await readHelperAuto(options.autoContext ?? (options.projectPath ? { projectPath: options.projectPath } : {}));
  return { revision: helperRoutingRevision(), serverTime: new Date(Date.now()).toISOString(), labels: HELPER_ROUTING_LABELS, providers, auto };
}

// ── Changing them ────────────────────────────────────────────────────────

export type HelperRoutingErrorCode = 'invalid_helper_routing' | 'helper_routing_stale' | 'model_unavailable' | 'effort_unavailable';

export class HelperRoutingError extends Error {
  constructor(
    readonly code: HelperRoutingErrorCode,
    message: string,
    /** Fresh values, for a stale write. */
    readonly settings?: HelperRoutingSettings,
  ) {
    super(message);
  }
}

function sameCell(a: PresetCell | undefined, b: PresetCell | undefined): boolean {
  return !!a && !!b && a.model === b.model && (a.effort ?? null) === (b.effort ?? null);
}

function cellText(cell: PresetCell | undefined): string | null {
  return cell ? `${cell.model}/${cell.effort ?? 'none'}` : null;
}

/** Writes run one at a time, so two can't both pass the revision check. */
let writeChain: Promise<unknown> = Promise.resolve();
/** A project write made here, which moves the revision itself. */
let ownProjectWrites = 0;

interface PresetWriteOrigin {
  surface: SettingsAuditSurface;
  /** For a write at project scope: only `auto`. */
  projectPath?: string;
}

function checkShape(update: HelperRoutingUpdate): void {
  const invalid = (message: string) => new HelperRoutingError('invalid_helper_routing', message);
  if (typeof update?.revision !== 'string' || savedPartOf(update.revision) === null) throw invalid('Send the revision this change was made from.');
  if (!update.cells?.length && !update.reset && update.auto === undefined) throw invalid('Send cells to change, a reset, or auto.');
  for (const cell of update.cells ?? []) {
    if (!isPresetProvider(cell?.provider)) throw invalid(`${String(cell?.provider)} has no presets.`);
    if (!isAutoLevel(cell.difficulty)) throw invalid(`difficulty must be one of ${AUTO_LEVELS.join(', ')}.`);
    if (!isPresetModel(cell.model)) throw invalid('That isn\'t a model id.');
    if (leavesModelToCli(cell.provider, cell.model)) throw invalid('A preset has to name a model, not leave it to the CLI.');
    if (cell.effort !== null && !isEffortValue(cell.effort)) throw invalid('effort must be a level or null.');
  }
  const { reset } = update;
  if (reset) {
    if (reset.provider !== undefined && !isPresetProvider(reset.provider)) throw invalid(`${String(reset.provider)} has no presets.`);
    if (reset.difficulty !== undefined && !isAutoLevel(reset.difficulty)) throw invalid(`difficulty must be one of ${AUTO_LEVELS.join(', ')}.`);
    if (reset.difficulty !== undefined && reset.provider === undefined) throw invalid('Resetting one difficulty needs its provider.');
  }
}

function afterReset(saved: SavedPresets, reset: HelperRoutingUpdate['reset']): SavedPresets {
  if (!reset) return saved;
  if (!reset.provider) return {};
  const provider = reset.provider as PresetProvider;
  if (!reset.difficulty) {
    const { [provider]: _dropped, ...rest } = saved;
    return rest;
  }
  const { [reset.difficulty as AutoLevel]: _cell, ...cells } = saved[provider] ?? {};
  const { [provider]: _old, ...rest } = saved;
  return Object.keys(cells).length > 0 ? { ...rest, [provider]: cells } : rest;
}

async function auditPresetChanges(before: SavedPresets, after: SavedPresets, surface: SettingsAuditSurface): Promise<void> {
  for (const provider of PRESET_PROVIDERS) {
    for (const level of AUTO_LEVELS) {
      const was = before[provider]?.[level];
      const now = after[provider]?.[level];
      if (cellText(was) === cellText(now)) continue;
      await appendSettingsAudit({ surface, scope: 'app', key: `helper_presets.${provider}.${level}`, before: cellText(was), after: cellText(now), outcome: 'ok' });
    }
  }
}

/**
 * Change or reset presets, app-wide. A value is checked against the CLI's list
 * first: a live list refuses, and a fallback list accepts it, shown as unverified.
 * A write made from an older revision changes nothing and returns fresh values,
 * so a person sees them and decides. Nothing retries it. Throws HelperRoutingError.
 */
export function updateHelperPresets(update: HelperRoutingUpdate, origin: PresetWriteOrigin): Promise<HelperRoutingSettings> {
  const run = writeChain.catch((): undefined => undefined).then(() => writePresets(update, origin));
  writeChain = run.catch((): undefined => undefined);
  return run;
}

async function writePresets(update: HelperRoutingUpdate, { surface, projectPath }: PresetWriteOrigin): Promise<HelperRoutingSettings> {
  const action = update?.auto !== undefined && !update.cells?.length && !update.reset ? 'toggle'
    : update?.reset && !update.cells?.length
    ? update.reset.difficulty ? 'reset_cell' : update.reset.provider ? 'reset_provider' : 'reset_all'
    : 'set';
  const refuse = async (err: HelperRoutingError): Promise<never> => {
    await appendSettingsAudit({ surface, scope: 'app', key: 'helper_presets', outcome: 'refused', code: err.code });
    helperPresetsChanged(action, surface, false);
    throw err;
  };

  try {
    checkShape(update);
    const invalid = (message: string) => new HelperRoutingError('invalid_helper_routing', message);
    if (projectPath) {
      if (update.cells?.length || update.reset) throw invalid('A project can only turn Auto off.');
      if (update.auto !== 'off' && update.auto !== null) throw invalid('A project can only set auto to off or null.');
    } else if (update.auto !== undefined && typeof update.auto !== 'boolean') {
      throw invalid('App-wide, auto is true or false.');
    }
  } catch (err) {
    if (err instanceof HelperRoutingError) return refuse(err);
    throw err;
  }
  const stale = async () => refuse(new HelperRoutingError(
    'helper_routing_stale',
    'These presets changed since this page loaded. Check the new values and make your change again.',
    // Fresh values for what the page was showing: at a project's scope, that project's.
    await readHelperRouting(projectPath ? { projectPath } : {}),
  ));
  if (savedPartOf(update.revision) !== orchestrationSettings.getPresetsRevision()) return stale();

  for (const { provider, model, effort } of update.cells ?? []) {
    const check = await checkCell(provider, { model, effort });
    if (check.state === 'stale') {
      return refuse(new HelperRoutingError(check.staleReason as HelperRoutingErrorCode, check.message ?? 'That choice isn\'t offered.'));
    }
  }

  if (update.auto !== undefined) {
    if (projectPath) {
      let before: 'off' | null = null;
      // This write moves the revision itself, so what it returns is current.
      ownProjectWrites++;
      try {
        // Only helperAuto changes, on the defaults as they are then (#3262).
        await updateProjectAgentDefaults(projectPath, (defaults) => {
          before = defaults.helperAuto ?? null;
          const { helperAuto: _old, ...rest } = defaults;
          return { ...rest, ...(update.auto === 'off' && { helperAuto: 'off' as const }) };
        });
      } finally {
        ownProjectWrites--;
      }
      await orchestrationSettings.bumpPresetsRevision();
      await appendSettingsAudit({ surface, scope: 'project', key: 'helper_auto', before, after: update.auto === 'off' ? 'off' : null, outcome: 'ok' });
    } else {
      const before = orchestrationSettings.getAutoHelpers();
      await orchestrationSettings.saveAutoHelpers(update.auto === true);
      await appendSettingsAudit({ surface, scope: 'app', key: 'helper_auto', before, after: update.auto === true, outcome: 'ok' });
    }
  }
  if (projectPath || (!update.cells?.length && !update.reset)) {
    helperPresetsChanged(action, surface, true);
    appLog('core:orchestration', 'info', 'Helper Auto setting changed', { meta: { action, surface, scope: projectPath ? 'project' : 'app' } });
    emitChanged();
    return readHelperRouting(projectPath ? { projectPath } : {});
  }

  const before = orchestrationSettings.getPresets();
  const next = afterReset(before, update.reset);
  const result: SavedPresets = Object.fromEntries(Object.entries(next).map(([p, cells]) => [p, { ...cells }]));
  for (const { provider, difficulty, model, effort } of update.cells ?? []) {
    const p = provider as PresetProvider;
    const d = difficulty as AutoLevel;
    // Only what differs from a built-in is kept, so a built-in that moves on is followed.
    // Minimum and maximum have none, so a choice there is kept as made.
    if (isHelperDifficulty(d) && sameCell({ model, effort }, BUILTIN_PRESETS[p][d])) {
      if (result[p]) delete result[p]![d];
      if (result[p] && Object.keys(result[p]!).length === 0) delete result[p];
    } else {
      (result[p] ??= {})[d] = { model, effort };
    }
  }
  await orchestrationSettings.savePresets(result);
  await auditPresetChanges(before, result, surface);
  helperPresetsChanged(action, surface, true);
  appLog('core:orchestration', 'info', 'Helper presets changed', { meta: { action, surface } });
  emitChanged();
  return readHelperRouting();
}

/**
 * A change elsewhere decided something about Auto: move the revision, in turn with
 * writes, so a page holding the old one is refused with fresh values.
 */
setRoutingPolicyListener(() => {
  if (ownProjectWrites > 0) return;
  writeChain = writeChain.catch((): undefined => undefined).then(async () => {
    await orchestrationSettings.bumpPresetsRevision();
    emitChanged();
  }).catch((err: unknown) => {
    // telemetry-exempt: logged; the next read still shows what is true now.
    appLog('core:orchestration', 'warn', 'Could not move the helper routing revision', { meta: { error: errorText(err) } });
  });
});

/** For testing: wait for writes and revision moves to settle. */
export function _settleHelperRoutingForTesting(): Promise<unknown> {
  return writeChain;
}

/** For testing. */
export function _resetHelperRoutingForTesting(): void {
  stateEpoch = 0;
  lastStateSignature = null;
  lastEmitted = null;
  _resetHelperAutoStateForTesting();
  writeChain = Promise.resolve();
  listeners.clear();
}
