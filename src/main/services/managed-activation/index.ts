/** Main-only activation entry points. No agent tools, IPC handlers or renderer API expose this yet. */
import * as path from 'path';
import * as fs from 'fs';
import type { DurableAgentConfig } from '../../../shared/types';
import type { BaseAdoption } from '../../../shared/asset-catalog-types';
import type { SpawnAgentParams } from '../agent-system';
import { getBaseDirPath } from '../base-dir';
import { assetCatalogDir, createAssetCatalogStore } from '../asset-catalog/store';
import { peekDurableConfigs } from '../agent-config';
import { withAgentActivity, withAgentTransition } from '../agent-transition';
import { agentRegistry, resolveOrchestrator } from '../agent-registry';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import { isClubhouseModeEnabled } from '../clubhouse-mode-settings';
import { isHookServerEnabled } from '../orchestrator-settings';
import { isMcpEnabled } from '../mcp-settings';
import { clubhouseMcpOverride, isDisposedAgent } from '../../../shared/agent-helpers';
import { readLaunchWrapper, readProjectAgentDefaults } from '../agent-settings-service';
import { currentSettingsOrigin } from '../settings-audit';
import { ManagedActivationError } from './types';
import { assertDeliveryCapability, cliIdentity, establishDeliveryCapability } from './capability';
import { createManagedActivationService, type AdoptionRequest, type ManagedLaunchLease, type WorkspaceRequest } from './service';

let service: ReturnType<typeof createManagedActivationService> | undefined;
let serviceDir: string | undefined;
function getService() {
  const dir = path.join(getBaseDirPath(), 'managed-activation');
  if (!service || serviceDir !== dir) {
    serviceDir = dir;
    service = createManagedActivationService({ dir, catalog: createAssetCatalogStore({ dir: assetCatalogDir() }) });
  }
  return service;
}
const pendingPreviews = new Map<string, { input: AdoptionRequest; expires: number }>();
function assertUser() {
  const origin = currentSettingsOrigin();
  if (origin.actorId || ['mcp', 'cli', 'dispatcher'].includes(origin.surface)) throw new ManagedActivationError('activation_not_permitted');
}
function assertSynchronousCompatibility(projectPath: string, config: DurableAgentConfig): void {
  if (process.platform !== 'darwin' || resolveRuntimeMode('claude-code', config.runtimeMode).mode !== 'terminal') throw new ManagedActivationError('activation_unsupported');
  if ((isClubhouseModeEnabled(projectPath) && !config.clubhouseModeOverride) || isHookServerEnabled('claude-code')
    || isMcpEnabled(projectPath, clubhouseMcpOverride(config))) throw new ManagedActivationError('activation_incompatible_config');
}
async function context(projectPath: string, agentId: string, launch?: SpawnAgentParams): Promise<{ workspace: WorkspaceRequest; binary: string; assertCanCreate(): void }> {
  if (process.platform !== 'darwin') throw new ManagedActivationError('activation_unsupported');
  const configs = await peekDurableConfigs(projectPath);
  const config = configs.find((agent) => agent.id === agentId);
  if (!config?.worktreePath || config.creation || isDisposedAgent(config)) throw new ManagedActivationError('activation_scope_changed');
  const provider = await resolveOrchestrator(projectPath, config.orchestrator);
  if (provider.id !== 'claude-code' || !provider.getBinaryPath || resolveRuntimeMode(provider.id, config.runtimeMode).mode !== 'terminal') throw new ManagedActivationError('activation_unsupported');
  if (launch?.resume || launch?.sessionId) throw new ManagedActivationError('activation_resume_unproven');
  // No driver/provider fallback, added instruction source, wrapper, native-agent file or new grants.
  if (launch && (launch.kind !== 'durable' || launch.systemPrompt || launch.agentFile || launch.agentSource
    || (launch.orchestrator && launch.orchestrator !== provider.id) || launch.cwd !== config.worktreePath)) throw new ManagedActivationError('activation_unsupported');
  if (config.agentFile || config.agentSource || config.parentAgentId || config.orchestration?.orchestrate
    || (isClubhouseModeEnabled(projectPath) && !config.clubhouseModeOverride)
    || (await readProjectAgentDefaults(projectPath)).commandPrefix
    || isHookServerEnabled(provider.id) || isMcpEnabled(projectPath, clubhouseMcpOverride(config)) || await readLaunchWrapper(projectPath)) {
    throw new ManagedActivationError('activation_incompatible_config');
  }
  const otherWorkspaces = [...configs.filter((agent) => agent.id !== agentId).flatMap((agent) => agent.worktreePath ? [agent.worktreePath] : []),
    ...[...agentRegistry.getAllRegistrations()].filter(([id]) => id !== agentId).flatMap(([, registration]) => registration.cwd ? [registration.cwd] : [])];
  const selectedBinary = provider.getBinaryPath();
  return { binary: selectedBinary, assertCanCreate: () => {
    assertSynchronousCompatibility(projectPath, config);
    if (fs.realpathSync(provider.getBinaryPath!()) !== fs.realpathSync(selectedBinary)) throw new ManagedActivationError('activation_capability_stale');
  }, workspace: { projectPath, workspacePath: config.worktreePath, agentName: config.name, provider: provider.id, otherWorkspaces } };
}

export interface PreviewManagedActivationRequest {
  projectPath: string; agentId: string; adoption: BaseAdoption; expectedRevision: number; projectId?: string;
}
/** Explicit local-user preview. Executes installed CLI help/version only, never a prompt/auth probe. */
export async function previewManagedActivation(input: PreviewManagedActivationRequest) {
  assertUser();
  return withAgentTransition(input.agentId, async () => {
    const resolved = await context(input.projectPath, input.agentId);
    const capability = await establishDeliveryCapability(resolved.binary);
    const request: AdoptionRequest = { agentId: input.agentId, expectedRevision: input.expectedRevision, adoption: input.adoption,
      projectId: input.projectId, workspace: resolved.workspace, capability };
    const preview = await getService().preview(request);
    for (const [token, value] of pendingPreviews) if (value.expires < Date.now()) pendingPreviews.delete(token);
    if (pendingPreviews.size >= 100) pendingPreviews.delete(pendingPreviews.keys().next().value!);
    pendingPreviews.set(preview.token, { input: request, expires: Date.now() + 5 * 60_000 });
    return preview;
  });
}
/** A delivery preview token, not a composition-only fingerprint, authorizes the exact next-start snapshot. */
export async function adoptManagedActivation(agentId: string, previewToken: string) {
  assertUser();
  return withAgentTransition(agentId, async () => {
    const preview = pendingPreviews.get(previewToken);
    if (!preview || preview.expires < Date.now() || preview.input.agentId !== agentId) throw new ManagedActivationError('activation_stale');
    const resolved = await context(preview.input.workspace.projectPath, agentId);
    await assertDeliveryCapability(preview.input.capability, resolved.binary);
    // Rebuild the preview with current context; its token detects capability, scope and catalog changes.
    const result = await getService().adopt({ ...preview.input, workspace: resolved.workspace, previewToken });
    pendingPreviews.delete(previewToken); return result;
  });
}
export async function unassignManagedActivation(agentId: string, expectedRevision: number) {
  assertUser();
  return withAgentTransition(agentId, () => getService().unassign(agentId, expectedRevision));
}
export async function readManagedActivation(agentId: string) { assertUser(); return getService().read(agentId); }

/**
 * Legacy starts keep their existing activity path. Managed starts reacquire an exclusive transition
 * reservation before resolving files or creating a process; config/provider writes cannot race them.
 */
export async function withManagedActivationLaunch<T>(params: SpawnAgentParams, isRunning: () => boolean,
  run: (lease: ManagedLaunchLease | null) => Promise<T>): Promise<T> {
  const probe = await withAgentActivity(params.agentId, async () => {
    let state = null;
    if (params.kind === 'durable') {
      try {
        fs.lstatSync(path.join(getBaseDirPath(), 'managed-activation', params.agentId, 'state.json'));
        state = await getService().read(params.agentId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (state && isRunning()) throw new ManagedActivationError('activation_busy');
    if (state && Object.values(state.generations).some((generation) => generation.runs.some((attempt) => !attempt.endedAt))) throw new ManagedActivationError('activation_runtime_unreconciled');
    if (state?.desired) return { managed: true as const };
    return { managed: false as const, result: await run(null) };
  });
  if (!probe.managed) return probe.result;
  return withAgentTransition(params.agentId, () => withAgentActivity(params.agentId, () => getService().launch(params.agentId,
    async () => {
      const latest = await context(params.projectPath, params.agentId, params);
      const state = (await getService().read(params.agentId))!;
      await assertDeliveryCapability(state.generations[state.desired!].capability, latest.binary);
      return latest.workspace;
    }, isRunning, async (lease) => {
      // Once adopted, inability to deliver cannot silently become a legacy start.
      if (!lease) throw new ManagedActivationError('activation_stale');
      let assertLatestPolicy: () => void = () => { throw new ManagedActivationError('activation_stale'); };
      return run({ ...lease, beforeStart: async (binary) => {
        const latest = await context(params.projectPath, params.agentId, params);
        if (JSON.stringify(await cliIdentity(latest.binary)) !== JSON.stringify(await cliIdentity(binary))) throw new ManagedActivationError('activation_capability_stale');
        await lease.beforeStart(binary);
        assertLatestPolicy = latest.assertCanCreate;
      }, assertCanCreate: () => { assertLatestPolicy(); lease.assertCanCreate(); } });
    })));
}
