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
  isHelperDifficulty,
  isPresetModel,
  isPresetProvider,
  type HelperDifficulty,
  type HelperRouting,
  type HelperRoutingFallback,
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
import { readLayeredPersonaRaw } from './materialization-service';
import { checkHelperEffort, checkHelperModel, modelListFor } from './model-check';
import * as orchestrationSettings from './orchestration-settings';
import { appendSettingsAudit, type SettingsAuditSurface } from './settings-audit';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Checking a cell ──────────────────────────────────────────────────────

interface CellCheck {
  state: PresetCellState;
  staleReason?: PresetStaleReason;
  /** Why it is stale, or what couldn't be checked: a sentence for a person. */
  message?: string;
}

/** Check a model and effort against the CLI's list, under a project's profile. Never throws. */
async function checkCell(provider: string, cell: PresetCell, projectPath: string | undefined): Promise<CellCheck> {
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

export interface StartPlanRequest {
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

export interface StartPlan {
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
  | { ok: false; code: 'no_valid_mapping' | 'auto_not_supported'; message: string };

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
  // A persona's model goes with its CLI: it can't run on another one the request named.
  const otherCli = !!cli && !!pinned.orchestrator && pinned.orchestrator !== cli;
  const pins = otherCli ? {} : pinned;
  const provider = cli ?? pins.orchestrator ?? orchestratorCli;
  const providerSource: HelperRoutingFieldSource = cli ? 'request' : pins.orchestrator ? 'persona' : 'orchestrator';
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
      keep: [...(cli ? ['orchestrator' as const] : []), ...(model || otherCli ? ['model' as const] : [])],
      ...(warning && { warning }),
      routing: {
        mode: validDifficulty ? 'preset' : 'explicit',
        balanced: false,
        decidedAt: new Date().toISOString(),
        policyVersion: HELPER_ROUTING_POLICY_VERSION,
        requested: { provider: cli ?? null, model: model ?? null, effort: effort ?? null, difficulty: validDifficulty },
        resolved: { provider: provider ?? null, model: passedModel ?? null, effort: resolvedEffort ?? null, difficulty: validDifficulty },
        source: { provider: providerSource, model: modelSource, effort: effortSource },
        reason: usedPreset ? 'preset_on_cli' : cli || model || effort ? 'explicit_request' : 'persona_pinned',
        fallback,
        context: { status: 'none' },
      },
    },
  };
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
      const list = await modelListFor(instance, projectPath);
      if (list) {
        const models: PresetChoice[] = list.models.filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.label, efforts: m.efforts ?? [] }));
        choices = { source: list.source, asOf: new Date(list.fetchedAt).toISOString(), models };
      }
    } catch (err) {
      // telemetry-exempt: logged; the page shows the saved choices as unverified
      appLog('core:mcp', 'warn', 'Helper presets: could not list models', { meta: { provider, error: errorText(err) } });
    }
  }
  const cells = await Promise.all(HELPER_DIFFICULTIES.map((d) => viewCell(provider, d, projectPath)));
  return {
    autoEligible: true,
    choices,
    cells: Object.fromEntries(HELPER_DIFFICULTIES.map((d, i) => [d, cells[i]])) as Record<HelperDifficulty, PresetCellView>,
  };
}

/**
 * The page's data. A CLI's list can take a handshake, cached for about ten
 * minutes. `projectPath` reads under that project's profile. Reads made without
 * one also notice a cell whose state changed, and move the revision.
 */
export async function readHelperRouting(options: { projectPath?: string } = {}): Promise<HelperRoutingSettings> {
  const providers: Record<string, ProviderRoutingView> = {};
  await Promise.all(PRESET_PROVIDERS.map(async (p) => { providers[p] = await viewProvider(p, options.projectPath); }));
  for (const other of getAllProviders()) {
    if (!isPresetProvider(other.id)) providers[other.id] = { autoEligible: false, reason: 'auto_not_supported', cells: null };
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
  return { revision: helperRoutingRevision(), labels: HELPER_ROUTING_LABELS, providers };
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
}

function checkShape(update: HelperRoutingUpdate): void {
  const invalid = (message: string) => new HelperRoutingError('invalid_helper_routing', message);
  if (typeof update?.revision !== 'string' || savedPartOf(update.revision) === null) throw invalid('Send the revision this change was made from.');
  if (!update.cells?.length && !update.reset) throw invalid('Send cells to change or a reset.');
  for (const cell of update.cells ?? []) {
    if (!isPresetProvider(cell?.provider)) throw invalid(`${String(cell?.provider)} has no presets.`);
    if (!isHelperDifficulty(cell.difficulty)) throw invalid(`difficulty must be one of ${HELPER_DIFFICULTIES.join(', ')}.`);
    if (!isPresetModel(cell.model)) throw invalid('That isn\'t a model id.');
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

async function writePresets(update: HelperRoutingUpdate, { surface }: PresetWriteOrigin): Promise<HelperRoutingSettings> {
  const action = update?.reset && !update.cells?.length
    ? update.reset.difficulty ? 'reset_cell' : update.reset.provider ? 'reset_provider' : 'reset_all'
    : 'set';
  const refuse = async (err: HelperRoutingError): Promise<never> => {
    await appendSettingsAudit({ surface, scope: 'app', key: 'helper_presets', outcome: 'refused', code: err.code });
    helperPresetsChanged(action, surface, false);
    throw err;
  };

  try {
    checkShape(update);
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
  writeChain = Promise.resolve();
  listeners.clear();
}
