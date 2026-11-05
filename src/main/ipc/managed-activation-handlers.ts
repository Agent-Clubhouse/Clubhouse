import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { BaseAdoption } from '../../shared/asset-catalog-types';
import type { ActivationAdoptRequest, ActivationDeliveryPreview, ActivationPolicyChoice, ActivationPreviewRequest, ActivationReceiptView,
  ActivationTarget, ActivationUiErrorCode, ActivationUiResult, ActivationUnassignRequest } from '../../shared/managed-activation-ui';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { peekProjects, projectRegistryMutationState } from '../services/project-store';
import { agentConfigGeneration, peekDurableConfigs } from '../services/agent-config';
import { getBaseDirPath } from '../services/base-dir';
import { isDispatcherPath } from '../services/dispatcher/dispatcher-paths';
import { AssetCatalogError, assetCatalogDir, createAssetCatalogStore, type AssetCatalogStore } from '../services/asset-catalog/store';
import { canonicalHash } from '../services/asset-catalog/planner';
import * as backend from '../services/managed-activation';
import type { ActivationReceipt } from '../services/managed-activation/types';
import { AgentTransitionError } from '../services/agent-transition';
import { ManagedActivationError } from '../services/managed-activation/types';
import { numberArg, objectArg, stringArg, withValidatedArgs, type ArgValidator } from './validation';

const bad = (): never => { throw new Error('Invalid activation request'); };
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const raw = objectArg<Record<string, unknown>>()(value, 'activation request');
  if (Object.keys(raw).length !== allowed.length || Object.keys(raw).some((key) => !allowed.includes(key))) bad();
  return raw;
}
function targetArg(value: unknown): ActivationTarget {
  const raw = fields(value, ['projectId', 'agentId']);
  return { projectId: stringArg({ maxLength: 256 })(raw.projectId, 'project id'), agentId: stringArg({ maxLength: 256 })(raw.agentId, 'agent id') };
}
function revisionArg(value: unknown): number {
  const revision = numberArg({ integer: true, min: 0 })(value, 'revision');
  if (!Number.isSafeInteger(revision)) bad(); return revision;
}
function policyArg(value: unknown): ActivationPolicyChoice {
  const raw = fields(value, ['content', 'structure']);
  if (!['takeable', 'hold-preview'].includes(raw.content as string) || !['accepted', 'latest-if-clean'].includes(raw.structure as string)) bad();
  return raw as unknown as ActivationPolicyChoice;
}
export const activationPreviewArg: ArgValidator<ActivationPreviewRequest> = (value) => {
  const raw = fields(value, ['target', 'compositionRevision', 'receiptRevision', 'policy']);
  return { target: targetArg(raw.target), compositionRevision: revisionArg(raw.compositionRevision), receiptRevision: revisionArg(raw.receiptRevision), policy: policyArg(raw.policy) };
};
export const activationAdoptArg: ArgValidator<ActivationAdoptRequest> = (value) => {
  const raw = fields(value, ['target', 'compositionRevision', 'receiptRevision', 'policy', 'deliveryToken']);
  const { deliveryToken, ...request } = raw;
  return { ...activationPreviewArg(request, 'request'), deliveryToken: stringArg({ minLength: 64, maxLength: 64 })(deliveryToken, 'delivery token') };
};
export const activationUnassignArg: ArgValidator<ActivationUnassignRequest> = (value) => {
  const raw = fields(value, ['target', 'receiptRevision']); return { target: targetArg(raw.target), receiptRevision: revisionArg(raw.receiptRevision) };
};
const uiCode = (error: unknown): ActivationUiErrorCode => {
  if (error instanceof AgentTransitionError) return 'busy';
  const code = error instanceof ManagedActivationError || error instanceof AssetCatalogError ? error.code : '';
  if (['activation_scope_changed', 'activation_stale', 'stale_revision', 'stale_preview', 'stale_choice'].includes(code)) return 'stale';
  if (code === 'activation_not_permitted' || code === 'agent_not_permitted') return 'not_permitted';
  if (code === 'activation_unsupported' || code === 'activation_resume_unproven') return 'unsupported';
  if (code === 'activation_incompatible_config') return 'incompatible';
  if (code === 'activation_capability_unproven') return 'capability_unproven';
  if (code === 'activation_capability_stale') return 'capability_stale';
  if (code === 'activation_busy') return 'busy';
  if (code === 'activation_skill_unsupported') return 'skill_unsupported';
  if (code === 'activation_runtime_unreconciled') return 'unreconciled';
  if (['composition_blocked', 'plan_blocked', 'adoption_policy_required'].includes(code)) return 'catalog_blocked';
  return 'failed';
};

export function registerManagedActivationHandlers(store: AssetCatalogStore = createAssetCatalogStore({ dir: assetCatalogDir() }), api: Pick<typeof backend, 'readManagedActivation' | 'previewManagedActivation' | 'adoptManagedActivation' | 'unassignManagedActivation'> = backend): void {
  const tokens = new Map<string, { request: ActivationPreviewRequest; projectPath: string; expires: number }>();
  async function target(input: ActivationTarget) {
    const project = (await peekProjects()).find((item) => item.id === input.projectId);
    if (!project || isDispatcherPath(project.path)) return null;
    const projectPath = await fs.realpath(project.path);
    if (isDispatcherPath(projectPath)) return null;
    const agent = (await peekDurableConfigs(projectPath)).find((item) => item.id === input.agentId);
    if (!agent || isDisposedAgent(agent) || agent.creation || agent.persona === 'dispatcher' || agent.parentAgentId || !agent.worktreePath) return null;
    return { projectPath, workspacePath: await fs.realpath(agent.worktreePath) };
  }
  function mutationGuard(input: ActivationTarget, expected: NonNullable<Awaited<ReturnType<typeof target>>>): backend.ManagedMutationGuard {
    return { prepare: async () => {
      // App-owned registration bytes also cover changes whose async write completed before
      // its notification. Config generation covers acknowledged, not-yet-flushed edits.
      const version = () => {
        const registry = projectRegistryMutationState();
        if (registry.pending) throw new ManagedActivationError('activation_stale');
        return canonicalHash({ registry: registry.generation, generation: agentConfigGeneration(), files: [
        path.join(getBaseDirPath(), 'projects.json'), path.join(getBaseDirPath(), 'projects.json.bak'),
        path.join(expected.projectPath, '.clubhouse', 'agents.json'), path.join(expected.projectPath, '.clubhouse', 'agents.json.bak'),
      ].map((file) => {
        try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      }) }); };
      const original = version();
      const current = await target(input);
      if (!current || current.projectPath !== expected.projectPath || current.workspacePath !== expected.workspacePath
        || version() !== original) throw new ManagedActivationError('activation_scope_changed');
      // Pending registry writes are excluded even before their I/O/notification completes.
      // With the agent reservation held, no new app mutation can begin between this
      // synchronous check and state replacement. This is not a filesystem sandbox.
      return () => { if (version() !== original) throw new ManagedActivationError('activation_scope_changed'); };
    } };
  }
  async function receipt(input: ActivationTarget, resolved: NonNullable<Awaited<ReturnType<typeof target>>>): Promise<ActivationReceiptView> {
    const [index, state] = await Promise.all([store.read(), api.readManagedActivation(input.agentId)]);
    if (state && (state.scope.projectPath !== resolved.projectPath || state.scope.workspacePath !== resolved.workspacePath)) throw new ManagedActivationError('activation_scope_changed');
    return toView(input, index.compositions[input.agentId]?.revision ?? 0, state);
  }
  async function perform<T>(input: ActivationTarget, run: (resolved: NonNullable<Awaited<ReturnType<typeof target>>>) => Promise<T>): Promise<ActivationUiResult<T>> {
    try {
      const resolved = await target(input); if (!resolved) return { ok: false, code: 'target_unavailable' };
      return { ok: true, view: await run(resolved) };
    } catch (error) {
      // telemetry-exempt: return closed codes only; instruction text and raw capability/filesystem errors stay private.
      return { ok: false, code: uiCode(error) };
    }
  }
  async function explicitAdoption(request: ActivationPreviewRequest): Promise<BaseAdoption> {
    const structure = { mode: request.policy.structure };
    if (request.policy.content === 'takeable') return { content: { mode: 'takeable' }, structure };
    // Only after the person selects Hold: bind the complete saved selection to the revisions
    // in this delivery preview. This is not the Builder editor's snapshot policy/default.
    const plan = await store.plan({ agentId: request.target.agentId, projectId: request.target.projectId, adoption: { content: { mode: 'takeable' }, structure } });
    if (plan.compositionRevision !== request.compositionRevision) throw new ManagedActivationError('activation_stale');
    if (!plan.activation) throw new AssetCatalogError('composition_blocked');
    const refs = [ ...(plan.activation.instructions?.blocks ?? []), ...plan.activation.assets,
      ...plan.activation.subagents.flatMap((item) => [item, ...item.blocks, ...item.skills, ...item.mcps]) ];
    const revisions: Record<string, number> = {};
    for (const ref of refs) revisions[ref.assetId] = ref.revision;
    return { content: { mode: 'hold', revisions }, structure };
  }
  ipcMain.handle(IPC.AGENT.ACTIVATION_READ, withValidatedArgs([targetArg], (_event, input) => perform(input, (resolved) => receipt(input, resolved))));
  ipcMain.handle(IPC.AGENT.ACTIVATION_PREVIEW, withValidatedArgs([activationPreviewArg], (_event, request) => perform(request.target, async (resolved): Promise<ActivationDeliveryPreview> => {
    const current = await receipt(request.target, resolved);
    if (current.compositionRevision !== request.compositionRevision || current.receiptRevision !== request.receiptRevision) throw new ManagedActivationError('activation_stale');
    const adoption = await explicitAdoption(request);
    const preview = await api.previewManagedActivation({ projectPath: resolved.projectPath, agentId: request.target.agentId, projectId: request.target.projectId,
      expectedRevision: request.receiptRevision, adoption });
    const latestTarget = await target(request.target);
    if (!latestTarget || latestTarget.projectPath !== resolved.projectPath || latestTarget.workspacePath !== resolved.workspacePath
      || preview.compositionRevision !== request.compositionRevision) throw new ManagedActivationError('activation_stale');
    for (const [token, entry] of tokens) if (entry.expires < Date.now()) tokens.delete(token);
    if (tokens.size >= 100) tokens.delete(tokens.keys().next().value!);
    tokens.set(preview.token, { request, projectPath: resolved.projectPath, expires: Date.now() + 5 * 60_000 });
    return { ...request, deliveryToken: preview.token, instructions: preview.instructions, instructionLabel: preview.instructionLabel,
      ambientContext: preview.ambientContext, skillNames: preview.skillNames, cliVersion: preview.capability.version };
  })));
  ipcMain.handle(IPC.AGENT.ACTIVATION_ADOPT, withValidatedArgs([activationAdoptArg], (_event, request) => perform(request.target, async (resolved) => {
    const entry = tokens.get(request.deliveryToken); const { deliveryToken: _token, ...selection } = request;
    if (!entry || entry.expires < Date.now() || entry.projectPath !== resolved.projectPath || canonicalHash(entry.request) !== canonicalHash(selection)) throw new ManagedActivationError('activation_stale');
    const current = await receipt(request.target, resolved);
    if (current.compositionRevision !== request.compositionRevision || current.receiptRevision !== request.receiptRevision) throw new ManagedActivationError('activation_stale');
    await api.adoptManagedActivation(request.target.agentId, request.deliveryToken, mutationGuard(request.target, resolved)); tokens.delete(request.deliveryToken);
    return receipt(request.target, resolved);
  })));
  ipcMain.handle(IPC.AGENT.ACTIVATION_UNASSIGN, withValidatedArgs([activationUnassignArg], (_event, request) => perform(request.target, async (resolved) => {
    const current = await receipt(request.target, resolved);
    if (current.receiptRevision !== request.receiptRevision) throw new ManagedActivationError('activation_stale');
    await api.unassignManagedActivation(request.target.agentId, request.receiptRevision, mutationGuard(request.target, resolved));
    return receipt(request.target, resolved);
  })));
}

function toView(target: ActivationTarget, compositionRevision: number, state: ActivationReceipt | null): ActivationReceiptView {
  return { target, compositionRevision, receiptRevision: state?.revision ?? 0, desiredGenerationId: state?.desired ?? null,
    materializedGenerationId: state?.materialized ?? null,
    generations: Object.values(state?.generations ?? {}).map((generation) => ({ id: generation.id, compositionRevision: generation.compositionRevision,
      preparedAt: generation.preparedAt, materializedAt: generation.materializedAt, skillNames: generation.skillNames,
      observations: generation.runs.map(({ attemptId, intendedAt, startedAt, endedAt, outcome, cleanupRequested, cleanupConfirmed }) =>
        ({ attemptId, intendedAt, startedAt, endedAt, outcome, cleanupRequested, cleanupConfirmed })) })) };
}
