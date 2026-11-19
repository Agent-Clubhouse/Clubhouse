import { assertManagedProviderPlatform, managedProviderPlatformCapability } from './managed-provider-platform';
/** Guided provider changes. V2 prepares only a missing managed primary file;
 * neither version implicitly stops, wakes or transfers session context. */
import { createHash } from 'node:crypto';
import { getDurableConfig, updateDurableConfig, flushAgentConfig, peekCachedDurableConfig, peekDurableConfigsChecked } from './agent-config';
import { agentRegistry } from './agent-registry';
import { agentTransitionGeneration, withAgentTransition } from './agent-transition';
import { isAgentRunning, isAgentStopping, checkAvailability, resolveOrchestrator, waitForAgentStopped } from './agent-system';
import { sessionCaptureFor, hasSessionCaptureFailure, noteSessionCaptureFailure } from './session-capture-barrier';
import { effectiveOrchestrators } from './mobile-agents';
import { readLaunchWrapper, readProjectAgentDefaults } from './agent-settings-service';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { isChatEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { agentAccess } from './free-agent-settings';
import { accessLevelsFor } from '../../shared/agent-access';
import { MobileControlError } from './mobile-control';
import { isDispatcherPath } from './dispatcher/dispatcher-paths';
import { modelsChosenByHand } from './dispatcher/dispatcher-models';
import type { DurableAgentConfig, DurableConfigUpdates } from '../../shared/types';
import type { ProviderControlReceipt, ProviderNextWake, ProviderSelection } from '../../shared/mobile-control';
import { isDeepStrictEqual } from 'node:util';
import { previewManagedProviderTransition, prepareManagedProviderTransition, managedProviderMarker, managedProviderCommitFence, providerSettingsCommitFence, type ManagedProviderPlan } from './managed-provider-transition';
import { readProviderSelectionCatalog, resolveProviderSelectionCatalog } from './provider-selection-catalog';

export interface ProviderControlActor { key: string; assertAuthorized: () => void | Promise<void>; assertCommitAuthorized?: () => void }
/** Main-only witness, never serialized in a preview receipt. */
export interface ProviderPreviewWitness { catalogFingerprint?: string; assertCurrent?: (agent: DurableAgentConfig) => void }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = (value: DurableAgentConfig): DurableAgentConfig => JSON.parse(JSON.stringify(value));
const fail = (code: string): never => { throw new MobileControlError(code, 409); };

function selectionIntent(selection: ProviderSelection) {
  if (selection.contractVersion !== undefined && selection.contractVersion !== 2) return fail('unsupported_version');
  if (selection.contractVersion !== 2) {
    if (selection.model !== undefined || selection.effort !== undefined) return fail('unsupported_version');
    return null;
  }
  const model = selection.model;
  if (model !== undefined && (model.kind === 'selected' ? !model.id || model.id === 'default' || model.id.length > 256 : model.kind !== 'provider_default')) return fail('invalid_selection');
  if (selection.effort !== undefined && selection.effort !== null && typeof selection.effort !== 'string') return fail('invalid_selection');
  const normalizedModel = model === undefined ? undefined : model.kind === 'selected' ? { kind: 'selected' as const, id: model.id } : { kind: 'provider_default' as const };
  return { contractVersion: 2 as const, ...(normalizedModel !== undefined && { model: normalizedModel }), ...(selection.effort !== undefined && { effort: selection.effort }) };
}
export function providerNextWake(config: DurableAgentConfig, effectiveProvider: string): ProviderNextWake {
  const model = config.model && config.model !== 'default' ? config.model : null;
  return { provider: effectiveProvider, providerOverride: config.orchestrator ?? null,
    model: { value: model, source: model ? 'agent' : 'provider_default' },
    effort: { value: config.effort || null, source: config.effort ? 'agent' : 'provider_default' } };
}
function proposedConfig(config: DurableAgentConfig, current: string, provider: string, selection: ProviderSelection): DurableAgentConfig {
  const next = snapshot(config);
  // A no-op keeps an inherited provider inherited. A real setting update pins
  // the effective provider, matching the guarded durable write below. Preparing
  // a missing managed marker is also a write and previews that explicit pin.
  if (provider !== current || selection.model !== undefined || selection.effort !== undefined || config.managed && !config.providerTransition) next.orchestrator = provider;
  if (provider !== current) {
    delete next.model; delete next.effort; delete next.contextWindow; delete next.routing; delete next.lastSessionId; delete next.providerTransition;
    for (const session of next.sessionHistory ?? []) session.orchestrator ??= current;
  }
  if (selection.model !== undefined) {
    const model = selection.model.kind === 'selected' ? selection.model.id : undefined;
    if (model !== next.model) { delete next.effort; delete next.routing; }
    if (model) next.model = model; else delete next.model;
  }
  if (selection.effort !== undefined) {
    if (selection.effort === null) delete next.effort; else next.effort = selection.effort;
  }
  return next;
}

/** While its models are chosen by hand (#3191), the Dispatcher's provider is a pick, changed in Settings, never here. */
export const DISPATCHER_MODELS_BY_HAND_MESSAGE = 'The Dispatcher’s models are chosen by hand. Change its provider in Settings > Dispatcher, or turn off Choose models yourself first.';
function assertNotChosenByHand(projectPath: string): void {
  if (isDispatcherPath(projectPath) && modelsChosenByHand()) throw new MobileControlError('dispatcher_models_by_hand', 409, 'rejected', DISPATCHER_MODELS_BY_HAND_MESSAGE);
}

export async function previewAgentProvider(projectPath: string, agentId: string, providerId: string, actor: ProviderControlActor, tokenGeneration?: number, selection: ProviderSelection = {}, witness?: ProviderPreviewWitness) {
  const intent = selectionIntent(selection);
  await actor.assertAuthorized();
  assertNotChosenByHand(projectPath);
  if (intent && isDispatcherPath(projectPath)) return fail('dispatcher_models_automatic');
  const found = await getDurableConfig(projectPath, agentId, intent ? { forLaunch: true } : undefined);
  if (!found || isDisposedAgent(found)) return fail('agent_not_found');
  const config = snapshot(found);
  if (intent && (config.managed || config.providerTransition)) assertManagedProviderPlatform();
  const generation = agentTransitionGeneration(agentId);
  const current = await resolveOrchestrator(projectPath, config.orchestrator);
  const allowed = effectiveOrchestrators();
  if (!allowed.some((p) => p.id === providerId)) return fail('orchestrator_unavailable');
  const provider = await resolveOrchestrator(projectPath, providerId);
  const defaults = await readProjectAgentDefaults(projectPath, intent ? { strict: true } : {});
  const wrapper = intent ? await readLaunchWrapper(projectPath, { strict: true }) : undefined;
  const availability = await checkAvailability(projectPath, providerId);
  const cwd = config.worktreePath || projectPath;
  let instructions: 'equivalent' | 'different' | 'unverified' = 'unverified';
  let instructionFingerprint: string | null = null;
  let managedBlocked: string | null = null;
  let managedPreparation: 'create' | 'keep' | null = null;
  let managedPlan: ManagedProviderPlan | undefined;
  try {
    if (intent && config.managed) {
      const plan = await previewManagedProviderTransition(projectPath, config, current, provider);
      managedPlan = plan;
      instructionFingerprint = plan.fingerprint;
      managedBlocked = plan.blocked;
      managedPreparation = plan.target ? 'keep' : 'create';
      instructions = plan.blocked ? 'different' : 'equivalent';
    } else {
      if (!current.inspectInstructions || !provider.inspectInstructions) throw new Error('instruction_inspection_unsupported');
      const [before, after] = await Promise.all([current.inspectInstructions(cwd), provider.inspectInstructions(cwd)]);
      instructionFingerprint = hash([before, after]);
      instructions = before === after ? 'equivalent' : 'different';
    }
  } catch (err) {
    if (intent && config.managed) managedBlocked = err instanceof MobileControlError ? err.code : 'managed_instructions_unreadable';
    /* telemetry-exempt: unreadable instructions block without logging their contents. */
  }
  const activeProvider = agentRegistry.get(agentId)?.orchestrator ?? null;
  const state = isAgentStopping(agentId) || sessionCaptureFor(agentId) ? 'stopping'
    : isAgentRunning(agentId) ? 'running' : activeProvider ? 'starting'
      : config.creation?.state === 'creating' ? 'creating' : 'sleeping';
  const mode = resolveRuntimeMode(providerId, config.runtimeMode);
  // The project's legacy permission rules can't be carried to another CLI, but they never reach a managed agent (#3243, #3245).
  const legacyRules = !config.managed && ((defaults?.permissions?.deny?.length ?? 0) > 0 || (defaults?.permissions?.allow?.length ?? 0) > 0);
  const proposed = proposedConfig(config, current.id, providerId, selection);
  const catalog = intent ? await readProviderSelectionCatalog(provider, proposed.model, proposed.effort, !!proposed.model && proposed.model !== 'default') : null;
  if (witness && catalog) witness.catalogFingerprint = catalog.fingerprint;
  const blocked = state !== 'sleeping' ? `agent_${state}`
    : hasSessionCaptureFailure(agentId) ? 'session_capture_failed'
    : !availability.available ? 'orchestrator_unavailable'
      : ((providerId !== current.id && legacyRules) || !provider.getCapabilities().permissions || !accessLevelsFor(providerId, mode.mode === 'chat' ? 'chat' : 'terminal').includes(agentAccess(config, projectPath))) ? 'incompatible_permissions'
        : mode.mode === 'chat' && (!isChatEnabled() || !resolveChatDriver(providerId, mode.driver)) ? 'incompatible_runtime'
          : intent && !actor.assertCommitAuthorized ? 'commit_authority_unverified'
            : intent && (wrapper || defaults.commandPrefix) ? 'managed_delivery_unsupported'
              : intent && !config.managed && current.id !== providerId ? 'managed_transition_required'
          : intent && current.id === providerId && config.contextWindow && proposed.model !== config.model ? 'context_choice_requires_review'
            : managedBlocked ?? (instructions !== 'equivalent' ? 'instructions_not_equivalent' : catalog?.blocked ?? null);
  await actor.assertAuthorized();
  const fresh = await getDurableConfig(projectPath, agentId, intent ? { forLaunch: true } : undefined);
  if (hash(resolveRuntimeMode(providerId, config.runtimeMode)) !== hash(mode)) return fail('stale_state');
  if (hash(fresh) !== hash(config) || agentTransitionGeneration(agentId) !== generation) return fail('stale_state');
  // Secrets and source text participate only in this opaque precondition; neither is returned/logged.
  const precondition = [actor.key, projectPath, config, tokenGeneration ?? generation, providerId, current.id, state,
    defaults, mode, agentAccess(config, projectPath), instructionFingerprint, blocked];
  // Keep the v1 token recipe intact. Explicit v2 binds normalized proposal and catalog.
  const expectedState = hash(intent ? [...precondition, intent, proposed, wrapper, catalog?.fingerprint] : precondition);
  const contract: ProviderControlReceipt | undefined = intent ? { version: 2, target: { agentId }, selection: intent,
    current: providerNextWake(config, current.id), saved: providerNextWake(config, current.id), proposed: providerNextWake(proposed, providerId),
    running: { provider: activeProvider, evidence: activeProvider ? 'registry_selection' : 'none', model: null, effort: null },
    result: { status: 'preview', persisted: false, started: false } } : undefined;
  if (witness && intent && managedPlan && !blocked) {
    const assertFiles = managedProviderCommitFence(projectPath, managedPlan);
    const launchConfig = (value: DurableAgentConfig) => { const copy = { ...value }; delete copy.lastSleep; return hash(copy); };
    const signedConfig = launchConfig(config);
    const signedCatalog = catalog!.fingerprint;
    witness.assertCurrent = (live) => {
      actor.assertCommitAuthorized?.();
      if (!actor.assertCommitAuthorized || launchConfig(live) !== signedConfig || hash(resolveRuntimeMode(providerId, live.runtimeMode)) !== hash(mode)) return fail('stale_state');
      const currentCatalog = resolveProviderSelectionCatalog(provider.peekModels?.() ?? null, config.model, config.effort, !!config.model && config.model !== 'default', undefined, provider);
      if (currentCatalog.blocked || currentCatalog.fingerprint !== signedCatalog) return fail('stale_state');
      assertFiles(live);
    };
  }
  return {
    agentId, savedProvider: current.id, activeProvider, provider: providerId, state, expectedState,
    available: availability.available, availabilityMeaning: 'local_cli_only' as const,
    instructions, instructionScope: intent && config.managed ? 'managed_composition' as const : 'native_primary_only' as const, targetRuntime: mode.mode, blocked, canSave: blocked === null,
    historyRetained: true, contextTransferred: false,
    nextStart: providerId === current.id && config.lastSessionId ? 'resume_requires_validation' : 'new_session',
    settingsReset: intent ? (['model', 'effort', 'contextWindow', 'routing', 'lastSessionId'] as const)
      .filter((key) => config[key] !== undefined && proposed[key] === undefined).map((key) => key === 'lastSessionId' ? 'resumePointer' : key)
      : providerId === current.id ? [] : ['model', 'effort', 'contextWindow', 'routing', 'resumePointer'],
    ...(contract && { contract, catalog: catalog?.catalog, managedPreparation,
      configuredFingerprint: hash(config),
      runtime: mode,
      delivery: config.managed ? { nativeInstructions: 'prepared_on_apply', skills: 'none_supported', mcp: 'launch_flags', nextWake: blocked ? 'blocked' : 'revalidation_required', loaded: false } : null }),
  };
}

export async function persistGuidedSessionCapture(projectPath: string, agentId: string): Promise<void> {
  try { await flushAgentConfig(projectPath); }
  catch { noteSessionCaptureFailure(agentId); return fail('session_capture_failed'); }
  if (hasSessionCaptureFailure(agentId)) return fail('session_capture_failed');
}

export async function changeAgentProvider(projectPath: string, agentId: string, provider: string, expectedState: string, actor: ProviderControlActor, selection: ProviderSelection = {}) {
  const intent = selectionIntent(selection);
  await actor.assertAuthorized();
  const readCurrent = () => getDurableConfig(projectPath, agentId, intent ? { forLaunch: true } : undefined);
  // Refuse before even a capture/history flush; a stale POSIX token is not authority.
  if (intent && !managedProviderPlatformCapability().supported) {
    const config = await readCurrent();
    if (config?.managed || config?.providerTransition) assertManagedProviderPlatform();
  }
  // Capture settles before acquiring the exclusive reservation; an exit must be able to persist history.
  if (isAgentRunning(agentId) || isAgentStopping(agentId)) return fail('agent_running');
  if (!(await waitForAgentStopped(agentId))) return fail('agent_stopping');
  return withAgentTransition(agentId, async () => {
    await persistGuidedSessionCapture(projectPath, agentId);
    const generation = agentTransitionGeneration(agentId);
    const previewWitness: ProviderPreviewWitness = {};
    const preview = await previewAgentProvider(projectPath, agentId, provider, actor, undefined, selection, previewWitness);
    if (preview.expectedState !== expectedState) return fail('stale_state');
    if (preview.blocked) return fail(preview.blocked);
    await actor.assertAuthorized();
    const existing = await readCurrent();
    if (intent && hash(existing) !== preview.configuredFingerprint) return fail('stale_state');
    if (preview.savedProvider === provider && (!intent || (selection.model === undefined && selection.effort === undefined && (!existing?.managed || existing.providerTransition)))) return { ...preview, status: 'already_selected' as const,
      ...(preview.contract && { contract: { ...preview.contract, result: { status: 'already_selected' as const, persisted: true, started: false as const } }, nextWake: existing?.managed && existing.providerTransition ? { state: 'ready' as const, expectedState: preview.expectedState } : { state: 'blocked' as const, code: 'provider_start_unsupported' } }) };
    const reviewed = intent && existing ? proposedConfig(existing, preview.savedProvider, provider, selection) : null;
    const before = hash(await readCurrent());
    let onRejectedPreparation: (() => Promise<void>) | undefined;
    let mutationAdmitted = false;
    const commitReceipt: { received: boolean; saved: Readonly<DurableAgentConfig> | null } = { received: false, saved: null };
    let postCommitIssue = false;
    try {
      const updates: DurableConfigUpdates = { orchestrator: provider,
        ...(intent && selection.model !== undefined && { model: selection.model.kind === 'selected' ? selection.model.id : 'default' }),
        ...(intent && selection.effort !== undefined && { effort: selection.effort }),
      };
      let assertFilesCurrent: ((agent: DurableAgentConfig) => void) | undefined;
      let target = await resolveOrchestrator(projectPath, provider);
      const beforeCommit = async () => {
        const check = async () => {
          const final = await previewAgentProvider(projectPath, agentId, provider, actor, generation, selection);
          if (final.expectedState !== expectedState || final.blocked) return fail('stale_state');
          if (hash(await readCurrent()) !== before) return fail('stale_state');
        };
        await check();
        const config = await readCurrent();
        if (intent && config?.managed) {
          const current = await resolveOrchestrator(projectPath, config.orchestrator);
          target = await resolveOrchestrator(projectPath, provider);
          const plan = await previewManagedProviderTransition(projectPath, config, current, target);
          onRejectedPreparation = await prepareManagedProviderTransition(plan, check);
          const prepared = await previewManagedProviderTransition(projectPath, config, current, target);
          if (prepared.blocked || hash([prepared.root, prepared.source, prepared.composition, prepared.launchFingerprint]) !== hash([plan.root, plan.source, plan.composition, plan.launchFingerprint])) return fail('stale_state');
          updates.providerTransition = managedProviderMarker(agentId, prepared);
          if (reviewed) reviewed.providerTransition = structuredClone(updates.providerTransition);
          assertFilesCurrent = managedProviderCommitFence(projectPath, prepared);
        } else if (intent) {
          assertFilesCurrent = providerSettingsCommitFence(projectPath);
        }
        await actor.assertAuthorized();
        if (hash(await readCurrent()) !== before) return fail('stale_state');
      };
      if (intent) {
        await updateDurableConfig(projectPath, agentId, updates, beforeCommit, { prepare: async () => {}, check: (agent) => {
          if (agent.managed || agent.providerTransition || updates.providerTransition) assertManagedProviderPlatform();
          actor.assertCommitAuthorized?.();
          if (!actor.assertCommitAuthorized || hash(agent) !== before || hash(resolveRuntimeMode(provider, agent.runtimeMode)) !== hash(preview.runtime)) return fail('stale_state');
          const currentCatalog = resolveProviderSelectionCatalog(target.peekModels?.() ?? null, preview.contract!.proposed.model.value ?? undefined, preview.contract!.proposed.effort.value, !!preview.contract!.proposed.model.value, undefined, target);
          if (currentCatalog.blocked || currentCatalog.fingerprint !== previewWitness.catalogFingerprint) return fail('stale_state');
          assertFilesCurrent?.(agent);
          mutationAdmitted = true;
        } }, (committed) => { commitReceipt.received = true; commitReceipt.saved = committed; });
      } else await updateDurableConfig(projectPath, agentId, updates, beforeCommit);
    } catch (err) {
      if (intent && commitReceipt.received) {
        // Flush was acknowledged. A later notification/audit/read failure must
        // not report that the save failed or attempt native rejection cleanup.
        postCommitIssue = true;
      } else {
        let failure = err;
        try { await onRejectedPreparation?.(); }
        catch (retained) { failure = retained; }
        if (intent && (mutationAdmitted || failure instanceof MobileControlError && failure.extra?.transition)) {
          let savedUnchanged: true | null = mutationAdmitted ? null : true;
          if (mutationAdmitted) {
            try {
              const primary = await peekDurableConfigsChecked(projectPath, { strict: true });
              const matches = primary.agents.filter((agent) => agent.id === agentId);
              if (primary.readable && matches.length === 1 && hash(matches[0]) === before) savedUnchanged = true;
            } catch { /* telemetry-exempt: failed persistence verification stays explicitly unknown. */ }
          }
          const known = failure instanceof MobileControlError ? failure : undefined;
          throw new MobileControlError(known?.code ?? 'apply_failed', known?.statusCode ?? 409, 'failed',
            savedUnchanged ? 'The saved provider/settings were not changed. Review any retained native preparation before retrying.' : 'Apply outcome could not be verified. Read the saved target and any native preparation before retrying.',
            { ...known?.extra, transition: { nativePreparation: 'not_created_by_this_apply', ...(known?.extra?.transition as Record<string, unknown>), status: savedUnchanged ? 'not_applied' : 'outcome_unverified', persisted: savedUnchanged ? false : null, savedUnchanged, historyRetained: savedUnchanged, refusalCode: err instanceof MobileControlError ? err.code : 'apply_failed', nextWake: 'fresh_read_and_review_required' } });
        }
        throw failure;
      }
    }
    const saved = intent ? commitReceipt.saved : null;
    if (intent && !saved) throw new MobileControlError('apply_outcome_unverified', 409, 'failed', 'The saved target could not be verified. Read it before retrying.',
      { transition: { status: 'outcome_unverified', persisted: null, savedUnchanged: null, historyRetained: null, nextWake: 'fresh_read_and_review_required' } });
    // An accepted external merge is durable evidence, not evidence that the
    // reviewed intent won. Compare normalized choices AND promised clears and
    // retained history/marker; a fresh preview must never rebase this check.
    const acknowledgedSelection = saved ? { ...providerNextWake(saved, saved.orchestrator ?? ''), provider: saved.orchestrator || null } : null;
    const conflicts: string[] = intent ? (['provider', 'providerOverride', 'model', 'effort'] as const)
      .filter((key) => !isDeepStrictEqual(acknowledgedSelection?.[key], preview.contract!.proposed[key])) : [];
    if (intent && reviewed && saved) {
      for (const key of ['contextWindow', 'routing', 'lastSessionId'] as const) {
        if (!isDeepStrictEqual(saved[key] ?? null, reviewed[key] ?? null)) conflicts.push(key === 'lastSessionId' ? 'resumePointer' : key);
      }
      if (!isDeepStrictEqual(saved.sessionHistory ?? [], reviewed.sessionHistory ?? [])) conflicts.push('history');
      if (!isDeepStrictEqual(saved.providerTransition ?? null, reviewed.providerTransition ?? null)) conflicts.push('managedTransition');
    }
    if (conflicts.length) throw new MobileControlError('apply_committed_state_conflict', 409, 'failed',
      'Configuration was durably written, but the acknowledged state differs from the reviewed request. Read and review the saved target before continuing.',
      { transition: { status: 'committed_state_conflict', persisted: true, requestedSelectionSaved: false,
        target: preview.contract!.target, proposed: preview.contract!.proposed, conflicts,
        savedProvider: saved!.orchestrator || null, saved: saved!.orchestrator ? providerNextWake(saved!, saved!.orchestrator) : null,
        savedOverrides: { provider: saved!.orchestrator ?? null, model: saved!.model ?? null, effort: saved!.effort ?? null },
        savedUnchanged: hash(saved) === before, historyRetained: null, nextWake: 'fresh_read_and_review_required' } });
    let nextWake: { state: 'ready'; expectedState: string } | { state: 'blocked'; code: string } | undefined;
    if (intent) {
      try {
        if (postCommitIssue) throw new Error('Postcommit observer did not complete');
        const fresh = await readCurrent();
        if (!fresh || !isDeepStrictEqual(fresh, saved)) return fail('stale_state');
        const wake = await previewAgentProvider(projectPath, agentId, provider, actor, undefined, { contractVersion: 2 });
        if (!isDeepStrictEqual(wake.contract?.saved, providerNextWake(saved!, provider))) return fail('stale_state');
        nextWake = wake.blocked ? { state: 'blocked', code: wake.blocked } : !saved?.managed || !saved.providerTransition ? { state: 'blocked', code: 'provider_start_unsupported' } : { state: 'ready', expectedState: wake.expectedState };
      } catch (err) { nextWake = { state: 'blocked', code: err instanceof MobileControlError ? err.code : 'next_wake_unverified' }; }
    }
    return { ...preview, expectedState: undefined as string | undefined, savedProvider: provider, activeProvider: null as string | null,
      status: 'changed' as const, nextStart: preview.savedProvider === provider ? preview.nextStart : 'new_session', state: 'sleeping',
      ...(preview.contract && saved && { contract: { ...preview.contract, saved: providerNextWake(saved, provider),
        result: { status: 'changed' as const, persisted: true, started: false as const } }, nextWake }) };
  });
}

/** Separate v2 start admission. A native app-session id never authorizes resume;
 * the route still verifies the native pointer and its provider provenance. */
export async function verifyProviderStartPreview(projectPath: string, agentId: string, provider: string, expectedState: string, expectedNextWake: ProviderNextWake, actor: ProviderControlActor) {
  await actor.assertAuthorized();
  assertManagedProviderPlatform();
  const witness: ProviderPreviewWitness = {};
  const preview = await previewAgentProvider(projectPath, agentId, provider, actor, undefined, { contractVersion: 2 }, witness);
  if (preview.expectedState !== expectedState || !isDeepStrictEqual(preview.contract?.saved, expectedNextWake)) return fail('stale_state');
  if (preview.blocked) return fail(preview.blocked);
  const config = await getDurableConfig(projectPath, agentId, { forLaunch: true });
  // Start-v2 currently admits only the proven read-only managed terminal lane.
  if (!config?.providerTransition || !config.managed || provider !== 'codex-cli' || preview.targetRuntime !== 'terminal') return fail('provider_start_unsupported');
  if (!isDeepStrictEqual(providerNextWake(config, provider), expectedNextWake)) return fail('stale_state');
  if (!witness.assertCurrent) return fail('provider_start_unsupported');
  witness.assertCurrent(config);
  return { config, assertBeforeCreate: () => {
    const live = peekCachedDurableConfig(projectPath, agentId);
    if (!live) return fail('stale_state');
    witness.assertCurrent!(live);
  } };
}
