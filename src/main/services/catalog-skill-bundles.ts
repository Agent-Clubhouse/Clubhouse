import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import type { CatalogEntry, SkillAssetPayload } from '../../shared/asset-catalog-types';
import type { SkillBundleContext, SkillBundleDocument, SkillBundleEditorBridge, SkillBundleErrorCode, SkillBundleSummary } from '../../shared/skill-bundle-editor-types';
import { AssetCatalogError, assetCatalogDir, createAssetCatalogStore, type AssetCatalogStore } from './asset-catalog/store';
import { currentSettingsOrigin } from './settings-audit';
import { peekProjects, projectRegistryMutationState } from './project-store';
import { peekDurableConfigs, agentConfigGeneration } from './agent-config';
import { withAgentTransition } from './agent-transition';
import { isDispatcherPath } from './dispatcher/dispatcher-paths';

class BundleError extends Error {
  constructor(readonly code: SkillBundleErrorCode) { super(code); }
}
const refuse = (code: SkillBundleErrorCode): never => { throw new BundleError(code); };

/** Resolve IDs in main. The guard is synchronous and runs at each catalog rename. */
async function registeredContext(context: SkillBundleContext): Promise<() => void> {
  const before = projectRegistryMutationState();
  if (before.pending) refuse('target_changed');
  const project = (await peekProjects()).find((p) => p.id === context.projectId);
  if (!project || isDispatcherPath(project.path)) refuse('target_changed');
  const configGeneration = agentConfigGeneration();
  if (context.agentId) {
    const agent = (await peekDurableConfigs(project.path)).find((a) => a.id === context.agentId);
    if (!agent || agent.creation || agent.disposedAt || agent.parentAgentId) refuse('target_changed');
  }
  const guard = () => {
    const current = projectRegistryMutationState();
    if (current.pending || current.generation !== before.generation
      || (context.agentId && agentConfigGeneration() !== configGeneration)) refuse('target_changed');
  };
  guard();
  return guard;
}

function visible(entry: CatalogEntry, context: SkillBundleContext): boolean {
  return entry.kind === 'skill' && !entry.deletedAt && (entry.owner.kind === 'library'
    || (entry.owner.kind === 'project' && entry.owner.projectId === context.projectId)
    || (entry.owner.kind === 'agent' && !!context.agentId && entry.owner.agentId === context.agentId));
}
function summary(entry: CatalogEntry): SkillBundleSummary {
  return { assetId: entry.id, name: entry.name, revision: entry.headRevision, owner: entry.owner,
    source: entry.source, readOnly: entry.source.kind === 'builtin' };
}

/** Dependency injection is main-only; the preload receives just safe DTO operations. */
export function createCatalogSkillBundleEditor(options: {
  resolveContext?: typeof registeredContext;
  store?: (guard: () => void) => AssetCatalogStore;
  now?: () => number;
} = {}): SkillBundleEditorBridge {
  const resolveContext = options.resolveContext ?? registeredContext;
  const storeFor = options.store ?? ((guard) => createAssetCatalogStore({ dir: assetCatalogDir(),
    rename: async (from, to) => {
      // Same-app pending registry I/O is tracked before submission. No async gap
      // between this guard and rename; ordinary project writes cannot race commit.
      guard(); renameSync(from, to);
    },
  }));
  const now = options.now ?? Date.now;
  const previews = new Map<string, { request: Parameters<SkillBundleEditorBridge['preview']>[0]; fingerprint: string; expires: number; guard: () => void }>();
  async function perform<T>(context: SkillBundleContext, run: (store: AssetCatalogStore, guard: () => void) => Promise<T>) {
    try {
      const origin = currentSettingsOrigin();
      if (origin.surface !== 'ui' || origin.actorId) refuse('local_user_only');
      if (!context || typeof context.projectId !== 'string' || !context.projectId
        || (context.agentId !== undefined && (typeof context.agentId !== 'string' || !context.agentId))) refuse('invalid_request');
      const execute = async () => {
        const guard = await resolveContext(context);
        const value = await run(storeFor(guard), guard);
        guard();
        return { ok: true as const, value };
      };
      return context.agentId ? await withAgentTransition(context.agentId, execute) : await execute();
    } catch (error) {
      // telemetry-exempt: payloads, paths and raw parser/IPC errors never leave this boundary.
      const code: SkillBundleErrorCode = error instanceof BundleError ? error.code
        : error instanceof AssetCatalogError ? ({ builtin_read_only: 'read_only', stale_revision: 'stale_revision',
          stale_preview: 'stale_preview', invalid_payload: 'invalid_payload', consumer_conflict: 'shared_edit_blocked',
          impact_confirmation_required: 'shared_edit_blocked' } as Record<string, SkillBundleErrorCode>)[error.code] ?? 'save_failed'
          : 'save_failed';
      return { ok: false as const, code };
    }
  }
  async function entryFor(store: AssetCatalogStore, context: SkillBundleContext, assetId: string) {
    const entry = (await store.read()).assets[assetId];
    if (!entry || !visible(entry, context)) refuse('not_found');
    return entry;
  }
  async function document(store: AssetCatalogStore, entry: CatalogEntry): Promise<SkillBundleDocument> {
    return { ...summary(entry), payload: await store.readRevision(entry.id, entry.headRevision) as SkillAssetPayload };
  }
  return {
    list: (context) => perform(context, async (store) => Object.values((await store.read()).assets)
      .filter((entry) => visible(entry, context)).map(summary)),
    read: (context, assetId) => perform(context, async (store) => document(store, await entryFor(store, context, assetId))),
    preview: (request) => perform(request.context, async (store, guard) => {
      const entry = await entryFor(store, request.context, request.assetId);
      if (entry.source.kind === 'builtin') refuse('read_only');
      if (entry.headRevision !== request.expectedRevision) refuse('stale_revision');
      const payload = structuredClone(request.payload);
      const impact = await store.previewAssetEdit({ assetId: entry.id, payload });
      const blocked = impact.blocked || impact.agents.length > 0 || impact.templates.length > 0 || impact.subagents.length > 0;
      guard();
      // At most four complete bundles, for two minutes. Edits bind to exact bytes,
      // revision and registered context; a late or changed target must re-preview.
      for (const [key, value] of previews) if (value.expires <= now()) previews.delete(key);
      while (previews.size >= 4) previews.delete(previews.keys().next().value);
      const token = randomUUID();
      if (!blocked) previews.set(token, { request: { ...structuredClone(request), payload }, fingerprint: impact.fingerprint, expires: now() + 120_000, guard });
      return { token: blocked ? '' : token, impact, blocked };
    }),
    save: (request) => perform(request.context, async (store) => {
      const preview = previews.get(request.token);
      previews.delete(request.token);
      if (!preview || preview.expires <= now() || preview.request.assetId !== request.assetId
        || preview.request.expectedRevision !== request.expectedRevision
        || JSON.stringify(preview.request.context) !== JSON.stringify(request.context)) refuse('stale_preview');
      preview.guard();
      const entry = await entryFor(store, request.context, request.assetId);
      if (entry.source.kind === 'builtin') refuse('read_only');
      const impact = await store.previewAssetEdit({ assetId: entry.id, payload: preview.request.payload });
      if (impact.blocked || impact.agents.length || impact.templates.length || impact.subagents.length) refuse('shared_edit_blocked');
      if (impact.fingerprint !== preview.fingerprint) refuse('stale_preview');
      const saved = await store.saveRevision({ assetId: entry.id, expectedRevision: request.expectedRevision,
        payload: preview.request.payload, impactFingerprint: preview.fingerprint });
      return document(store, saved);
    }),
  };
}
