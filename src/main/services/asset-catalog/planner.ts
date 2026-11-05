/**
 * The composition planner (#2737): from a catalog index and an agent's desired
 * composition to exactly what that agent would get. Pure: no I/O, no clock, and
 * nothing is written, so asking never changes anything. Output order comes from
 * ids and keys and never from locale or insertion, so equal inputs give equal
 * plans and equal fingerprints.
 *
 * It blocks rather than chooses: there is no precedence between two assets, no
 * merge, no clamping. A deliberate override (removal, instruction replacement)
 * is what the user asked for, and shows as one.
 */

import { createHash } from 'crypto';
import type {
  ActivationAsset,
  AgentComposition,
  AgentConsumer,
  AssetConsumers,
  AssetImpact,
  AssetProjection,
  AssetRevisionRecord,
  BaseAdoption,
  BaseRevisionUpdate,
  CatalogEntry,
  CatalogIndex,
  ComposableAssetKind,
  CompositionInput,
  CompositionPlan,
  ConsumerRelation,
  CopyConsumer,
  ForeignDestination,
  ImpactContext,
  ImpactedAgent,
  OriginStatus,
  PlanIssue,
  PlanIssueCode,
  PlanNoticeCode,
  PlannedAsset,
  PlannedAssetChange,
  PlannedOperationalDefault,
  PlannedSource,
  PresetConsumer,
  PresetOperationalDefaults,
  ProjectedDestination,
  SharedDestination,
} from '../../../shared/asset-catalog-types';
import { collisionKey, hasOwn } from './validation';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** A value's hash, whatever order its keys were written in. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function emptyComposition(): CompositionInput {
  return { basePresetId: null, additions: [], removals: [], instructionAssetId: null };
}

function liveEntry(index: CatalogIndex, assetId: string): CatalogEntry | null {
  const entry = hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
  return entry && !entry.deletedAt ? entry : null;
}

function revisionOf(entry: CatalogEntry, revision: number): AssetRevisionRecord | null {
  return entry.revisions.find((record) => record.revision === revision) ?? null;
}

function headOf(entry: CatalogEntry): AssetRevisionRecord | null {
  return revisionOf(entry, entry.headRevision);
}

export function destinationOf(projection: AssetProjection): ProjectedDestination | null {
  switch (projection.kind) {
    case 'mcp': return { kind: 'mcp-server', key: `mcp/${projection.serverKey}` };
    case 'skill': return { kind: 'skill-directory', key: `skills/${projection.skillName}` };
    case 'instruction': return { kind: 'instruction-document', key: 'instructions/primary' };
    case 'preset': return null;
  }
}

/** Where a copy stands against its origin. Only ever reported: a copy is never changed by this. */
export function originStatusOf(index: CatalogIndex, entry: CatalogEntry): OriginStatus | undefined {
  if (entry.source.kind !== 'copy') return undefined;
  const { originAssetId, originRevision } = entry.source;
  const origin = liveEntry(index, originAssetId);
  return {
    originAssetId,
    originRevision,
    originHeadRevision: origin?.headRevision ?? null,
    newerRevisionAvailable: !!origin && origin.headRevision > originRevision,
    originDeleted: !origin,
  };
}

interface PlanRequest {
  agentId: string;
  /** The composition being previewed, or the stored one. */
  composition: CompositionInput;
  compositionRevision: number;
  /** Required, with no default: see {@link BaseAdoption}. */
  adoption: BaseAdoption;
  foreign?: readonly ForeignDestination[];
}

const OPERATIONAL_KEYS: ReadonlyArray<keyof PresetOperationalDefaults> = [
  'agentAccess', 'orchestrate', 'access', 'control', 'maxHelpers', 'crossProjectHelpers', 'connectToDispatcher', 'autoHelpers',
];

export function planComposition(index: CatalogIndex, request: PlanRequest): CompositionPlan {
  const { agentId, composition, compositionRevision, adoption } = request;
  if (adoption?.mode !== 'latest' && adoption?.mode !== 'hold') throw new TypeError('adoption_policy_required');

  const blockers: PlanIssue[] = [];
  const notices: PlanIssue<PlanNoticeCode>[] = [];
  const block = (code: PlanIssueCode, assetIds: string[], extra: Partial<PlanIssue> = {}): void => {
    blockers.push({ code, assetIds, ...extra });
  };
  const notice = (code: PlanNoticeCode, assetIds: string[]): void => {
    notices.push({ code, assetIds });
  };

  /** A live entry of one of these kinds that this agent may use, or null with the blocker recorded. */
  const usable = (assetId: string, kinds: readonly string[]): CatalogEntry | null => {
    const refuse = (code: PlanIssueCode): null => {
      block(code, [assetId]);
      return null;
    };
    if (!hasOwn(index.assets, assetId)) return refuse('asset_missing');
    const entry = index.assets[assetId];
    if (entry.deletedAt) return refuse('asset_deleted');
    if (!kinds.includes(entry.kind)) return refuse('wrong_kind');
    if (entry.owner.kind === 'agent' && entry.owner.agentId !== agentId) return refuse('owner_mismatch');
    return entry;
  };

  /** Base content resolves through the adoption policy. */
  const baseRevision = (entry: CatalogEntry): AssetRevisionRecord | null => {
    if (adoption.mode === 'latest') return headOf(entry);
    const held = hasOwn(adoption.revisions, entry.id) ? adoption.revisions[entry.id] : undefined;
    if (held === undefined) {
      block('hold_incomplete', [entry.id]);
      return null;
    }
    const record = revisionOf(entry, held);
    if (!record) block('revision_unavailable', [entry.id]);
    return record;
  };

  const planned = new Map<string, PlannedAsset>();
  const updates: BaseRevisionUpdate[] = [];

  const contribute = (entry: CatalogEntry, record: AssetRevisionRecord, source: PlannedSource): void => {
    const destination = destinationOf(record.projection);
    if (!destination) return;
    const existing = planned.get(entry.id);
    if (existing) {
      // One asset through two routes is one asset, unless the routes disagree on its revision.
      if (existing.revision !== record.revision) block('conflicting_revisions', [entry.id]);
      existing.provenance.push(source);
      return;
    }
    const origin = originStatusOf(index, entry);
    planned.set(entry.id, {
      assetId: entry.id,
      kind: entry.kind as ComposableAssetKind,
      name: entry.name,
      revision: record.revision,
      headRevision: entry.headRevision,
      contentHash: record.contentHash,
      owner: entry.owner,
      source: entry.source,
      provenance: [source],
      destination,
      projection: record.projection,
      ...(origin && { origin }),
    });
    if (origin?.originDeleted) notice('origin_deleted', [entry.id]);
    else if (origin?.newerRevisionAvailable) notice('origin_newer_revision', [entry.id]);
  };

  const noteUpdate = (entry: CatalogEntry, record: AssetRevisionRecord): void => {
    if (record.revision >= entry.headRevision) return;
    updates.push({ assetId: entry.id, kind: entry.kind, resolvedRevision: record.revision, headRevision: entry.headRevision });
    notice('base_revision_available', [entry.id]);
  };

  // The base.
  let base = null as CompositionPlan['base'];
  let baseInstruction = null as CompositionPlan['replacedInstruction'];
  let operationalDefaults: PlannedOperationalDefault[] = [];
  const baseExclusions: CompositionPlan['excluded'] = [];
  const baseRefs = new Set<string>();
  const removals = new Set(composition.removals);
  const additions = new Set(composition.additions);

  if (composition.basePresetId !== null) {
    const preset = usable(composition.basePresetId, ['preset']);
    const presetRecord = preset && baseRevision(preset);
    if (preset && presetRecord?.projection.kind === 'preset') {
      const { projection } = presetRecord;
      noteUpdate(preset, presetRecord);
      const via: PlannedSource = { via: 'base', presetId: preset.id, presetRevision: presetRecord.revision };
      const defaults = projection.operationalDefaults ?? {};
      operationalDefaults = OPERATIONAL_KEYS.flatMap((key): PlannedOperationalDefault[] => {
        const value = defaults[key];
        return value === undefined ? [] : [{ key, value, presetId: preset.id, presetRevision: presetRecord.revision }];
      });

      // The instruction first. A replacement takes it over whole, so the base's own can't block or update anything.
      if (composition.instructionAssetId !== null && composition.instructionAssetId !== projection.instruction) {
        const held = adoption.mode === 'hold' && hasOwn(adoption.revisions, projection.instruction) ? adoption.revisions[projection.instruction] : undefined;
        const replaced = hasOwn(index.assets, projection.instruction) ? index.assets[projection.instruction] : null;
        baseInstruction = { assetId: projection.instruction, revision: held ?? replaced?.headRevision ?? 0 };
      } else {
        const instructionEntry = usable(projection.instruction, ['instruction']);
        const instructionRecord = instructionEntry && baseRevision(instructionEntry);
        if (instructionEntry && instructionRecord) {
          noteUpdate(instructionEntry, instructionRecord);
          contribute(instructionEntry, instructionRecord, via);
        }
      }

      const refs: Array<[string, ComposableAssetKind]> = [
        ...projection.skills.map((id): [string, ComposableAssetKind] => [id, 'skill']),
        ...projection.mcps.map((id): [string, ComposableAssetKind] => [id, 'mcp']),
      ];
      for (const [assetId, kind] of refs) {
        baseRefs.add(assetId);
        if (removals.has(assetId)) {
          baseExclusions.push({ assetId, kind, presetId: preset.id });
          continue;
        }
        const entry = usable(assetId, [kind]);
        const record = entry && baseRevision(entry);
        if (entry && record) {
          noteUpdate(entry, record);
          contribute(entry, record, via);
        }
      }
      base = {
        presetId: preset.id,
        name: preset.name,
        revision: presetRecord.revision,
        headRevision: preset.headRevision,
        updates,
      };
    }
  }

  // Explicit additions and the instruction replacement follow the latest approved revision.
  for (const assetId of composition.additions) {
    if (removals.has(assetId)) block('contradictory_override', [assetId]);
    if (!hasOwn(index.assets, assetId)) {
      block('asset_missing', [assetId]);
      continue;
    }
    if (index.assets[assetId].kind !== 'skill' && index.assets[assetId].kind !== 'mcp') {
      block('invalid_addition_kind', [assetId]);
      continue;
    }
    const entry = usable(assetId, ['skill', 'mcp']);
    const record = entry && headOf(entry);
    if (entry && record) contribute(entry, record, { via: 'addition' });
  }
  if (composition.instructionAssetId !== null) {
    const entry = usable(composition.instructionAssetId, ['instruction']);
    const record = entry && headOf(entry);
    if (entry && record) contribute(entry, record, { via: 'instruction-replacement' });
  }

  // Removals are explicit: one that doesn't apply says so rather than vanishing.
  for (const assetId of composition.removals) {
    const entry = hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
    if (entry && entry.kind !== 'skill' && entry.kind !== 'mcp') {
      block('invalid_removal_kind', [assetId]);
    } else if (!baseRefs.has(assetId) && !additions.has(assetId)) {
      notice('inert_removal', [assetId]);
    }
  }

  // Destinations: two owners on one key block, naming both. Nothing picks a winner.
  const all = [...planned.values()];
  const byKey = new Map<string, PlannedAsset[]>();
  for (const asset of [...all].sort((a, b) => compareText(a.assetId, b.assetId))) {
    const key = collisionKey(asset.destination.key);
    byKey.set(key, [...(byKey.get(key) ?? []), asset]);
  }
  for (const group of byKey.values()) {
    if (group.length > 1) {
      block('destination_collision', group.map((asset) => asset.assetId), { destination: group[0].destination.key });
    }
  }
  for (const foreign of request.foreign ?? []) {
    const group = byKey.get(collisionKey(foreign.key));
    if (group) {
      block('foreign_destination_collision', group.map((asset) => asset.assetId), {
        destination: group[0].destination.key,
        foreignOwner: foreign.owner,
      });
    }
  }

  const byDestination = (a: PlannedAsset, b: PlannedAsset): number => compareText(a.destination.key, b.destination.key) || compareText(a.assetId, b.assetId);
  const instructions = all.filter((asset) => asset.kind === 'instruction').sort(byDestination);
  const skills = all.filter((asset) => asset.kind === 'skill').sort(byDestination);
  const mcpServers = all.filter((asset) => asset.kind === 'mcp').sort(byDestination);
  const ordered = [...instructions, ...skills, ...mcpServers];
  for (const asset of ordered) asset.provenance = sortProvenance(asset.provenance);

  const sortedBlockers = sortIssues(blockers);
  const sortedNotices = sortIssues(notices);
  const excluded = baseExclusions.sort((a, b) => compareText(a.assetId, b.assetId));
  updates.sort((a, b) => compareText(a.assetId, b.assetId));

  const activationBase = base ? { presetId: base.presetId, revision: base.revision } : null;
  const fingerprint = canonicalHash({
    agentId,
    compositionRevision,
    composition: {
      basePresetId: composition.basePresetId,
      instructionAssetId: composition.instructionAssetId,
      additions: [...composition.additions].sort(),
      removals: [...composition.removals].sort(),
    },
    adoption: adoption.mode,
    base: activationBase,
    assets: ordered.map((asset) => [asset.assetId, asset.revision, asset.contentHash, asset.destination.key]),
    excluded,
    foreign: [...(request.foreign ?? [])].map((f) => [collisionKey(f.key), f.owner]).sort((a, b) => compareText(a.join('|'), b.join('|'))),
    blockers: sortedBlockers,
  });

  return {
    agentId,
    compositionRevision,
    adoptionMode: adoption.mode,
    base,
    instruction: instructions[0] ?? null,
    replacedInstruction: baseInstruction,
    skills,
    mcpServers,
    excluded,
    operationalDefaults,
    blockers: sortedBlockers,
    notices: sortedNotices,
    activation: sortedBlockers.length > 0 ? null : {
      agentId,
      compositionRevision,
      fingerprint,
      base: activationBase,
      assets: ordered.map(toActivationAsset),
      operationalDefaults,
    },
    fingerprint,
  };
}

function toActivationAsset(asset: PlannedAsset): ActivationAsset {
  return {
    assetId: asset.assetId,
    kind: asset.kind,
    revision: asset.revision,
    contentHash: asset.contentHash,
    destination: asset.destination,
    ...(asset.projection.kind === 'mcp' && {
      requires: { envVars: asset.projection.envVars, ...(asset.projection.auth && { auth: asset.projection.auth }) },
    }),
  };
}

function provenanceKey(source: PlannedSource): string {
  return source.via === 'base' ? `base:${source.presetId}:${source.presetRevision}` : source.via;
}

function sortProvenance(sources: PlannedSource[]): PlannedSource[] {
  return [...sources].sort((a, b) => compareText(provenanceKey(a), provenanceKey(b)));
}

function issueKey(issue: PlanIssue<string>): string {
  return `${issue.code}|${issue.assetIds.join(',')}|${issue.destination ?? ''}|${issue.foreignOwner ?? ''}`;
}

function sortIssues<Code extends string>(issues: PlanIssue<Code>[]): PlanIssue<Code>[] {
  const unique = new Map(issues.map((issue) => [issueKey(issue), issue]));
  return [...unique.values()].sort((a, b) => compareText(issueKey(a), issueKey(b)));
}

// ── Consumers ────────────────────────────────────────────────────────────

/** Presets at their head revision that refer to this asset. */
function presetConsumers(index: CatalogIndex, assetId: string): PresetConsumer[] {
  const out: PresetConsumer[] = [];
  for (const entry of Object.values(index.assets)) {
    if (entry.kind !== 'preset' || entry.deletedAt) continue;
    const projection = headOf(entry)?.projection;
    if (projection?.kind !== 'preset') continue;
    if (projection.instruction === assetId) out.push({ presetId: entry.id, role: 'instruction' });
    if (projection.skills.includes(assetId)) out.push({ presetId: entry.id, role: 'skill' });
    if (projection.mcps.includes(assetId)) out.push({ presetId: entry.id, role: 'mcp' });
  }
  return out.sort((a, b) => compareText(a.presetId, b.presetId) || compareText(a.role, b.role));
}

function relationsOf(index: CatalogIndex, composition: AgentComposition, assetId: string): ConsumerRelation[] {
  const relations: ConsumerRelation[] = [];
  const asset = hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
  if (composition.basePresetId === assetId) relations.push('base-preset');
  if (composition.additions.includes(assetId)) relations.push('addition');
  if (composition.instructionAssetId === assetId) relations.push('instruction-replacement');

  const preset = composition.basePresetId !== null ? liveEntry(index, composition.basePresetId) : null;
  const projection = preset && headOf(preset)?.projection;
  if (projection?.kind === 'preset') {
    if (projection.instruction === assetId) {
      const replaced = composition.instructionAssetId !== null && composition.instructionAssetId !== assetId;
      relations.push(replaced ? 'overridden' : 'via-base');
    }
    if (projection.skills.includes(assetId) || projection.mcps.includes(assetId)) {
      relations.push(composition.removals.includes(assetId) ? 'excluded' : 'via-base');
    }
  }
  // A removal of something the base no longer carries still names the asset, and says nothing about its kind.
  if (relations.length === 0 && asset && composition.removals.includes(assetId)) relations.push('excluded');
  return relations;
}

const INEFFECTIVE: ReadonlySet<ConsumerRelation> = new Set<ConsumerRelation>(['excluded', 'overridden']);

function agentConsumers(index: CatalogIndex, assetId: string): AgentConsumer[] {
  const out: AgentConsumer[] = [];
  for (const composition of Object.values(index.compositions)) {
    const relations = relationsOf(index, composition, assetId);
    if (relations.length === 0) continue;
    out.push({ agentId: composition.agentId, relations, effective: relations.some((relation) => !INEFFECTIVE.has(relation)) });
  }
  return out.sort((a, b) => compareText(a.agentId, b.agentId));
}

function copyConsumers(index: CatalogIndex, assetId: string): CopyConsumer[] {
  const out: CopyConsumer[] = [];
  for (const entry of Object.values(index.assets)) {
    if (entry.deletedAt || entry.source.kind !== 'copy' || entry.source.originAssetId !== assetId || entry.owner.kind !== 'agent') continue;
    out.push({ assetId: entry.id, agentId: entry.owner.agentId, originRevision: entry.source.originRevision });
  }
  return out.sort((a, b) => compareText(a.assetId, b.assetId));
}

/** Everything that refers to an asset. Exclusions and overrides are listed too, marked as not in effect. */
export function listConsumers(index: CatalogIndex, assetId: string): AssetConsumers {
  return {
    assetId,
    presets: presetConsumers(index, assetId),
    agents: agentConsumers(index, assetId),
    copies: copyConsumers(index, assetId),
  };
}

/** What stops a deletion: references that would dangle. An exclusion, or a copy's origin, wouldn't. */
export function hasHardReference(consumers: AssetConsumers): boolean {
  return consumers.presets.length > 0 || consumers.agents.some((agent) => agent.relations.some((relation) => relation !== 'excluded'));
}

// ── Impact ───────────────────────────────────────────────────────────────

function withCandidate(index: CatalogIndex, assetId: string, candidate: AssetRevisionRecord): CatalogIndex {
  const entry = index.assets[assetId];
  return {
    ...index,
    assets: {
      ...index.assets,
      [assetId]: { ...entry, headRevision: candidate.revision, revisions: [...entry.revisions, candidate] },
    },
  };
}

function planStored(index: CatalogIndex, composition: AgentComposition, context: ImpactContext): CompositionPlan {
  return planComposition(index, {
    agentId: composition.agentId,
    composition,
    compositionRevision: composition.revision,
    // Impact asks where desired state would go, so it looks at the latest. That doesn't decide when anyone adopts it.
    adoption: { mode: 'latest' },
    foreign: hasOwn(context.foreignByAgent ?? {}, composition.agentId) ? context.foreignByAgent![composition.agentId] : [],
  });
}

function plannedAssets(plan: CompositionPlan): PlannedAsset[] {
  return [...(plan.instruction ? [plan.instruction] : []), ...plan.skills, ...plan.mcpServers];
}

function changesBetween(before: CompositionPlan, after: CompositionPlan): PlannedAssetChange[] {
  const was = new Map(plannedAssets(before).map((asset) => [asset.assetId, asset]));
  const now = new Map(plannedAssets(after).map((asset) => [asset.assetId, asset]));
  const changes: PlannedAssetChange[] = [];
  for (const assetId of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const from = was.get(assetId);
    const to = now.get(assetId);
    if (from?.revision === to?.revision && from?.destination.key === to?.destination.key) continue;
    changes.push({
      assetId,
      fromRevision: from?.revision ?? null,
      toRevision: to?.revision ?? null,
      destination: (to ?? from)!.destination.key,
    });
  }
  return changes;
}

/**
 * Agents with the same workspace key and the same destination. Only agents
 * sharing a directory can step on each other, so an unknown workspace means
 * sharing with nobody.
 */
export function findSharedDestinations(
  plans: readonly CompositionPlan[],
  workspaceByAgent: Readonly<Record<string, string>> = {},
): SharedDestination[] {
  const groups = new Map<string, SharedDestination>();
  for (const plan of plans) {
    if (!hasOwn(workspaceByAgent, plan.agentId)) continue;
    const workspaceKey = workspaceByAgent[plan.agentId];
    for (const asset of plannedAssets(plan)) {
      const key = `${workspaceKey}\u0000${collisionKey(asset.destination.key)}`;
      const group = groups.get(key) ?? { workspaceKey, destination: asset.destination.key, agents: [], divergent: false };
      group.agents.push({ agentId: plan.agentId, assetId: asset.assetId, revision: asset.revision });
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.agents.length > 1)
    .map((group) => ({
      ...group,
      agents: [...group.agents].sort((a, b) => compareText(a.agentId, b.agentId)),
      divergent: new Set(group.agents.map((agent) => `${agent.assetId}@${agent.revision}`)).size > 1,
    }))
    .sort((a, b) => compareText(a.workspaceKey, b.workspaceKey) || compareText(a.destination, b.destination));
}

/**
 * What saving `candidate` over an asset's head would do: every consumer, in
 * effect or not, what would change for it, and what it would newly block. The
 * candidate isn't stored anywhere; the index passed in is left alone.
 */
export function previewAssetImpact(
  index: CatalogIndex,
  assetId: string,
  candidate: AssetRevisionRecord,
  context: ImpactContext = {},
): AssetImpact {
  const next = withCandidate(index, assetId, candidate);
  const consumers = listConsumers(index, assetId);
  const after = listConsumers(next, assetId);
  // A new preset revision can start or stop referring to things, but who consumes the preset doesn't change.
  const consumerByAgent = new Map([...consumers.agents, ...after.agents].map((agent) => [agent.agentId, agent]));

  const compositions = Object.values(index.compositions);
  const beforePlans = compositions.map((composition) => planStored(index, composition, context));
  const afterPlans = compositions.map((composition) => planStored(next, composition, context));

  const agents: ImpactedAgent[] = [];
  compositions.forEach((composition, position) => {
    const consumer = consumerByAgent.get(composition.agentId);
    if (!consumer) return;
    const seen = new Set(beforePlans[position].blockers.map(issueKey));
    agents.push({
      ...consumer,
      changes: changesBetween(beforePlans[position], afterPlans[position]),
      newBlockers: afterPlans[position].blockers.filter((issue) => !seen.has(issueKey(issue))),
      destinations: plannedAssets(afterPlans[position]).map((asset) => asset.destination.key),
    });
  });
  agents.sort((a, b) => compareText(a.agentId, b.agentId));

  const consumerIds = new Set(agents.map((agent) => agent.agentId));
  const involved = (group: SharedDestination): boolean => group.agents.some((agent) => consumerIds.has(agent.agentId));
  const sharedKey = (group: SharedDestination): string => `${group.workspaceKey}\u0000${collisionKey(group.destination)}`;
  const divergentBefore = new Set(
    findSharedDestinations(beforePlans, context.workspaceByAgent).filter((group) => group.divergent).map(sharedKey),
  );
  const sharedDestinations = findSharedDestinations(afterPlans, context.workspaceByAgent).filter(involved);
  const newlyDivergent = sharedDestinations.some((group) => group.divergent && !divergentBefore.has(sharedKey(group)));

  const blocked = newlyDivergent || agents.some((agent) => agent.newBlockers.length > 0);
  const impact = {
    assetId,
    fromRevision: index.assets[assetId].headRevision,
    toRevision: candidate.revision,
    presets: after.presets,
    agents,
    copies: consumers.copies,
    sharedDestinations,
    blocked,
  };
  // Copies stay out: they don't change when the origin does, so a new one needn't invalidate a confirmation.
  const { copies: _copies, ...confirmed } = impact;
  return { ...impact, fingerprint: canonicalHash({ ...confirmed, contentHash: candidate.contentHash }) };
}
