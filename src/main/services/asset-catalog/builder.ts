import { randomUUID } from 'crypto';
import type { BaseAdoption, CatalogIndex, CompositionInput, InstanceEntry, SkillAssetPayload } from '../../../shared/asset-catalog-types';
import type { BuilderCommand, BuilderView } from '../../../shared/agent-builder-types';
import { emptyComposition } from './planner';
import { BUILDER_TEMPLATES } from './builder-seeds';
import { AssetCatalogError, type AssetCatalogStore } from './store';

const inputOf = (value: CompositionInput): CompositionInput => Object.fromEntries(Object.keys(emptyComposition()).map((key) => [key, value[key as keyof CompositionInput]])) as unknown as CompositionInput;
const keyOf = (entry: InstanceEntry) => entry.baseEntryId ? `base:${entry.baseEntryId}` : `local:${entry.localId}`;

/** This slice cannot interpret native/MCP composition or create its snapshot policy. */
export class BuilderUnsupportedCompositionError extends Error {
  readonly code = 'unsupported';
}
function assertBuilderSupported(index: CatalogIndex, composition: CompositionInput): void {
  const template = composition.template && index.assets[composition.template.templateId]?.revisions
    .find((r) => r.revision === composition.template!.acceptedRevision)?.projection;
  // Refuse even excluded base references: this editor has no review/restore flow
  // for those asset types. Never inspect native payloads or synthesize their holds.
  if (composition.subagents.length || (template?.kind === 'template' && (template.subagents.length || template.mcps.length))
    || [...composition.additions, ...composition.removals].some((id) => index.assets[id]?.kind === 'mcp')) {
    throw new BuilderUnsupportedCompositionError();
  }
}

/** Snapshot for this saved-only editor, not an adoption policy for activation.
 * Keep accepted template text pinned. Agent-owned text uses its saved head.
 * Every planner/commit still receives adoption explicitly; runtime policy is undecided.
 */
export async function builderSnapshotAdoption(store: AssetCatalogStore, composition: CompositionInput): Promise<BaseAdoption> {
  const index = await store.read();
  assertBuilderSupported(index, composition);
  const revisions: Record<string, number> = { ...composition.floors };
  if (composition.template) {
    const template = index.assets[composition.template.templateId];
    const projection = template?.revisions.find((r) => r.revision === composition.template!.acceptedRevision)?.projection;
    if (projection?.kind !== 'template') throw new AssetCatalogError('invalid_composition');
    for (const id of projection.skills) revisions[id] = composition.floors[id] ?? index.assets[id]?.headRevision;
    for (const ref of projection.entries) revisions[ref.blockId] = Math.max(revisions[ref.blockId] ?? 0, ref.blockRevision);
  }
  for (const id of composition.additions) {
    if (index.assets[id]?.kind === 'skill') revisions[id] = composition.floors[id] ?? index.assets[id].headRevision;
  }
  for (const entry of composition.entries) {
    if (entry.source.blockId) revisions[entry.source.blockId] = index.assets[entry.source.blockId]?.headRevision;
  }
  return { content: { mode: 'hold', revisions }, structure: { mode: 'accepted' } };
}

export function createAgentBuilder(store: AssetCatalogStore, projectId?: string) {
  async function compositionOf(agentId: string) {
    return inputOf((await store.read()).compositions[agentId] ?? emptyComposition());
  }
  async function read(agentId: string, adoption: BaseAdoption, draft?: CompositionInput): Promise<BuilderView> {
    const composition = draft ?? await compositionOf(agentId);
    const index = await store.read();
    assertBuilderSupported(index, composition);
    const { plan, blocks: resolvedBlocks, composed } = await store.previewInstructions({ agentId, adoption, draft: composition, ...(projectId && { projectId }) });
    if (plan.blockers.length) throw new AssetCatalogError('composition_blocked');
    const blocks = resolvedBlocks.map((block) => {
      const entry = composition.entries.find((e) => keyOf(e) === block.entryKey)!;
      const from = entry.source.kind === 'fork' ? entry.source.forkedFrom : null;
      return {
        key: block.entryKey, entry, assetId: block.assetId, revision: block.revision,
        name: block.name, content: block.text,
        source: from ? `Fork of ${index.assets[from.assetId]?.name ?? 'missing block'} at revision ${from.revision}`
          : entry.source.kind === 'local' ? "This agent's" : entry.baseEntryId ? 'Inherited from template' : 'Shared block reference',
        editable: entry.source.kind !== 'follow',
      };
    });
    if (!composed.ok) throw new AssetCatalogError('composition_blocked');
    return {
      revision: plan.compositionRevision, templateId: composition.template?.templateId ?? null,
      templates: BUILDER_TEMPLATES.map((t) => ({ id: `builtin-builder-${t.id}`, name: t.name })),
      skills: await Promise.all(plan.skills.map(async (skill) => ({ ...skill, payload: await store.readRevision(skill.assetId, skill.revision) as SkillAssetPayload }))),
      excludedSkills: plan.excluded.filter((item) => item.kind === 'skill').map(({ assetId }) => ({ assetId, name: index.assets[assetId]?.name ?? 'Unavailable skill' })),
      blocks, customOrder: plan.structure?.customOrder ?? false, text: composed.text,
    };
  }
  async function command(agentId: string, expectedRevision: number, action: BuilderCommand, adoption: BaseAdoption): Promise<BuilderView> {
    const index = await store.read();
    if ((index.compositions[agentId]?.revision ?? 0) !== expectedRevision) throw new AssetCatalogError('stale_revision');
    const composition: CompositionInput = structuredClone(inputOf(index.compositions[agentId] ?? emptyComposition()));
    assertBuilderSupported(index, composition);
    if (action.type === 'template') {
      if (!BUILDER_TEMPLATES.some((t) => `builtin-builder-${t.id}` === action.templateId)) throw new AssetCatalogError('invalid_composition');
      // Replace with a preview. This slice carries nothing to another template.
      const template = index.assets[action.templateId];
      const projection = template?.revisions.find((r) => r.revision === template.headRevision)?.projection;
      if (projection?.kind !== 'template') throw new AssetCatalogError('invalid_composition');
      const targetAdoption = await builderSnapshotAdoption(store, {
        ...emptyComposition(), template: { templateId: template.id, acceptedRevision: template.headRevision },
        entries: projection.entries.map((ref) => ({ baseEntryId: ref.entryId, source: { kind: 'follow' } })),
      });
      targetAdoption.structure = adoption.structure;
      const preview = await store.previewTemplateSwitch({ agentId, templateId: action.templateId, selection: {}, adoption: targetAdoption, ...(projectId && { projectId }) });
      if (!action.confirm) return {
        ...await read(agentId, targetAdoption, preview.composition), templateBinding: preview.binding,
        operationalIncreases: preview.plan.operationalDefaults
          .filter((item) => preview.operationalIncreases.includes(item.key))
          .map(({ key, value }) => ({ key, value })),
      };
      if (preview.operationalIncreases.length > 0 && action.acknowledgeOperationalIncreases !== true) throw new AssetCatalogError('structure_needs_choice');
      if (!action.binding) throw new AssetCatalogError('stale_choice');
      await store.switchTemplate({ agentId, expectedRevision, templateId: action.templateId, selection: {}, binding: action.binding, adoption: targetAdoption, ...(projectId && { projectId }) });
      return read(agentId, targetAdoption);
    }
    if (action.type === 'skill' || action.type === 'removeSkill') {
      const asset = index.assets[action.assetId];
      if (!asset || asset.kind !== 'skill' || asset.deletedAt
        || (asset.owner.kind === 'agent' && asset.owner.agentId !== agentId)
        || (asset.owner.kind === 'project' && asset.owner.projectId !== projectId)) throw new AssetCatalogError('invalid_composition');
      const template = composition.template && index.assets[composition.template.templateId]?.revisions.find((r) => r.revision === composition.template!.acceptedRevision)?.projection;
      const inBase = template && template.kind === 'template' && template.skills.includes(asset.id);
      if (action.type === 'skill') {
        if (asset.headRevision !== action.expectedRevision) throw new AssetCatalogError('stale_revision');
        if (!inBase && !composition.additions.includes(asset.id)) composition.additions.push(asset.id);
        composition.removals = composition.removals.filter((id) => id !== asset.id);
        composition.floors[asset.id] = action.expectedRevision;
      } else {
        if (!composition.additions.includes(asset.id) && !inBase) throw new AssetCatalogError('invalid_composition');
        composition.additions = composition.additions.filter((id) => id !== asset.id);
        if (inBase && !composition.removals.includes(asset.id)) composition.removals.push(asset.id);
      }
      const nextAdoption = await builderSnapshotAdoption(store, composition);
      const plan = await store.plan({ agentId, adoption: nextAdoption, draft: composition, ...(projectId && { projectId }) });
      const preview = await read(agentId, nextAdoption, composition);
      if (!action.confirm) return { ...preview, skillFingerprint: plan.fingerprint };
      if (!action.fingerprint || action.fingerprint !== plan.fingerprint) throw new AssetCatalogError('stale_preview');
      await store.saveComposition({ agentId, expectedRevision, composition, adoption: nextAdoption,
        previewFingerprint: action.fingerprint, ...(action.type === 'skill' && { expectedAssetRevisions: { [asset.id]: action.expectedRevision } }),
        ...(projectId && { projectId }) });
      return read(agentId, nextAdoption);
    }
    const before = await read(agentId, adoption, composition);
    if (action.type === 'order') {
      if (action.keys.length !== composition.entries.length || new Set(action.keys).size !== action.keys.length) throw new AssetCatalogError('invalid_composition');
      composition.entries = action.keys.map((key) => {
        const entry = composition.entries.find((e) => keyOf(e) === key);
        if (!entry) throw new AssetCatalogError('invalid_composition');
        return entry;
      });
    } else if (action.type === 'baseOrder') {
      const projection = composition.template && index.assets[composition.template.templateId]?.revisions.find((r) => r.revision === composition.template!.acceptedRevision)?.projection;
      if (!projection || projection.kind !== 'template') throw new AssetCatalogError('invalid_composition');
      // Preserve local blocks, placed after the base. This only resets order.
      composition.entries = [
        ...projection.entries.flatMap((ref) => composition.entries.filter((e) => e.baseEntryId === ref.entryId)),
        ...composition.entries.filter((e) => e.localId),
      ];
    } else if (action.type === 'append') {
      const asset = await store.createAsset({ kind: 'block', name: action.name, owner: { kind: 'agent', agentId }, payload: { content: action.content } });
      composition.entries.push({ localId: randomUUID(), source: { kind: 'local', blockId: asset.id } });
    } else {
      const position = composition.entries.findIndex((e) => keyOf(e) === action.key);
      const block = before.blocks[position];
      const entry = composition.entries[position];
      if (!entry || !block) throw new AssetCatalogError('invalid_composition');
      if (action.type === 'fork') {
        if (entry.source.kind !== 'follow') throw new AssetCatalogError('invalid_composition');
        const copy = await store.copyAsset({ assetId: block.assetId, revision: block.revision, agentId });
        entry.source = { kind: 'fork', blockId: copy.id, forkedFrom: { assetId: block.assetId, revision: block.revision } };
      } else if (action.type === 'return') {
        if (entry.source.kind !== 'fork') throw new AssetCatalogError('invalid_composition');
        const origin = entry.source.forkedFrom;
        entry.source = entry.baseEntryId ? { kind: 'follow' } : { kind: 'follow', blockId: origin.assetId };
        if (!entry.baseEntryId) composition.floors[origin.assetId] = Math.max(composition.floors[origin.assetId] ?? 0, origin.revision);
      } else if (action.type === 'remove') {
        if (entry.source.kind !== 'local') throw new AssetCatalogError('invalid_composition');
        composition.entries.splice(position, 1);
      } else if (action.type === 'edit') {
        if (!block.editable) throw new AssetCatalogError('invalid_composition');
        // New immutable payload first, then one composition commit. A failed
        // commit leaves the previous text intact, with only an unassigned asset.
        const replacement = entry.source.kind === 'fork'
          ? await store.copyAsset({ assetId: entry.source.forkedFrom.assetId, revision: entry.source.forkedFrom.revision, agentId })
          : await store.createAsset({ kind: 'block', name: block.name, owner: { kind: 'agent', agentId }, payload: { content: action.content } });
        if (entry.source.kind === 'fork') await store.saveRevision({ assetId: replacement.id, expectedRevision: 1, payload: { content: action.content } });
        entry.source.blockId = replacement.id;
      }
    }
    const nextAdoption = await builderSnapshotAdoption(store, composition);
    const plan = await store.plan({ agentId, adoption: nextAdoption, draft: composition, ...(projectId && { projectId }) });
    await store.saveComposition({ agentId, expectedRevision, composition, adoption: nextAdoption, previewFingerprint: plan.fingerprint, ...(projectId && { projectId }) });
    return read(agentId, nextAdoption);
  }
  return { read, command, compositionOf };
}
