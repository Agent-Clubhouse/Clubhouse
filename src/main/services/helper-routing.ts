/**
 * Helper presets and what a start decides from them (#2671,
 * docs/helper-auto-routing.md). Stage 2: `difficulty` picks a model and effort on
 * one CLI. Explicit arguments win over a persona's pins, which win over a preset.
 *
 * Presets are checked against the CLI's own list when written and again when
 * used. A saved value is never rewritten: one no longer offered shows as stale,
 * the built-in is used if it's valid and says so, and otherwise the start is
 * refused. Nothing falls back to the CLI's default model.
 */

import { createHash, randomUUID } from 'crypto';
import { parsePersonaFile } from '../../shared/persona-pattern';
import {
  BUILTIN_PRESETS,
  HELPER_DIFFICULTIES,
  HELPER_ROUTING_LABELS,
  HELPER_ROUTING_POLICY_VERSION,
  PRESET_PROVIDERS,
  routingLabel,
  isHelperDifficulty,
  isPresetModel,
  isPresetProvider,
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
import { noteRoutingPolicyChanged, setRoutingPolicyListener } from './helper-routing-changes';
import { onMcpEnablementChanged } from './mcp-settings';
import { readLayeredPersonaRaw } from './materialization-service';
import { checkHelperEffort, checkHelperModel, modelListFor } from './model-check';
import * as orchestrationSettings from './orchestration-settings';
import { appendSettingsAudit, type SettingsAuditSurface } from './settings-audit';
import { AUTO_TIERS, decideAutoProvider, type AutoCandidate, type AutoDecision } from './helper-auto-policy';
import { _resetHelperAutoStateForTesting, reserveAutoDecision, rotationCursors } from './helper-auto-state';
import type { DecisionCandidate, DecisionQuota, DecisionQuotaWindow, HelperDecisionRecord } from '../../shared/telemetry/helper-usage-contract';
import { getSettings as getOrchestratorSettings } from './orchestrator-settings';
import { readProjectAgentDefaults, writeProjectAgentDefaults } from './agent-settings-service';
import type { DurableAgentConfig } from '../../shared/types';
import { decideHelperAuto, type ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Checking a cell ──────────────────────────────────────────────────────

/** The id that means "pass no --model". */
const CLI_DEFAULT_MODEL = 'default';

interface CellCheck {
  state: PresetCellState;
  staleReason?: PresetStaleReason;
  /** Why it is stale, or what couldn't be checked: a sentence for a person. */
  message?: string;
}

/** Check a model and effort against the CLI's list, under a project's profile. Never throws. */
async function checkCell(provider: string, cell: PresetCell, projectPath: string | undefined): Promise<CellCheck> {
  // A difficulty must not run on whatever the CLI happens to default to.
  if (cell.model === CLI_DEFAULT_MODEL) {
    return { state: 'stale', staleReason: 'model_unavailable', message: 'A preset has to name a model, not the CLI\'s default.' };
  }
  const model = await checkHelperModel(provider, cell.model, projectPath);
  if (model.ok === false) return { state: 'stale', staleReason: 'model_unavailable', message: model.message };
  if (!cell.effort) return model.warning ? { state: 'unverified', message: model.warning } : { state: 'valid' };
  const effort = await checkHelperEffort(provider, cell.model, cell.effort, projectPath);
  if (effort.ok === false) return { state: 'stale', staleReason: 'effort_unavailable', message: effort.message };
  const warning = model.warning ?? effort.warning;
  return warning ? { state: 'unverified', message: warning } : { state: 'valid' };
}

interface ResolvedCell {
  cell: PresetCell;
  source: 'custom_mapping' | 'builtin_mapping';
  fallback: HelperRoutingFallback;
  warning?: string;
}

/**
 * The cell a start uses: the saved one, else the built-in if the saved one is
 * stale, with a fallback code saying so. Null when neither is valid.
 */
async function resolveCell(
  provider: PresetProvider,
  difficulty: HelperDifficulty,
  projectPath: string | undefined,
): Promise<{ resolved: ResolvedCell | null; problems: string[] }> {
  const custom = orchestrationSettings.getPresets()[provider]?.[difficulty];
  const builtin = BUILTIN_PRESETS[provider][difficulty];
  const problems: string[] = [];
  if (custom) {
    const check = await checkCell(provider, custom, projectPath);
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
  const check = await checkCell(provider, builtin, projectPath);
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
  persona?: string;
  /** The CLI the helper gets when nothing else names one. */
  orchestratorCli?: string;
  /** The project the helper is created in: its persona, and the profile whose login the lists follow. */
  projectPath: string;
}

/** One provider Auto could still use, with what it would run. */
interface AutoOption {
  provider: PresetProvider;
  cell: ResolvedCell;
  quota: QuotaView;
  /** Provider and profile: see candidateKey. */
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
  /** What the persona must leave alone, because the request named it. */
  keep: ReadonlyArray<'orchestrator' | 'model'>;
  routing: HelperRouting;
  /** A preset that couldn't be fully checked. */
  warning?: string;
}

export type StartPlanResult =
  | { ok: true; plan: StartPlan | null }
  /** `message` is for the orchestrator. `userReason` follows "because" in what a person who approved the start reads. */
  | { ok: false; code: 'no_valid_mapping' | 'auto_not_supported' | 'auto_off' | 'no_candidate'; message: string; userReason: string; decision?: HelperDecisionRecord };

/** What a persona's front-matter sets for a CLI and model. Unreadable means nothing: the creation refuses a missing persona. */
async function personaPins(projectPath: string, persona: string | undefined): Promise<{ orchestrator?: string; model?: string }> {
  if (!persona) return {};
  try {
    const raw = await readLayeredPersonaRaw(projectPath, persona);
    if (!raw) return {};
    const settings = parsePersonaFile(raw).settings as { orchestrator?: unknown; model?: unknown };
    return {
      ...(typeof settings.orchestrator === 'string' && settings.orchestrator && { orchestrator: settings.orchestrator }),
      ...(typeof settings.model === 'string' && settings.model && { model: settings.model }),
    };
  } catch (err) {
    // telemetry-exempt: logged; the start goes on as if the persona pinned nothing
    appLog('core:mcp', 'warn', 'start_helper: could not read a persona', { meta: { persona, error: errorText(err) } });
    return {};
  }
}

/**
 * The order is: the request, then the persona's pins, then a preset (with
 * `difficulty`), then nothing passed, so the CLI's own default. A preset's effort
 * belongs to its model, so it isn't used when the model came from elsewhere.
 * Returns no plan for a start that asked for nothing: that is today's path, and
 * it records nothing.
 */
export async function planHelperStart(request: StartPlanRequest): Promise<StartPlanResult> {
  const { cli, model, effort, difficulty, persona, orchestratorCli, projectPath } = request;
  if (!cli && !model && !effort && !difficulty) return { ok: true, plan: null };

  const pinned = await personaPins(projectPath, persona);
  const wantsAuto = cli === AUTO_CLI;
  if (wantsAuto) {
    if (!request.auto?.effective) return autoOffRefusal(request.auto);
    // A persona's pin decides, and Auto has nothing to balance. Its CLI or the orchestrator's is used.
    if (!pinned.orchestrator && !pinned.model) return prepareAuto(request);
  }
  // A persona's model goes with its CLI: it can't run on another one the request named.
  const otherCli = !!cli && !wantsAuto && !!pinned.orchestrator && pinned.orchestrator !== cli;
  const pins = otherCli ? {} : pinned;
  const namedCli = wantsAuto ? undefined : cli;
  const provider = namedCli ?? pins.orchestrator ?? orchestratorCli;
  const providerSource: HelperRoutingFieldSource = namedCli ? 'request' : pins.orchestrator ? 'persona' : 'orchestrator';
  let resolvedModel = model ?? pins.model;
  let modelSource: HelperRoutingFieldSource = model ? 'request' : pins.model ? 'persona' : 'cli_default';
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
      const { resolved, problems } = await resolveCell(provider, validDifficulty, projectPath);
      if (!resolved) {
        return {
          ok: false,
          code: 'no_valid_mapping',
          message: `No ${validDifficulty} preset for ${provider} is offered now: ${problems.join('; ')} ` +
            'Name a model with list_models, or ask the user to update Settings > Helpers.',
          userReason: `no ${validDifficulty} preset for ${provider} is offered now. Change it in Settings > Helpers.`,
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

  // A persona's model comes unchecked, and it may not be one this CLI runs (`opus` on Codex).
  if (modelSource === 'persona' && resolvedModel) {
    const check = await checkHelperModel(provider, resolvedModel, projectPath);
    if (check.ok === false) {
      // A preset was asked for and can't be honoured. Otherwise it's the persona's call, as before: say so.
      if (validDifficulty) {
        return {
          ok: false,
          code: 'no_valid_mapping',
          message: `This helper's persona sets the model "${resolvedModel}", which ${provider} doesn't offer: ${check.message} ` +
            'Name a CLI and model yourself, or use another persona.',
          userReason: `its persona sets the model "${resolvedModel}", which ${provider} doesn't offer.`,
        };
      }
      warning = check.message;
    } else if (check.warning) {
      warning = check.warning;
      if (validDifficulty) fallback = 'model_unverified';
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
      keep: [...(namedCli ? ['orchestrator' as const] : []), ...(model || otherCli ? ['model' as const] : [])],
      ...(warning && { warning }),
      routing: {
        mode: wantsAuto ? 'auto' : validDifficulty ? 'preset' : 'explicit',
        balanced: false,
        decidedAt: new Date().toISOString(),
        policyVersion: HELPER_ROUTING_POLICY_VERSION,
        requested: { provider: cli ?? null, model: model ?? null, effort: effort ?? null, difficulty: validDifficulty },
        resolved: { provider: provider ?? null, model: passedModel ?? null, effort: resolvedEffort ?? null, difficulty: validDifficulty },
        source: { provider: providerSource, model: modelSource, effort: effortSource },
        reason: wantsAuto && (pinned.orchestrator || pinned.model) ? 'persona_pinned'
          : usedPreset ? 'preset_on_cli' : namedCli || model || effort ? 'explicit_request' : 'persona_pinned',
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
 * What a candidate runs under: its provider and the project's profile. A proxy
 * for a subscription, never more: two profiles on one account can't be told
 * apart without reading credentials, which this never does.
 */
async function candidateKey(provider: string, projectPath: string): Promise<string> {
  const profileId = await readProjectAgentDefaults(projectPath).then((d) => d?.profileId, (): undefined => undefined);
  return `${provider}:${profileId ?? 'default'}`;
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
  for (const other of getAllProviders()) {
    if (!isPresetProvider(other.id) && (enabled.length === 0 || enabled.includes(other.id))) skipped[other.id] = 'auto_not_supported';
  }
  const options: AutoOption[] = [];
  await Promise.all(PRESET_PROVIDERS.map(async (provider) => {
    if (enabled.length > 0 && !enabled.includes(provider)) { skipped[provider] = 'cli_disabled'; return; }
    if (!(await providerUsable(provider, projectPath))) { skipped[provider] = 'cli_unavailable'; return; }
    if (await isProviderCoolingDown(provider, projectPath)) { skipped[provider] = 'cooling_down'; return; }
    const { resolved } = await resolveCell(provider, difficulty, projectPath);
    if (!resolved) { skipped[provider] = 'no_valid_mapping'; return; }
    const quota = await readProviderQuota(provider, projectPath, { model: resolved.cell.model });
    options.push({ provider, cell: resolved, quota, key: await candidateKey(provider, projectPath) });
  }));
  // A stable order for what's shown. The choice doesn't depend on it.
  options.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const usable = options.filter((o) => o.quota.state !== 'exhausted' && o.quota.state !== 'near_limit');
  if (usable.length === 0) return noCandidate(difficulty, skipped, options, orchestratorCli);
  return {
    ok: true,
    plan: {
      pendingAuto: { options, skipped, difficulty, ...(orchestratorCli && { orchestratorCli }) },
      keep: ['orchestrator', 'model'],
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
      keep: ['orchestrator', 'model'],
      routing,
      decision: autoDecisionRecord({ decisionId, now, difficulty, orchestratorCli, options, skipped, load, decision, routing }),
      ...(cell.warning && { warning: cell.warning }),
    },
  };
}

/**
 * Whether `cli: "auto"` is allowed, at the scope asked about. A project or a
 * persona can turn it off and never on, so a cloned repository can't spend another
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
        persona: { value: policy?.personaAutoOff ? false as const : null, editable: false as const },
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

async function viewCell(provider: PresetProvider, difficulty: HelperDifficulty, projectPath: string | undefined): Promise<PresetCellView> {
  const custom = orchestrationSettings.getPresets()[provider]?.[difficulty] ?? null;
  const builtin = BUILTIN_PRESETS[provider][difficulty];
  const shown = await checkCell(provider, custom ?? builtin, projectPath);
  const { resolved } = await resolveCell(provider, difficulty, projectPath);
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

async function viewProvider(provider: PresetProvider, projectPath: string | undefined, refresh: boolean): Promise<ProviderRoutingView> {
  const instance = getProvider(provider as OrchestratorId);
  let choices: Extract<ProviderRoutingView, { autoEligible: true }>['choices'] = { source: 'fallback', asOf: null, models: [] };
  const forcedQuota = refresh ? forceProviderQuota(provider, projectPath) : null;
  let listSource = 'none';
  let modelCount = 0;
  let listFailed = false;
  if (instance) {
    try {
      // App-wide, whatever profile the cells are read under: presets are app-wide, so this is what a write takes.
      // Forced first, so the cells below read the new list from the cache.
      const list = await modelListFor(instance, undefined, refresh);
      if (list) {
        listSource = list.source;
        modelCount = list.models.length;
        const models: PresetChoice[] = list.models.filter((m) => !m.hidden && m.id !== CLI_DEFAULT_MODEL).map((m) => ({ id: m.id, label: m.label, efforts: m.efforts ?? [] }));
        choices = { source: list.source, asOf: new Date(list.fetchedAt).toISOString(), models };
      }
    } catch (err) {
      // telemetry-exempt: logged; the page shows the saved choices as unverified
      listFailed = true;
      appLog('core:mcp', 'warn', 'Helper presets: could not list models', { meta: { provider, error: errorText(err) } });
    }
  }
  const [cells, quota] = await Promise.all([
    Promise.all(HELPER_DIFFICULTIES.map((d) => viewCell(provider, d, projectPath))),
    forcedQuota ? forcedQuota.then((forced) => forced.quota) : readProviderQuota(provider, projectPath),
  ]);
  if (forcedQuota) {
    const quotaOutcome = (await forcedQuota).outcome;
    const quotaProblem = quotaOutcome === 'failed' || quotaOutcome === 'timed_out' ? `quota_${quotaOutcome}` : null;
    const outcome = [...(listFailed ? ['list_failed'] : []), ...(quotaProblem ? [quotaProblem] : [])].join('+') || 'ok';
    appLog('core:mcp', 'info', 'Helper presets: asked a CLI again', { meta: { provider, source: listSource, models: modelCount, outcome } });
  }
  return {
    autoEligible: true,
    quota,
    choices,
    cells: Object.fromEntries(HELPER_DIFFICULTIES.map((d, i) => [d, cells[i]])) as Record<HelperDifficulty, PresetCellView>,
  };
}

/**
 * The page's data. A CLI's list can take a handshake, cached for about ten
 * minutes. `projectPath` reads cells under that project's profile, so their state
 * says what a start there would do; `choices` stay app-wide, since a write is.
 * Reads made without one also notice a cell whose state changed, and move the
 * revision. `refresh` asks each preset CLI again first, for its app-wide list and
 * its limits, for someone who just signed in. A project's own list isn't forced.
 */
export async function readHelperRouting(options: { projectPath?: string; autoContext?: Parameters<typeof readHelperAuto>[0]; refresh?: boolean } = {}): Promise<HelperRoutingSettings> {
  const providers: Record<string, ProviderRoutingView> = {};
  await Promise.all(PRESET_PROVIDERS.map(async (p) => { providers[p] = await viewProvider(p, options.projectPath, options.refresh === true); }));
  for (const other of getAllProviders()) {
    if (!isPresetProvider(other.id)) {
      providers[other.id] = { autoEligible: false, reason: 'auto_not_supported', quota: await readProviderQuota(other.id, options.projectPath), cells: null };
    }
  }
  if (!options.projectPath) {
    const signature = JSON.stringify(PRESET_PROVIDERS.map((p) => {
      const view = providers[p];
      return view.autoEligible ? HELPER_DIFFICULTIES.map((d) => view.cells[d].state) : null;
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
    if (!isHelperDifficulty(cell.difficulty)) throw invalid(`difficulty must be one of ${HELPER_DIFFICULTIES.join(', ')}.`);
    if (!isPresetModel(cell.model)) throw invalid('That isn\'t a model id.');
    if (cell.model === CLI_DEFAULT_MODEL) throw invalid('A preset has to name a model, not the CLI\'s default.');
    if (cell.effort !== null && !isEffortValue(cell.effort)) throw invalid('effort must be a level or null.');
  }
  const { reset } = update;
  if (reset) {
    if (reset.provider !== undefined && !isPresetProvider(reset.provider)) throw invalid(`${String(reset.provider)} has no presets.`);
    if (reset.difficulty !== undefined && !isHelperDifficulty(reset.difficulty)) throw invalid(`difficulty must be one of ${HELPER_DIFFICULTIES.join(', ')}.`);
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
  const { [reset.difficulty as HelperDifficulty]: _cell, ...cells } = saved[provider] ?? {};
  const { [provider]: _old, ...rest } = saved;
  return Object.keys(cells).length > 0 ? { ...rest, [provider]: cells } : rest;
}

async function auditPresetChanges(before: SavedPresets, after: SavedPresets, surface: SettingsAuditSurface): Promise<void> {
  for (const provider of PRESET_PROVIDERS) {
    for (const difficulty of HELPER_DIFFICULTIES) {
      const was = before[provider]?.[difficulty];
      const now = after[provider]?.[difficulty];
      if (cellText(was) === cellText(now)) continue;
      await appendSettingsAudit({ surface, scope: 'app', key: `helper_presets.${provider}.${difficulty}`, before: cellText(was), after: cellText(now), outcome: 'ok' });
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
    const check = await checkCell(provider, { model, effort }, undefined);
    if (check.state === 'stale') {
      return refuse(new HelperRoutingError(check.staleReason as HelperRoutingErrorCode, check.message ?? 'That choice isn\'t offered.'));
    }
  }

  if (update.auto !== undefined) {
    if (projectPath) {
      const defaults = await readProjectAgentDefaults(projectPath);
      const before = defaults.helperAuto ?? null;
      const { helperAuto: _old, ...rest } = defaults;
      // This write moves the revision itself, so what it returns is current.
      ownProjectWrites++;
      try {
        await writeProjectAgentDefaults(projectPath, { ...rest, ...(update.auto === 'off' && { helperAuto: 'off' as const }) });
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
    const d = difficulty as HelperDifficulty;
    // Only what differs from a built-in is kept, so a built-in that moves on is followed.
    if (sameCell({ model, effort }, BUILTIN_PRESETS[p][d])) {
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

/** MCP going on or off decides Auto for every agent under it. Returns the unsubscribe function. */
export function watchRoutingPolicy(): () => void {
  return onMcpEnablementChanged(() => noteRoutingPolicyChanged());
}

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
