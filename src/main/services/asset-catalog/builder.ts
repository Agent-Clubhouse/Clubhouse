import { randomUUID } from 'crypto';
import type { BaseAdoption, CompositionInput, InstanceEntry } from '../../../shared/asset-catalog-types';
import type { BuilderCommand, BuilderView } from '../../../shared/agent-builder-types';
import { emptyComposition } from './planner';
import { BUILDER_TEMPLATES } from './builder-seeds';
import { AssetCatalogError, type AssetCatalogStore } from './store';

const inputOf = (value: CompositionInput): CompositionInput => Object.fromEntries(Object.keys(emptyComposition()).map((key) => [key, value[key as keyof CompositionInput]])) as unknown as CompositionInput;
const keyOf = (entry: InstanceEntry) => entry.baseEntryId ? `base:${entry.baseEntryId}` : `local:${entry.localId}`;

/** Snapshot for this saved-only editor, not an adoption policy for activation.
 * Keep accepted template text pinned. Agent-owned text uses its saved head.
 * Every planner/commit still receives adoption explicitly; runtime policy is undecided.
 */
export async function builderSnapshotAdoption(store: AssetCatalogStore, composition: CompositionInput): Promise<BaseAdoption> {
  const index = await store.read();
  const revisions: Record<string, number> = { ...composition.floors };
  if (composition.template) {
    const template = index.assets[composition.template.templateId];
    const projection = template?.revisions.find((r) => r.revision === composition.template!.acceptedRevision)?.projection;
    if (projection?.kind !== 'template') throw new AssetCatalogError('invalid_composition');
    for (const ref of projection.entries) revisions[ref.blockId] = Math.max(revisions[ref.blockId] ?? 0, ref.blockRevision);
  }
  for (const entry of composition.entries) {
    if (entry.source.blockId) revisions[entry.source.blockId] = index.assets[entry.source.blockId]?.headRevision;
  }
  return { content: { mode: 'hold', revisions }, structure: { mode: 'accepted' } };
}

export function createAgentBuilder(store: AssetCatalogStore) {
  async function compositionOf(agentId: string) {
    return inputOf((await store.read()).compositions[agentId] ?? emptyComposition());
  }
  async function read(agentId: string, adoption: BaseAdoption, draft?: CompositionInput): Promise<BuilderView> {
    const composition = draft ?? await compositionOf(agentId);
    const index = await store.read();
    const { plan, blocks: resolvedBlocks, composed } = await store.previewInstructions({ agentId, adoption, draft: composition });
    if (plan.blockers.length) throw new AssetCatalogError('composition_blocked');
    const blocks = resolvedBlocks.map((block) => {
      const entry = composition.entries.find((e) => keyOf(e) === block.entryKey)!;
      const from = entry.source.kind === 'fork' ? entry.source.forkedFrom : null;
      return {
        key: block.entryKey, entry, assetId: block.assetId, revision: block.revision,
        name: block.name, content: block.text,
        source: from ? `Fork of ${index.assets[from.assetId]?.name ?? 'missing block'} at revision ${from.revision}`
          : entry.source.kind === 'local' ? "This agent's" : 'Inherited from template',
        editable: entry.source.kind !== 'follow',
      };
    });
    if (!composed.ok) throw new AssetCatalogError('composition_blocked');
    return {
      revision: plan.compositionRevision, templateId: composition.template?.templateId ?? null,
      templates: BUILDER_TEMPLATES.map((t) => ({ id: `builtin-builder-${t.id}`, name: t.name })),
      blocks, customOrder: plan.structure?.customOrder ?? false, text: composed.text,
    };
  }
  async function command(agentId: string, expectedRevision: number, action: BuilderCommand, adoption: BaseAdoption): Promise<BuilderView> {
    const index = await store.read();
    if ((index.compositions[agentId]?.revision ?? 0) !== expectedRevision) throw new AssetCatalogError('stale_revision');
    const composition: CompositionInput = structuredClone(inputOf(index.compositions[agentId] ?? emptyComposition()));
    if (action.type === 'template') {
      if (!BUILDER_TEMPLATES.some((t) => `builtin-builder-${t.id}` === action.templateId)) throw new AssetCatalogError('invalid_composition');
      // Replace with a preview. This slice carries nothing to another template.
      const template = index.assets[action.templateId];
      const projection = template?.revisions.find((r) => r.revision === template.headRevision)?.projection;
      if (projection?.kind !== 'template') throw new AssetCatalogError('invalid_composition');
      const targetAdoption: BaseAdoption = { content: { mode: 'hold', revisions: Object.fromEntries(projection.entries.map((e) => [e.blockId, e.blockRevision])) }, structure: adoption.structure };
      const preview = await store.previewTemplateSwitch({ agentId, templateId: action.templateId, selection: {}, adoption: targetAdoption });
      if (!action.confirm) return {
        ...await read(agentId, targetAdoption, preview.composition), templateBinding: preview.binding,
        operationalIncreases: preview.plan.operationalDefaults
          .filter((item) => preview.operationalIncreases.includes(item.key))
          .map(({ key, value }) => ({ key, value })),
      };
      if (preview.operationalIncreases.length > 0 && action.acknowledgeOperationalIncreases !== true) throw new AssetCatalogError('structure_needs_choice');
      if (!action.binding) throw new AssetCatalogError('stale_choice');
      await store.switchTemplate({ agentId, expectedRevision, templateId: action.templateId, selection: {}, binding: action.binding, adoption: targetAdoption });
      return read(agentId, targetAdoption);
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
        if (entry.source.kind !== 'follow' || !entry.baseEntryId) throw new AssetCatalogError('invalid_composition');
        const copy = await store.copyAsset({ assetId: block.assetId, revision: block.revision, agentId });
        entry.source = { kind: 'fork', blockId: copy.id, forkedFrom: { assetId: block.assetId, revision: block.revision } };
      } else if (action.type === 'return') {
        if (entry.source.kind !== 'fork' || !entry.baseEntryId) throw new AssetCatalogError('invalid_composition');
        entry.source = { kind: 'follow' };
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
    const plan = await store.plan({ agentId, adoption: nextAdoption, draft: composition });
    await store.saveComposition({ agentId, expectedRevision, composition, adoption: nextAdoption, previewFingerprint: plan.fingerprint });
    return read(agentId, nextAdoption);
  }
  return { read, command, compositionOf };
}
