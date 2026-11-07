import { randomUUID } from 'node:crypto';
import type { NewAgentCompositionPreview } from '../../shared/new-agent-composition';
import type { StartDurableCreationParams } from '../../shared/types';
import { reserveDurableCreationId, releaseDurableCreationId, type DurableCreationIdReservation } from './agent-config';
import { builderSnapshotAdoption } from './asset-catalog/builder';
import { BUILDER_TEMPLATES } from './asset-catalog/builder-seeds';
import { emptyComposition } from './asset-catalog/planner';
import { assetCatalogDir, createAssetCatalogStore } from './asset-catalog/store';
import { peekProjects, projectRegistryMutationState } from './project-store';
import { currentSettingsOrigin } from './settings-audit';
import { creationCompositionCommit, type ReviewedCreationComposition } from './new-agent-composition-catalog';
import type { StartDurableCreationOptions } from './agent-creation';

interface Draft {
  sender: number;
  projectPath: string;
  reservation: DurableCreationIdReservation;
  reviewed: ReviewedCreationComposition;
  assertProject: () => void;
}
const drafts = new Map<string, Draft>();
const requests = new Map<number, number>();
function assertUser(): void {
  const origin = currentSettingsOrigin();
  if (origin.surface !== 'ui' || origin.actorId) throw new Error('New agent composition requires the local user.');
}
function discard(token: string): void {
  const draft = drafts.get(token);
  if (draft) releaseDurableCreationId(draft.reservation);
  drafts.delete(token);
}
function expire(): void {
  for (const [token, draft] of drafts) if (draft.reservation.expiresAt <= Date.now()) discard(token);
}
export function discardNewAgentComposition(sender: number, token: string): void {
  assertUser();
  if (drafts.get(token)?.sender === sender) discard(token);
}

/** Preview is read-only after startup seeding; no provisional catalog asset is created. */
export async function previewNewAgentComposition(
  sender: number, projectId: string, templateId: string, skillIds: string[], blockIds: string[] = [],
): Promise<NewAgentCompositionPreview> {
  assertUser(); expire();
  const request = (requests.get(sender) ?? 0) + 1;
  requests.set(sender, request);
  for (const [token, draft] of drafts) if (draft.sender === sender) discard(token);
  if (!BUILDER_TEMPLATES.some((t) => `builtin-builder-${t.id}` === templateId)) throw new Error('Unknown Builder base.');
  const registry = projectRegistryMutationState();
  if (registry.pending) throw new Error('Project registration is changing.');
  const project = (await peekProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error('Project is no longer registered.');
  const assertProject = () => {
    const current = projectRegistryMutationState();
    if (current.pending || current.generation !== registry.generation) throw new Error('Project registration changed. Preview again.');
  };
  assertProject();
  const reservation = reserveDurableCreationId(project.path);
  try {
    const store = createAssetCatalogStore({ dir: assetCatalogDir() });
    const index = await store.read();
    const template = index.assets[templateId];
    const projection = template?.revisions.find((r) => r.revision === template.headRevision)?.projection;
    if (!template || projection?.kind !== 'template') throw new Error('Builder base is unavailable.');
    const available = Object.values(index.assets).filter((asset) => !asset.deletedAt && asset.kind === 'skill'
      && (asset.owner.kind === 'library' || (asset.owner.kind === 'project' && asset.owner.projectId === projectId)));
    const availableBlocks = Object.values(index.assets).filter((asset) => !asset.deletedAt && asset.kind === 'block'
      && (asset.owner.kind === 'library' || (asset.owner.kind === 'project' && asset.owner.projectId === projectId)));
    if (blockIds.length > 256 || new Set(blockIds).size !== blockIds.length
      || blockIds.some((id) => !availableBlocks.some((asset) => asset.id === id))) throw new Error('Selected block is unavailable.');
    const unique = [...new Set(skillIds)];
    if (unique.length !== skillIds.length || unique.some((id) => !available.some((a) => a.id === id))) throw new Error('Selected skill is unavailable.');
    const composition = {
      ...emptyComposition(), template: { templateId, acceptedRevision: template.headRevision },
      entries: [
        ...projection.entries.map((ref) => ({ baseEntryId: ref.entryId, source: { kind: 'follow' as const } })),
        ...blockIds.map((blockId) => ({ localId: randomUUID(), source: { kind: 'follow' as const, blockId } })),
      ],
      // Direct shared references require an explicit accepted floor; template
      // entries derive theirs from the accepted template revision instead.
      floors: Object.fromEntries(blockIds.map((id) => [id, index.assets[id].headRevision])),
      additions: unique,
    };
    const adoption = await builderSnapshotAdoption(store, composition);
    const preview = await store.previewInstructions({ agentId: reservation.agentId, projectId, draft: composition, adoption });
    if (preview.plan.blockers.length || !preview.composed.ok) throw new Error('Composition cannot be saved.');
    // Changes in any reviewed template/block/skill head require explicit re-preview.
    const sourceRevisions: Record<string, number> = { [templateId]: template.headRevision };
    for (const block of preview.blocks) sourceRevisions[block.assetId] = index.assets[block.assetId].headRevision;
    for (const skill of preview.plan.skills) sourceRevisions[skill.assetId] = index.assets[skill.assetId].headRevision;
    assertProject();
    if (reservation.expiresAt <= Date.now() || requests.get(sender) !== request) throw new Error('New agent preview expired.');
    const token = randomUUID();
    drafts.set(token, { sender, projectPath: project.path, reservation, assertProject, reviewed: {
      agentId: reservation.agentId, projectId, composition, adoption,
      previewFingerprint: preview.plan.fingerprint, sourceRevisions,
    } });
    return {
      token, expiresAt: reservation.expiresAt, text: preview.composed.text,
      skills: preview.plan.skills.map((skill) => ({ id: skill.assetId, name: index.assets[skill.assetId].name, revision: skill.revision })),
      availableBlocks: availableBlocks.map((asset) => ({ id: asset.id, name: asset.name })),
      availableSkills: available.map((asset) => ({ id: asset.id, name: asset.name })),
    };
  } catch (error) { releaseDurableCreationId(reservation); throw error; }
}

/** Consume once; failure requires a new preview, not replay of an old approval. */
export function consumeNewAgentComposition(
  sender: number, token: string, projectPath: string, params: StartDurableCreationParams,
): { options: StartDurableCreationOptions; release: () => void } {
  assertUser(); expire();
  const draft = drafts.get(token);
  if (!draft || draft.sender !== sender || draft.projectPath !== projectPath) throw new Error('New agent preview expired or target changed.');
  drafts.delete(token);
  try {
    draft.assertProject();
    if (params.persona || params.parentAgentId || params.mcpIds?.length || Object.keys(params.mcpConfigs ?? {}).length) {
      throw new Error('Builder creation cannot combine legacy persona, helper or MCP configuration.');
    }
    return { options: {
      idReservation: draft.reservation,
      commitComposition: creationCompositionCommit(draft.reviewed, draft.assertProject),
    }, release: () => releaseDurableCreationId(draft.reservation) };
  } catch (error) { releaseDurableCreationId(draft.reservation); throw error; }
}
