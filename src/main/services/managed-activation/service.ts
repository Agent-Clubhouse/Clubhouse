/** Main-internal backend. Production entry points own lifecycle reservations in index.ts.
 * History, private generations and activation pins are retained, including after unassignment.
 * No generic run cleanup owns these pins. No workspace files are created, replaced or removed.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { BaseAdoption } from '../../../shared/asset-catalog-types';
import { isCatalogId } from '../asset-catalog/validation';
import { AssetCatalogError, previewFrozenActivation, prepareFrozenActivation, readFrozenActivation, type AssetCatalogStore } from '../asset-catalog/store';
import { canonicalHash } from '../asset-catalog/planner';
import { currentSettingsOrigin, auditChanged, appendSettingsAudit } from '../settings-audit';
import { appLog } from '../log-service';
import { stageOutputs, outputsOf, verifyOutputs, byteHash } from './owned-output';
import { assertDeliveryCapability, assertDeliveryCapabilitySync, type DeliveryCapability } from './capability';
import { ManagedActivationError, ProcessStartedReceiptError, type ActivationReceipt, type ActivationScope, type PreparedGeneration } from './types';

const queues = new Map<string, Promise<unknown>>();
const launches = new Set<string>();
const uncertainRuntimes = new Map<string, ProcessStartedReceiptError>();
const fail = (code: ConstructorParameters<typeof ManagedActivationError>[0]): never => { throw new ManagedActivationError(code); };
export interface WorkspaceRequest {
  projectPath: string;
  workspacePath: string;
  agentName: string;
  provider: string;
  otherWorkspaces: readonly string[];
}
export interface AdoptionRequest {
  agentId: string;
  expectedRevision: number;
  workspace: WorkspaceRequest;
  adoption: BaseAdoption;
  projectId?: string;
  capability: DeliveryCapability;
}
export interface DeliveryPreview {
  token: string;
  compositionFingerprint: string;
  compositionRevision: number;
  instructionLabel: 'Appended managed instructions';
  ambientContext: 'Ambient CLAUDE.md and provider instructions are additional context.';
  instructions: string;
  skillNames: string[];
  capability: DeliveryCapability;
}
export interface ManagedLaunchLease {
  attemptId: string;
  /** Persist intent and validate exact staged bytes immediately before process creation. */
  beforeStart(binary: string): Promise<void>;
  assertCanCreate(): void;
  /** The observed runtime identity must be the newly created process, never an existing runtime. */
  started(runtimeIdentity: string): Promise<void>;
  notCreated(): Promise<void>;
  cleanup(error: ProcessStartedReceiptError, confirmed: boolean): Promise<void>;
  exited(): Promise<void>;
  instructionFile: string;
  pluginDir?: string;
  binary: string;
}

export async function resolveActivationScope(input: WorkspaceRequest): Promise<ActivationScope> {
  if (input.provider !== 'claude-code') fail('activation_unsupported');
  const projectPath = await fs.realpath(input.projectPath);
  const workspacePath = await fs.realpath(input.workspacePath);
  const expected = path.join(projectPath, '.clubhouse', 'agents', input.agentName);
  if (path.basename(input.agentName) !== input.agentName || input.agentName === '.' || input.agentName === '..' || workspacePath !== expected) fail('activation_scope_changed');
  const stat = await fs.stat(workspacePath);
  if (!stat.isDirectory()) fail('activation_scope_changed');
  const workspaceKey = `${stat.dev}:${stat.ino}:${workspacePath.toLowerCase()}`;
  for (const other of input.otherWorkspaces) {
    let real: string;
    try { real = await fs.realpath(other); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
    const otherStat = await fs.stat(real);
    if (real.toLowerCase() === workspacePath.toLowerCase() || (stat.ino !== 0 && otherStat.ino === stat.ino && otherStat.dev === stat.dev)) fail('activation_workspace_shared');
  }
  return { projectPath, workspacePath, workspaceKey, provider: 'claude-code' };
}
function assertUser(): void {
  const origin = currentSettingsOrigin();
  if (origin.actorId || ['mcp', 'cli', 'dispatcher'].includes(origin.surface)) fail('activation_not_permitted');
}

export interface ManagedActivationOptions {
  dir: string;
  catalog: AssetCatalogStore;
  now?: () => string;
  platform?: NodeJS.Platform;
  afterFile?: () => Promise<void>;
  beforeWrite?: (root: string) => Promise<void>;
  rename?: typeof fs.rename;
}
export function createManagedActivationService(options: ManagedActivationOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const platform = options.platform ?? process.platform;
  const checkedId = (id: string) => { if (!isCatalogId(id)) fail('activation_corrupt'); return id; };
  const key = (id: string) => path.join(path.resolve(options.dir), checkedId(id));
  const statePath = (id: string) => path.join(key(id), 'state.json');
  const generationsPath = (id: string) => path.join(key(id), 'generations');
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const queueKey = key(id);
    const task = (queues.get(queueKey) ?? Promise.resolve()).catch((): void => undefined).then(fn);
    queues.set(queueKey, task.catch((): void => undefined)); return task;
  };
  async function read(agentId: string): Promise<ActivationReceipt | null> {
    let raw: string;
    try { raw = await fs.readFile(statePath(agentId), 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
    try {
      const state: ActivationReceipt = JSON.parse(raw);
      if (state.version !== 1 || state.agentId !== agentId || !Number.isSafeInteger(state.revision) || !state.scope || !state.generations
        || (state.desired !== null && !state.generations[state.desired]) || (state.materialized !== null && !state.generations[state.materialized])) fail('activation_corrupt');
      for (const [id, generation] of Object.entries(state.generations)) {
        if (!isCatalogId(id) || generation.id !== id || !generation.pinId.startsWith('activation-pin-') || !/^[a-f0-9]{64}$/.test(generation.frozenHash)
          || !Array.isArray(generation.files) || !Array.isArray(generation.runs)) fail('activation_corrupt');
      }
      return state;
    } catch {
      // telemetry-exempt: parser errors can include damaged private state values.
      fail('activation_corrupt');
    }
  }
  async function save(state: ActivationReceipt): Promise<void> {
    const file = statePath(state.agentId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    await (options.rename ?? fs.rename)(temp, file);
  }
  async function audit<T>(agentId: string, action: 'desired' | 'unassigned', fn: () => Promise<T>): Promise<T> {
    checkedId(agentId);
    try {
      assertUser(); const result = await fn();
      try { await auditChanged('agent', `managedActivation.${action}`, agentId); }
      catch {
        // telemetry-exempt: the mutation committed; audit failure cannot turn it into a failed save.
        appLog('core:agent', 'warn', 'Could not record managed activation change', { meta: { agentId } });
      }
      return result;
    } catch (err) {
      if (err instanceof ManagedActivationError || err instanceof AssetCatalogError) await appendSettingsAudit({ ...currentSettingsOrigin(), scope: 'agent', key: `managedActivation.${action}`, targetId: agentId, outcome: 'refused', code: err.code });
      throw err;
    }
  }
  async function uniqueWorkspace(agentId: string, scope: ActivationScope): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(options.dir); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
    for (const id of entries) {
      if (id === agentId || !isCatalogId(id)) continue;
      const other = await read(id);
      if (other?.desired && other.scope.workspacePath.toLowerCase() === scope.workspacePath.toLowerCase()) fail('activation_workspace_shared');
    }
    const privatePath = path.resolve(options.dir);
    if (privatePath === scope.workspacePath || privatePath.startsWith(`${scope.workspacePath}${path.sep}`)) fail('activation_scope_changed');
  }
  async function preview(input: AdoptionRequest): Promise<DeliveryPreview> {
    assertUser();
    const scope = await resolveActivationScope(input.workspace);
    await uniqueWorkspace(input.agentId, scope);
    await assertDeliveryCapability(input.capability, input.capability.identity.path, platform);
    const state = await read(input.agentId);
    if ((state?.revision ?? 0) !== input.expectedRevision) fail('activation_stale');
    if (state && canonicalHash(state.scope) !== canonicalHash(scope)) fail('activation_scope_changed');
    const frozen = await previewFrozenActivation(options.catalog, { agentId: input.agentId, adoption: input.adoption, projectId: input.projectId });
    const output = outputsOf(frozen);
    const details = {
      compositionFingerprint: frozen.plan.fingerprint, compositionRevision: frozen.plan.compositionRevision,
      instructionLabel: 'Appended managed instructions' as const,
      ambientContext: 'Ambient CLAUDE.md and provider instructions are additional context.' as const,
      instructions: frozen.instructions!, skillNames: output.skillNames, capability: input.capability,
    };
    return { ...details, token: canonicalHash({ details, scope, adoption: input.adoption, revision: input.expectedRevision }) };
  }
  async function payload(generation: PreparedGeneration) {
    const frozen = await readFrozenActivation(options.catalog, generation.pinId, generation.frozenHash);
    const output = outputsOf(frozen);
    if (canonicalHash(output.files.map(({ bytes: _bytes, ...file }) => file)) !== canonicalHash(generation.files)
      || canonicalHash(output.skillNames) !== canonicalHash(generation.skillNames)
      || byteHash(frozen.instructions!) !== generation.instructionHash) fail('activation_corrupt');
    return output;
  }
  async function finishTransaction(state: ActivationReceipt): Promise<void> {
    if (!state.pending) return;
    if (!state.pending.to || !state.generations[state.pending.to]) fail('activation_corrupt');
    const generation = state.generations[state.pending.to];
    const output = await payload(generation);
    await stageOutputs(generationsPath(state.agentId), generation, output.files, options.afterFile, options.beforeWrite);
    generation.materializedAt = now(); state.materialized = generation.id;
    delete state.pending; state.revision++; await save(state);
  }
  return {
    read, preview,
    adopt(input: AdoptionRequest & { previewToken: string }): Promise<ActivationReceipt> {
      return audit(input.agentId, 'desired', () => serial(input.agentId, async () => {
        if (launches.has(key(input.agentId)) || uncertainRuntimes.has(key(input.agentId))) fail('activation_busy');
        const delivery = await preview(input);
        if (delivery.token !== input.previewToken) fail('activation_stale');
        const old = await read(input.agentId);
        if (old?.pending) fail('activation_busy');
        const scope = await resolveActivationScope(input.workspace);
        const pinId = `activation-pin-${randomUUID()}`;
        const { frozen, hash } = await prepareFrozenActivation(options.catalog, {
          agentId: input.agentId, projectId: input.projectId, adoption: input.adoption,
          expectedFingerprint: delivery.compositionFingerprint, pinId,
        });
        const output = outputsOf(frozen);
        const id = `generation-${randomUUID()}`;
        const prepared: PreparedGeneration = {
          id, pinId, frozenHash: hash, adoption: input.adoption, capability: input.capability,
          compositionRevision: frozen.plan.compositionRevision, planFingerprint: frozen.plan.fingerprint,
          instructionHash: byteHash(frozen.instructions!), preparedAt: now(),
          files: output.files.map(({ bytes: _bytes, ...file }) => file), skillRoots: output.skillRoots,
          skillNames: output.skillNames, runs: [],
        };
        const state: ActivationReceipt = old ?? { version: 1, agentId: input.agentId, revision: 0, scope, desired: null, materialized: null, generations: {} };
        state.generations[id] = prepared; state.desired = id; state.revision++;
        await save(state); return state;
      }));
    },
    /** Drops only future references. Retains generations/pins/history and touches no repo or runtime. */
    unassign(agentId: string, expectedRevision: number): Promise<ActivationReceipt> {
      return audit(agentId, 'unassigned', () => serial(agentId, async () => {
        if (launches.has(key(agentId)) || uncertainRuntimes.has(key(agentId))) fail('activation_busy');
        const state = await read(agentId);
        if (!state || state.revision !== expectedRevision) fail('activation_stale');
        state.desired = null; delete state.pending; state.revision++; await save(state); return state;
      }));
    },
    async launch<T>(agentId: string, workspace: () => Promise<WorkspaceRequest>, isRunning: () => boolean,
      run: (lease: ManagedLaunchLease | null) => Promise<T>): Promise<T> {
      const existing = await read(agentId);
      if (existing && isRunning()) fail('activation_busy');
      if (!existing?.desired) return run(null);
      const launchKey = key(agentId);
      if (launches.has(launchKey) || uncertainRuntimes.has(launchKey)) fail('activation_busy');
      launches.add(launchKey);
      try {
        const lease = await serial(agentId, async (): Promise<ManagedLaunchLease> => {
          if (isRunning()) fail('activation_busy');
          const state = (await read(agentId))!;
          const scope = await resolveActivationScope(await workspace());
          if (canonicalHash(scope) !== canonicalHash(state.scope)) fail('activation_scope_changed');
          await uniqueWorkspace(agentId, scope);
          if (Object.values(state.generations).some((item) => item.runs.some((attempt) => !attempt.endedAt))) fail('activation_runtime_unreconciled');
          const generation = state.generations[state.desired!];
          await assertDeliveryCapability(generation.capability, generation.capability.identity.path, platform);
          const output = await payload(generation);
          if (state.pending) await finishTransaction(state);
          const root = path.join(generationsPath(agentId), generation.id);
          if (!generation.materializedAt) {
            state.pending = { from: state.materialized, to: generation.id }; state.revision++; await save(state);
            await finishTransaction(state);
          }
          await verifyOutputs(root, generation);
          const attemptId = `attempt-${randomUUID()}`;
          let ended = false;
          return {
            attemptId,
            binary: generation.capability.identity.path,
            instructionFile: path.join(root, 'instructions.txt'),
            ...(output.skillNames.length ? { pluginDir: path.join(root, 'plugin') } : {}),
            assertCanCreate: () => {
              if (!launches.has(launchKey) || uncertainRuntimes.has(launchKey) || isRunning()) fail('activation_busy');
              assertDeliveryCapabilitySync(generation.capability, generation.capability.identity.path);
            },
            beforeStart: async (binary) => {
              await assertDeliveryCapability(generation.capability, binary, platform);
              if (isRunning()) fail('activation_busy');
              await verifyOutputs(root, generation);
              await serial(agentId, async () => {
                const latest = (await read(agentId))!;
                latest.generations[generation.id].runs.push({ attemptId, intendedAt: now() });
                latest.revision++; await save(latest);
              });
            },
            started: async (runtimeIdentity) => {
              try {
                await serial(agentId, async () => {
                  const latest = (await read(agentId))!;
                  const attempt = latest.generations[generation.id].runs.find((item) => item.attemptId === attemptId);
                  if (!attempt) fail('activation_corrupt');
                  attempt.runtimeIdentity = runtimeIdentity; attempt.startedAt = now(); attempt.outcome = 'pty_process_created';
                  if (ended) attempt.endedAt = now(); latest.revision++; await save(latest);
                });
              } catch {
                // telemetry-exempt: process creation succeeded; preserve its runtime identity even if persistence fails.
                const error = new ProcessStartedReceiptError(attemptId, runtimeIdentity);
                uncertainRuntimes.set(launchKey, error); throw error;
              }
            },
            notCreated: () => serial(agentId, async () => {
              const latest = (await read(agentId))!;
              const attempt = latest.generations[generation.id].runs.find((item) => item.attemptId === attemptId);
              if (attempt) { attempt.outcome = 'process_not_created'; attempt.endedAt = now(); latest.revision++; await save(latest); }
            }),
            cleanup: async (error, confirmed) => {
              error.cleanupConfirmed = confirmed;
              if (confirmed) uncertainRuntimes.delete(launchKey);
              else uncertainRuntimes.set(launchKey, error);
              try {
                await serial(agentId, async () => {
                  const latest = (await read(agentId))!;
                  const attempt = latest.generations[generation.id].runs.find((item) => item.attemptId === attemptId)!;
                  attempt.runtimeIdentity = error.runtimeIdentity; attempt.startedAt ??= now(); attempt.outcome = 'process_started_receipt_failed';
                  attempt.cleanupRequested = error.cleanupRequested; attempt.cleanupConfirmed = confirmed;
                  attempt.cleanupFailure = error.cleanupFailure;
                  if (confirmed) attempt.endedAt = now(); latest.revision++; await save(latest);
                });
              } catch {
                // telemetry-exempt: durable intent and in-memory runtime identity remain; report the original persistence failure.
              }
            },
            exited: async () => {
              ended = true; uncertainRuntimes.delete(launchKey);
              await serial(agentId, async () => {
                const latest = await read(agentId);
                const receipt = latest?.generations[generation.id]?.runs.find((item) => item.attemptId === attemptId);
                if (!latest || !receipt) return;
                receipt.endedAt = now(); if (receipt.cleanupRequested) receipt.cleanupConfirmed = true;
                latest.revision++; await save(latest);
              });
            },
          };
        });
        return await run(lease);
      } finally { launches.delete(launchKey); }
    },
  };
}
