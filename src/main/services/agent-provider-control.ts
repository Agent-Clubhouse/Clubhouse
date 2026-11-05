/** Guided provider changes. No implicit stop, wake, context transfer or file migration. */
import { createHash } from 'node:crypto';
import { getDurableConfig, updateDurableConfig, flushAgentConfig } from './agent-config';
import { agentRegistry } from './agent-registry';
import { agentTransitionGeneration, withAgentTransition } from './agent-transition';
import { isAgentRunning, isAgentStopping, checkAvailability, resolveOrchestrator, resolveProfileEnv, waitForAgentStopped } from './agent-system';
import { sessionCaptureFor, hasSessionCaptureFailure, noteSessionCaptureFailure } from './session-capture-barrier';
import { effectiveOrchestrators } from './mobile-agents';
import { readProjectAgentDefaults } from './agent-settings-service';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { isChatEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { getPermissionMode } from './free-agent-settings';
import { MobileControlError } from './mobile-control';
import type { DurableAgentConfig } from '../../shared/types';

export interface ProviderControlActor { key: string; assertAuthorized: () => void | Promise<void> }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = (value: DurableAgentConfig): DurableAgentConfig => JSON.parse(JSON.stringify(value));
const fail = (code: string): never => { throw new MobileControlError(code, 409); };

export async function previewAgentProvider(projectPath: string, agentId: string, providerId: string, actor: ProviderControlActor, tokenGeneration?: number) {
  await actor.assertAuthorized();
  const found = await getDurableConfig(projectPath, agentId);
  if (!found || isDisposedAgent(found)) return fail('agent_not_found');
  const config = snapshot(found);
  const generation = agentTransitionGeneration(agentId);
  const current = await resolveOrchestrator(projectPath, config.orchestrator);
  const allowed = await effectiveOrchestrators(projectPath);
  if (!allowed.some((p) => p.id === providerId)) return fail('orchestrator_unavailable');
  const provider = await resolveOrchestrator(projectPath, providerId);
  const defaults = await readProjectAgentDefaults(projectPath);
  const env = await resolveProfileEnv(projectPath, providerId);
  const availability = await checkAvailability(projectPath, providerId);
  const cwd = config.worktreePath || projectPath;
  let instructions: 'equivalent' | 'different' | 'unverified' = 'unverified';
  let instructionFingerprint: string | null = null;
  try {
    if (!current.inspectInstructions || !provider.inspectInstructions) throw new Error('instruction_inspection_unsupported');
    const [before, after] = await Promise.all([current.inspectInstructions(cwd), provider.inspectInstructions(cwd)]);
    instructionFingerprint = hash([before, after]);
    instructions = before === after ? 'equivalent' : 'different';
  } catch { /* telemetry-exempt: the preview explicitly blocks unreadable instructions, without logging their contents. */ }
  const activeProvider = agentRegistry.get(agentId)?.orchestrator ?? null;
  const state = isAgentStopping(agentId) || sessionCaptureFor(agentId) ? 'stopping'
    : isAgentRunning(agentId) ? 'running' : activeProvider ? 'starting'
      : config.creation?.state === 'creating' ? 'creating' : 'sleeping';
  const mode = resolveRuntimeMode(providerId, config.runtimeMode);
  const blocked = state !== 'sleeping' ? `agent_${state}`
    : hasSessionCaptureFailure(agentId) ? 'session_capture_failed'
    : !availability.available ? 'orchestrator_unavailable'
      : ((providerId !== current.id && ((defaults?.permissions?.deny?.length ?? 0) > 0 || (defaults?.permissions?.allow?.length ?? 0) > 0)) || !provider.getCapabilities().permissions || (config.freeAgentMode && getPermissionMode(projectPath) === 'auto' && providerId !== 'claude-code')) ? 'incompatible_permissions'
        : mode.mode === 'chat' && (!isChatEnabled() || !resolveChatDriver(providerId, mode.driver)) ? 'incompatible_runtime'
          : instructions !== 'equivalent' ? 'instructions_not_equivalent' : null;
  await actor.assertAuthorized();
  const fresh = await getDurableConfig(projectPath, agentId);
  if (hash(resolveRuntimeMode(providerId, config.runtimeMode)) !== hash(mode)) return fail('stale_state');
  if (hash(fresh) !== hash(config) || agentTransitionGeneration(agentId) !== generation) return fail('stale_state');
  // Secrets and source text participate only in this opaque precondition; neither is returned/logged.
  const expectedState = hash([actor.key, projectPath, config, tokenGeneration ?? generation, providerId, current.id, state,
    defaults, env, mode, getPermissionMode(projectPath), instructionFingerprint, blocked]);
  return {
    agentId, savedProvider: current.id, activeProvider, provider: providerId, state, expectedState,
    available: availability.available, availabilityMeaning: 'local_cli_only' as const,
    instructions, instructionScope: 'native_primary_only' as const, targetRuntime: mode.mode, blocked, canSave: blocked === null,
    historyRetained: true, contextTransferred: false,
    nextStart: providerId === current.id && config.lastSessionId ? 'resume_requires_validation' : 'new_session',
    settingsReset: providerId === current.id ? [] : ['model', 'effort', 'contextWindow', 'routing', 'resumePointer'],
  };
}

export async function persistGuidedSessionCapture(projectPath: string, agentId: string): Promise<void> {
  try { await flushAgentConfig(projectPath); }
  catch { noteSessionCaptureFailure(agentId); return fail('session_capture_failed'); }
  if (hasSessionCaptureFailure(agentId)) return fail('session_capture_failed');
}

export async function changeAgentProvider(projectPath: string, agentId: string, provider: string, expectedState: string, actor: ProviderControlActor) {
  // Capture settles before acquiring the exclusive reservation; an exit must be able to persist history.
  if (isAgentRunning(agentId) || isAgentStopping(agentId)) return fail('agent_running');
  if (!(await waitForAgentStopped(agentId))) return fail('agent_stopping');
  return withAgentTransition(agentId, async () => {
    await persistGuidedSessionCapture(projectPath, agentId);
    const generation = agentTransitionGeneration(agentId);
    const preview = await previewAgentProvider(projectPath, agentId, provider, actor);
    if (preview.expectedState !== expectedState) return fail('stale_state');
    if (preview.blocked) return fail(preview.blocked);
    await actor.assertAuthorized();
    if (preview.savedProvider === provider) return { ...preview, status: 'already_selected' as const };
    const before = hash(await getDurableConfig(projectPath, agentId));
    await updateDurableConfig(projectPath, agentId, { orchestrator: provider }, async () => {
      const final = await previewAgentProvider(projectPath, agentId, provider, actor, generation);
      if (final.expectedState !== expectedState || final.blocked) return fail('stale_state');
      if (hash(await getDurableConfig(projectPath, agentId)) !== before) return fail('stale_state');
    });
    return { ...preview, expectedState: undefined as string | undefined, savedProvider: provider, activeProvider: null as string | null,
      status: 'changed' as const, nextStart: 'new_session', state: 'sleeping' };
  });
}
