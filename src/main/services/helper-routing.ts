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
import { isProviderCoolingDown, readProviderQuota } from './provider-quota';
import { readLayeredPersonaRaw } from './materialization-service';
import { checkHelperEffort, checkHelperModel, modelListFor } from './model-check';
import * as orchestrationSettings from './orchestration-settings';
import { appendSettingsAudit, type SettingsAuditSurface } from './settings-audit';
import { AUTO_RESERVATION_MS, AUTO_STICKY_MS, decideAutoProvider, type AutoCandidate } from './helper-auto-policy';
import { getSettings as getOrchestratorSettings } from './orchestrator-settings';
import { readProjectAgentDefaults, writeProjectAgentDefaults } from './agent-settings-service';
import type { DurableAgentConfig } from '../../shared/types';
import type { ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';

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
  /** Who is asking, for Auto's sticky choice. */
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
  quota: QuotaDecisionView;
}

export interface StartPlan {
  /** Auto, waiting to be decided under the start lock: see decideAutoPlan. */
  pendingAuto?: { options: AutoOption[]; skipped: Record<string, HelperRoutingSkip>; difficulty: HelperDifficulty; orchestratorId: string; orchestratorCli?: string };
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
  | { ok: false; code: 'no_valid_mapping' | 'auto_not_supported' | 'auto_off' | 'no_candidate'; message: string; userReason: string };

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
    if (!request.auto?.effective) {
      const why = routingLabel('autoOff', request.auto?.reason ?? 'not_enabled');
      return { ok: false, code: 'auto_off', message: `Auto provider is off for you: ${why}. Name a CLI, or ask the user to turn it on.`, userReason: `Auto provider is off: ${why}.` };
    }
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
    options.push({ provider, cell: resolved, quota: decisionQuota(quota) });
  }));
  // Registration order, whichever read finished first.
  options.sort((a, b) => PRESET_PROVIDERS.indexOf(a.provider) - PRESET_PROVIDERS.indexOf(b.provider));
  const usable = options.filter((o) => o.quota.state !== 'exhausted' && o.quota.state !== 'near_limit');
  if (usable.length === 0) return noCandidate(difficulty, skipped, options);
  return {
    ok: true,
    plan: {
      pendingAuto: { options, skipped, difficulty, orchestratorId: request.orchestratorId ?? '', ...(orchestratorCli && { orchestratorCli }) },
      keep: ['orchestrator', 'model'],
      routing: {} as HelperRouting,
    },
  };
}

function noCandidate(difficulty: HelperDifficulty, skipped: Record<string, HelperRoutingSkip>, options: readonly AutoOption[]): StartPlanResult {
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
  };
}

const stickyChoices = new Map<string, { provider: string; at: number }>();

function stickyFor(orchestratorId: string, difficulty: string): string | undefined {
  const key = `${orchestratorId}\0${difficulty}`;
  const choice = stickyChoices.get(key);
  if (!choice) return undefined;
  if (Date.now() - choice.at > AUTO_STICKY_MS) {
    stickyChoices.delete(key);
    return undefined;
  }
  return choice.provider;
}

/** Helpers Auto has chosen and hasn't yet seen live, by id. Counted in load so a burst spreads out. */
const reservations = new Map<string, { provider: string; expires: number }>();

/** Add a chosen helper's reservation, once its id is known. Called under the start lock. */
export function reserveAutoHelper(helperId: string, provider: string): void {
  reservations.set(helperId, { provider, expires: Date.now() + AUTO_RESERVATION_MS });
}

/** The start has settled, one way or the other: its row counts for itself now. */
export function releaseAutoHelper(helperId: string): void {
  reservations.delete(helperId);
}

/** Reservations as load, without double counting a helper already seen live. */
export function reservedLoad(liveIds: ReadonlySet<string>): Record<string, number> {
  const now = Date.now();
  const load: Record<string, number> = {};
  for (const [id, reservation] of reservations) {
    if (reservation.expires <= now) reservations.delete(id);
    else if (!liveIds.has(id)) load[reservation.provider] = (load[reservation.provider] ?? 0) + 1;
  }
  return load;
}

/**
 * Make Auto's choice, under the start lock, from what prepareAuto read and the
 * load right now. Decided once: nothing moves this helper later.
 */
export function decideAutoPlan(plan: StartPlan, load: Readonly<Record<string, number>>): StartPlanResult {
  const pending = plan.pendingAuto;
  if (!pending) return { ok: true, plan };
  const { options, skipped, difficulty, orchestratorId, orchestratorCli } = pending;
  const unverified = new Set(options.filter((o) => o.cell.fallback === 'model_unverified').map((o) => o.provider));
  const candidates: AutoCandidate[] = options.map((o) => ({ provider: o.provider, quotaState: o.quota.state, ...(unverified.has(o.provider) && { unverified: true }) }));
  const decision = decideAutoProvider({
    candidates, load, ...(orchestratorCli && { orchestratorCli }),
    ...(orchestratorId && { sticky: stickyFor(orchestratorId, difficulty) }),
  });
  if (decision.ok === false) return noCandidate(difficulty, skipped, options);
  const chosen = options.find((o) => o.provider === decision.provider)!;
  if (orchestratorId) stickyChoices.set(`${orchestratorId}\0${difficulty}`, { provider: decision.provider, at: Date.now() });
  const allSkipped = { ...skipped, ...decision.skipped };
  const { cell } = chosen;
  const effort = cell.cell.effort ?? undefined;
  const routing: HelperRouting = {
    mode: 'auto',
    balanced: true,
    decidedAt: new Date(Date.now()).toISOString(),
    policyVersion: HELPER_ROUTING_POLICY_VERSION,
    requested: { provider: AUTO_CLI, model: null, effort: null, difficulty },
    resolved: { provider: decision.provider, model: cell.cell.model, effort: effort ?? null, difficulty },
    source: { provider: 'auto', model: cell.source, effort: effort ? cell.source : 'cli_default' },
    reason: decision.reason,
    // Copilot can never be chosen, so its being skipped isn't a fallback.
    fallback: cell.fallback !== 'none' ? cell.fallback : Object.values(allSkipped).some((code) => code !== 'auto_not_supported') ? 'candidate_skipped' : 'none',
    context: { status: 'none' },
    load: Object.fromEntries(options.map((o) => [o.provider, load[o.provider] ?? 0])),
    quota: Object.fromEntries(options.map((o) => [o.provider, o.quota])),
    quotaBasis: chosen.quota.state === 'unknown' ? 'unknown_scored_as_healthy' : 'known',
    ...(Object.keys(allSkipped).length > 0 && { skipped: allSkipped }),
  };
  return {
    ok: true,
    plan: {
      provider: decision.provider,
      model: cell.cell.model,
      ...(effort && { effort }),
      keep: ['orchestrator', 'model'],
      routing,
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
  const project = projectPath ? (await readProjectAgentDefaults(projectPath)).helperAuto === 'off' : false;
  const policy = agent?.policy;
  const stored = agent?.config.orchestration?.autoHelpers;
  const personaOff = policy?.sources.autoHelpers === 'persona';
  const locked = !!dispatcher;
  const scopes: HelperAutoView['scopes'] = {
    app: { value: app, editable: true },
    ...(projectPath && !locked && { project: { value: project ? 'off' as const : null, choices: ['off', null] as ['off', null], editable: true } }),
    ...(agent && !locked && {
      persona: { value: personaOff ? false as const : null, editable: false as const },
      agent: { value: stored ?? null, editable: !policy?.mcpOff },
    }),
  };
  if (locked) {
    return { effective: false, source: 'dispatcher_locked', reason: 'dispatcher_locked', scopes: { app: { value: app, editable: true }, agent: { value: null, editable: false } } };
  }
  const off = (source: HelperAutoView['source'], reason: HelperAutoView['reason']): HelperAutoView => ({ effective: false, source, reason, scopes });
  if (policy?.mcpOff) return off('mcp_off', 'mcp_off');
  if (project) return off('project', 'project_off');
  if (personaOff) return off('persona', 'persona_off');
  if (policy && !policy.orchestrate) return off(stored !== undefined ? 'agent' : app ? 'app' : 'default', 'orchestration_off');
  if (stored !== undefined) return stored ? { effective: true, source: 'agent', scopes } : off('agent', 'not_enabled');
  return app ? { effective: true, source: 'app', scopes } : off('default', 'not_enabled');
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

function emitChanged(): void {
  const revision = helperRoutingRevision();
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

async function viewProvider(provider: PresetProvider, projectPath: string | undefined): Promise<ProviderRoutingView> {
  const instance = getProvider(provider as OrchestratorId);
  let choices: Extract<ProviderRoutingView, { autoEligible: true }>['choices'] = { source: 'fallback', asOf: null, models: [] };
  if (instance) {
    try {
      // App-wide, whatever profile the cells are read under: presets are app-wide, so this is what a write takes.
      const list = await modelListFor(instance, undefined);
      if (list) {
        const models: PresetChoice[] = list.models.filter((m) => !m.hidden && m.id !== CLI_DEFAULT_MODEL).map((m) => ({ id: m.id, label: m.label, efforts: m.efforts ?? [] }));
        choices = { source: list.source, asOf: new Date(list.fetchedAt).toISOString(), models };
      }
    } catch (err) {
      // telemetry-exempt: logged; the page shows the saved choices as unverified
      appLog('core:mcp', 'warn', 'Helper presets: could not list models', { meta: { provider, error: errorText(err) } });
    }
  }
  const [cells, quota] = await Promise.all([
    Promise.all(HELPER_DIFFICULTIES.map((d) => viewCell(provider, d, projectPath))),
    readProviderQuota(provider, projectPath),
  ]);
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
 * revision.
 */
export async function readHelperRouting(options: { projectPath?: string; autoContext?: Parameters<typeof readHelperAuto>[0] } = {}): Promise<HelperRoutingSettings> {
  const providers: Record<string, ProviderRoutingView> = {};
  await Promise.all(PRESET_PROVIDERS.map(async (p) => { providers[p] = await viewProvider(p, options.projectPath); }));
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
    await readHelperRouting(),
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
      await writeProjectAgentDefaults(projectPath, { ...rest, ...(update.auto === 'off' && { helperAuto: 'off' as const }) });
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

/** For testing. */
export function _resetHelperRoutingForTesting(): void {
  stateEpoch = 0;
  lastStateSignature = null;
  stickyChoices.clear();
  reservations.clear();
  writeChain = Promise.resolve();
  listeners.clear();
}
