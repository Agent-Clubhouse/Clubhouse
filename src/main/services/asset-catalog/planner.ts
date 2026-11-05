/**
 * The composition planner (#2737, with the composition model on #2819): from a
 * catalog index and an agent's desired composition to exactly what that agent
 * would get. Pure: no I/O, no clock, and nothing is written, so asking never
 * changes anything. Output order comes from ids, keys and the instance's own
 * entry order, never from locale or insertion, so equal inputs give equal plans
 * and equal fingerprints.
 *
 * It blocks rather than chooses: no precedence between two assets, no merge, no
 * clamping. A structure question never blocks: the instance plans on what it last
 * accepted and says an update is waiting. A block's name or role decides nothing
 * about access, tools or policy, and the plan holds no instruction text.
 */

import { createHash } from 'crypto';
import type {
  ActivationAsset,
  ActivationPlan,
  AddableAssetKind,
  AgentComposition,
  AgentConsumer,
  AssetConsumers,
  AssetImpact,
  AssetOwner,
  AssetProjection,
  AssetRevisionRecord,
  BaseAdoption,
  CatalogEntry,
  CatalogIndex,
  CompositionInput,
  CompositionPlan,
  ConsumerRelation,
  CopyConsumer,
  ForeignDestination,
  ImpactContext,
  ImpactedAgent,
  InstanceEntry,
  InstanceSubagent,
  OriginStatus,
  PlanIssue,
  PlanIssueCode,
  PlanNoticeCode,
  PlannedAsset,
  PlannedAssetChange,
  PlannedBlock,
  PlannedContentUpdate,
  PlannedEntrySource,
  PlannedOperationalDefault,
  PlannedSource,
  PlannedStructure,
  PlannedStructureUpdate,
  PlannedSubagent,
  ProjectedDestination,
  SharedDestination,
  StructureInput,
  SubagentSetInput,
  TemplateConsumer,
  TemplateOperationalDefaults,
} from '../../../shared/asset-catalog-types';
import { composedBytes, MAX_COMPOSED_BYTES } from './composer';
import {
  applyCleanUpdate,
  baseKey,
  checkStructure,
  checkSubagentSet,
  entryKeyOf,
  firstBundleAbove,
  hasMovedEntries,
  takeableRevision,
} from './structure';
import { collisionKey, hasOwn } from './validation';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const INSTRUCTION_DESTINATION: ProjectedDestination = { kind: 'instruction-document', key: 'instructions/primary' };

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

/** A value's hash, whatever order its keys were written in. Array order counts. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function emptyComposition(): CompositionInput {
  return {
    template: null,
    entries: [],
    excludedEntryIds: [],
    subagents: [],
    excludedSubagentEntryIds: [],
    additions: [],
    removals: [],
    floors: {},
    keepMarkers: {},
    authorityApprovals: {},
  };
}

/** What a stored composition binds to: everything but when it was saved. */
export function instanceFingerprint(composition: AgentComposition): string {
  const { updatedAt: _updatedAt, ...bound } = composition;
  return canonicalHash(bound);
}

function entryOf(index: CatalogIndex, assetId: string): CatalogEntry | null {
  return hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
}

function liveEntry(index: CatalogIndex, assetId: string): CatalogEntry | null {
  const entry = entryOf(index, assetId);
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
    case 'block': return INSTRUCTION_DESTINATION;
    case 'subagent': return { kind: 'native-subagent', key: `subagents/${projection.agentName}` };
    case 'template': return null;
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

function templateProjection(entry: CatalogEntry | null, revision: number): Extract<AssetProjection, { kind: 'template' }> | null {
  const projection = entry && revisionOf(entry, revision)?.projection;
  return projection?.kind === 'template' ? projection : null;
}

/** The target of an update or an instance: ids in the base's order, for the pure functions. */
export function templateTargetOf(templateId: string, revision: number, projection: Extract<AssetProjection, { kind: 'template' }>) {
  return {
    templateId,
    revision,
    entryIds: projection.entries.map((entry) => entry.entryId),
    subagentIds: projection.subagents.map((entry) => entry.entryId),
  };
}

/** Accepted base refs by entry id, for keeping or carrying an entry the next base doesn't have. */
export function acceptedRefsOf(projection: Extract<AssetProjection, { kind: 'template' }> | null) {
  return {
    acceptedBlocks: Object.fromEntries((projection?.entries ?? []).map((ref) => [ref.entryId, { assetId: ref.blockId, revision: ref.blockRevision }])),
    acceptedSubagents: Object.fromEntries((projection?.subagents ?? []).map((ref) => [ref.entryId, { assetId: ref.subagentId, revision: ref.subagentRevision }])),
  };
}

function nameOf(index: CatalogIndex, assetId: string): string {
  return entryOf(index, assetId)?.name ?? '';
}

function agentNameAt(index: CatalogIndex, assetId: string, revision: number): string {
  const entry = entryOf(index, assetId);
  const projection = entry && (revisionOf(entry, revision) ?? headOf(entry))?.projection;
  return projection?.kind === 'subagent' ? projection.agentName : '';
}

function blockIdOf(entry: InstanceEntry, accepted: Extract<AssetProjection, { kind: 'template' }> | null): string | undefined {
  if (entry.source.blockId) return entry.source.blockId;
  return accepted?.entries.find((ref) => ref.entryId === entry.baseEntryId)?.blockId;
}

function subagentIdOf(entry: InstanceSubagent, accepted: Extract<AssetProjection, { kind: 'template' }> | null): string | undefined {
  if (entry.source.subagentId) return entry.source.subagentId;
  return accepted?.subagents.find((ref) => ref.entryId === entry.baseEntryId)?.subagentId;
}

/** The inputs to {@link checkStructure}. Names come from the catalog as it is now, so a rename counts. */
export function structureInput(
  index: CatalogIndex,
  composition: CompositionInput,
  accepted: Extract<AssetProjection, { kind: 'template' }> | null,
  target: Extract<AssetProjection, { kind: 'template' }>,
): StructureInput {
  const asBase = (ref: { entryId: string; blockId: string }) => ({ entryId: ref.entryId, blockId: ref.blockId, name: nameOf(index, ref.blockId) });
  return {
    accepted: (accepted?.entries ?? []).map(asBase),
    target: target.entries.map(asBase),
    excluded: composition.excludedEntryIds,
    instance: composition.entries.map((entry) => {
      const blockId = blockIdOf(entry, accepted);
      const forkedFrom = entry.source.kind === 'fork' ? [entry.source.forkedFrom.assetId] : [];
      return {
        key: entryKeyOf(entry),
        baseEntryId: entry.baseEntryId ?? null,
        sources: [...(blockId ? [blockId] : []), ...forkedFrom],
        name: blockId ? nameOf(index, blockId) : '',
        forked: entry.source.kind === 'fork',
      };
    }),
  };
}

export function subagentSetInput(
  index: CatalogIndex,
  composition: CompositionInput,
  accepted: Extract<AssetProjection, { kind: 'template' }> | null,
  target: Extract<AssetProjection, { kind: 'template' }>,
  foreign: readonly ForeignDestination[],
): SubagentSetInput {
  const asSet = (ref: { entryId: string; subagentId: string; subagentRevision: number }) => ({ entryId: ref.entryId, name: agentNameAt(index, ref.subagentId, ref.subagentRevision) });
  const acceptedRefs = new Map((accepted?.subagents ?? []).map((ref) => [ref.entryId, ref]));
  const excluded = new Set(composition.excludedSubagentEntryIds);
  const authorityEntries = target.subagents.filter((ref) => {
    if (excluded.has(ref.entryId)) return false;
    const was = acceptedRefs.get(ref.entryId);
    if (was?.subagentId === ref.subagentId && was.subagentRevision === ref.subagentRevision) return false;
    const entry = entryOf(index, ref.subagentId);
    const projection = entry && revisionOf(entry, ref.subagentRevision)?.projection;
    return projection?.kind === 'subagent' && projection.authorityFields.length > 0 && !isApproved(composition, ref.subagentId, ref.subagentRevision);
  }).map((ref) => ref.entryId);
  return {
    accepted: (accepted?.subagents ?? []).map(asSet),
    target: target.subagents.map(asSet),
    excluded: composition.excludedSubagentEntryIds,
    foreignNames: foreign.filter((item) => item.key.startsWith('subagents/')).map((item) => item.key.slice('subagents/'.length)),
    authorityEntries,
    instance: composition.subagents.map((entry) => {
      const assetId = subagentIdOf(entry, accepted);
      const ref = acceptedRefs.get(entry.baseEntryId ?? '');
      return {
        key: entryKeyOf(entry),
        baseEntryId: entry.baseEntryId ?? null,
        name: assetId ? agentNameAt(index, assetId, entry.source.kind === 'follow' && ref ? ref.subagentRevision : entryOf(index, assetId)?.headRevision ?? 0) : '',
        forked: entry.source.kind === 'fork',
      };
    }),
  };
}

function isApproved(composition: CompositionInput, subagentId: string, revision: number): boolean {
  return hasOwn(composition.authorityApprovals, subagentId) && composition.authorityApprovals[subagentId] === revision;
}

interface PlanRequest {
  agentId: string;
  /** The project this agent is planned under, for project-owned assets. Which assets a project assigns stays undecided. */
  projectId?: string;
  /** The composition being previewed, or the stored one. */
  composition: CompositionInput;
  compositionRevision: number;
  /** Required, with no default: see {@link BaseAdoption}. */
  adoption: BaseAdoption;
  foreign?: readonly ForeignDestination[];
}

const OPERATIONAL_KEYS: ReadonlyArray<keyof TemplateOperationalDefaults> = [
  'agentAccess', 'orchestrate', 'access', 'control', 'maxHelpers', 'crossProjectHelpers', 'connectToDispatcher', 'autoHelpers',
];

function isValidAdoption(adoption: BaseAdoption | undefined): boolean {
  const content = adoption?.content?.mode;
  const structure = adoption?.structure?.mode;
  return (content === 'takeable' || content === 'hold') && (structure === 'accepted' || structure === 'latest-if-clean');
}

function ownerAllows(owner: AssetOwner, agentId: string, projectId: string | undefined): boolean {
  if (owner.kind === 'agent') return owner.agentId === agentId;
  if (owner.kind === 'project') return owner.projectId === projectId;
  return true;
}

export function planComposition(index: CatalogIndex, request: PlanRequest): CompositionPlan {
  if (!isValidAdoption(request.adoption)) throw new TypeError('adoption_policy_required');
  const { composition, adoption } = request;
  const foreign = request.foreign ?? [];

  const template = composition.template;
  const templateEntry = template ? entryOf(index, template.templateId) : null;
  const accepted = template ? templateProjection(templateEntry, template.acceptedRevision) : null;
  const latest = templateEntry && !templateEntry.deletedAt && template ? templateEntry.headRevision : template?.acceptedRevision;

  // What's on offer, and whether taking it would be clean. Planned first so its blockers count too.
  let update: PlannedStructureUpdate | null = null;
  let resolved = composition;
  if (template && accepted && templateEntry) {
    const target = latest === template.acceptedRevision ? null : templateProjection(templateEntry, latest as number);
    if (target) {
      const structure = checkStructure(structureInput(index, composition, accepted, target));
      const subagents = checkSubagentSet(subagentSetInput(index, composition, accepted, target, foreign));
      const candidate = structure.clean && subagents.clean
        ? applyCleanUpdate(composition, templateTargetOf(template.templateId, latest as number, target), structure.order)
        : null;
      const blockers = candidate
        ? planResolved(index, { ...request, composition: candidate }, null).blockers
        : [];
      const clean = !!candidate && blockers.length === 0;
      update = {
        status: clean ? 'clean' : 'needs-choice',
        targetRevision: latest as number,
        reasons: structure.reasons,
        subagentReasons: subagents.reasons,
        blockers,
      };
      if (clean && adoption.structure.mode === 'latest-if-clean') resolved = candidate;
    } else {
      update = { status: 'current', targetRevision: template.acceptedRevision, reasons: [], subagentReasons: [], blockers: [] };
    }
  }
  return planResolved(index, { ...request, composition: resolved }, update, composition);
}

/** One composition, as it stands. `update` is null only while weighing a candidate. */
function planResolved(
  index: CatalogIndex,
  request: PlanRequest,
  update: PlannedStructureUpdate | null,
  stored: CompositionInput = request.composition,
): CompositionPlan {
  const { agentId, projectId, composition, compositionRevision, adoption } = request;
  const blockers: PlanIssue[] = [];
  const notices: PlanIssue<PlanNoticeCode>[] = [];
  const block = (code: PlanIssueCode, assetIds: string[], extra: Partial<PlanIssue> = {}): void => {
    blockers.push({ code, assetIds, ...extra });
  };
  const notice = (code: PlanNoticeCode, assetIds: string[], extra: Partial<PlanIssue<PlanNoticeCode>> = {}): void => {
    notices.push({ code, assetIds, ...extra });
  };

  /** A live entry of one of these kinds that this agent may use, or null with the blocker recorded. */
  const usable = (assetId: string, kinds: readonly string[]): CatalogEntry | null => {
    const refuse = (code: PlanIssueCode): null => {
      block(code, [assetId]);
      return null;
    };
    const entry = entryOf(index, assetId);
    if (!entry) return refuse('asset_missing');
    if (entry.deletedAt) return refuse('asset_deleted');
    if (!kinds.includes(entry.kind)) return refuse('wrong_kind');
    if (!ownerAllows(entry.owner, agentId, projectId)) return refuse('owner_mismatch');
    return entry;
  };

  const heldRevision = (assetId: string): number | undefined => {
    if (adoption.content.mode !== 'hold') return undefined;
    return hasOwn(adoption.content.revisions, assetId) ? adoption.content.revisions[assetId] : undefined;
  };

  const templateRef = composition.template;
  const templateEntry = templateRef ? usable(templateRef.templateId, ['template']) : null;
  const templateRecord = templateEntry && templateRef ? revisionOf(templateEntry, templateRef.acceptedRevision) : null;
  if (templateEntry && !templateRecord) block('revision_unavailable', [templateEntry.id]);
  const accepted = templateRecord?.projection.kind === 'template' ? templateRecord.projection : null;

  /** Applies the two tracks to something followed: its floor, what it can take, and what this plan resolves. */
  const resolveFollowed = (entry: CatalogEntry, referenced: number | null): {
    record: AssetRevisionRecord | null;
    floor: number;
    takeable: number;
    update: PlannedContentUpdate | null;
  } => {
    const explicit = hasOwn(composition.floors, entry.id) ? composition.floors[entry.id] : 0;
    const floor = Math.max(referenced ?? 0, explicit);
    const history = entry.revisions;
    const takeable = takeableRevision(history, floor);

    // Apply can't jump this instance's own template: that arrives only by accepting it.
    if (templateRef && explicit > (referenced ?? 0)) {
      const crossed = history.filter((record) => record.revision > (referenced ?? 0) && record.revision <= explicit)
        .some((record) => record.bundledBy?.templateId === templateRef.templateId && record.bundledBy.templateRevision > templateRef.acceptedRevision);
      if (crossed) block('floor_bypasses_template', [entry.id]);
    }

    let revision = takeable;
    const held = heldRevision(entry.id);
    if (adoption.content.mode === 'hold') {
      if (held === undefined) {
        block('hold_incomplete', [entry.id]);
        return { record: null, floor, takeable, update: null };
      }
      if (held < floor) block('hold_below_floor', [entry.id]);
      else if (held > takeable) block('hold_past_bundle', [entry.id]);
      revision = held;
    }
    const record = revisionOf(entry, revision);
    if (!record) block('revision_unavailable', [entry.id]);
    return { record, floor, takeable, update: record ? contentUpdate(entry, record.revision, floor) : null };
  };

  const contentUpdate = (entry: CatalogEntry, revision: number, floor: number): PlannedContentUpdate | null => {
    if (entry.headRevision <= revision) return null;
    const heldBy = firstBundleAbove(entry.revisions, floor);
    const ownBundle = !!heldBy && heldBy.templateId === templateRef?.templateId && heldBy.templateRevision > templateRef.acceptedRevision;
    const kept = hasOwn(composition.keepMarkers, entry.id) && composition.keepMarkers[entry.id] >= entry.headRevision;
    return {
      range: { from: floor, to: entry.headRevision },
      heldBy,
      resolution: heldBy ? (ownBundle ? 'accept-template' : 'explicit') : null,
      missingCompanions: [],
      kept,
    };
  };

  // Instructions: the instance's own order. Every block goes to one destination, so nothing here can collide.
  const presentKeys = new Set(composition.entries.map(entryKeyOf));
  const excludedIds = new Set(composition.excludedEntryIds);
  const acceptedEntries = new Map((accepted?.entries ?? []).map((ref) => [ref.entryId, ref]));
  const entriesExcluded: CompositionPlan['excluded'] = [];
  for (const ref of accepted?.entries ?? []) {
    if (excludedIds.has(ref.entryId)) {
      entriesExcluded.push({ kind: 'block', assetId: ref.blockId, entryId: ref.entryId });
      if (presentKeys.has(baseKey(ref.entryId))) block('excluded_entry_present', [ref.blockId], { entries: [baseKey(ref.entryId)] });
    } else if (!presentKeys.has(baseKey(ref.entryId))) {
      block('entry_missing_from_order', [ref.blockId], { entries: [baseKey(ref.entryId)] });
    }
  }

  const plannedBlocks: PlannedBlock[] = [];
  const seenBlocks = new Map<string, string>();
  for (const item of composition.entries) {
    const key = entryKeyOf(item);
    const ref = item.baseEntryId ? acceptedEntries.get(item.baseEntryId) : undefined;
    if (item.baseEntryId && !ref) {
      // Blockers on the template itself already explain it when there's no accepted revision.
      if (accepted || !composition.template) block('entry_not_in_template', [], { entries: [key] });
      continue;
    }
    const blockId = item.source.blockId ?? ref?.blockId;
    if (!blockId) {
      block('entry_not_in_template', [], { entries: [key] });
      continue;
    }
    const entry = usable(blockId, ['block']);
    if (!entry) continue;
    if (seenBlocks.has(blockId)) block('duplicate_source', [blockId], { entries: [seenBlocks.get(blockId) as string, key].sort(compareText) });
    seenBlocks.set(blockId, key);

    let record: AssetRevisionRecord | null;
    let floor: number | null = null;
    let takeable = entry.headRevision;
    let contentState: PlannedContentUpdate | null = null;
    if (item.source.kind === 'follow') {
      if (!ref && !hasOwn(composition.floors, blockId)) block('missing_floor', [blockId], { entries: [key] });
      const followed = resolveFollowed(entry, ref?.blockRevision ?? null);
      record = followed.record;
      floor = followed.floor;
      takeable = followed.takeable;
      contentState = followed.update;
    } else {
      // A fork or local block is this agent's own, at its latest. Nothing changes it from outside.
      record = headOf(entry);
      if (!record) block('revision_unavailable', [blockId]);
      if (entry.owner.kind === 'library') block('owner_mismatch', [blockId]);
      if (item.source.kind === 'fork') {
        const { forkedFrom } = item.source;
        const matches = entry.source.kind === 'copy' && entry.source.originAssetId === forkedFrom.assetId && entry.source.originRevision === forkedFrom.revision;
        if (!matches) block('fork_origin_mismatch', [blockId], { entries: [key] });
      }
    }
    if (!record) continue;

    const origin = originStatusOf(index, entry);
    if (origin?.originDeleted) notice('origin_deleted', [entry.id]);
    else if (origin?.newerRevisionAvailable && !(hasOwn(composition.keepMarkers, origin.originAssetId) && composition.keepMarkers[origin.originAssetId] >= (origin.originHeadRevision as number))) {
      notice('origin_newer_revision', [entry.id]);
    }
    if (contentState && !contentState.kept) notice('content_update_waiting', [entry.id], { entries: [key] });

    plannedBlocks.push({
      entryKey: key,
      source: item.source.kind as PlannedEntrySource,
      assetId: entry.id,
      name: entry.name,
      revision: record.revision,
      floor,
      takeableRevision: takeable,
      headRevision: entry.headRevision,
      contentHash: record.contentHash,
      bytes: record.projection.kind === 'block' ? record.projection.bytes : 0,
      owner: entry.owner,
      ...(item.source.kind === 'fork' && { forkedFrom: item.source.forkedFrom }),
      ...(origin && { origin }),
      update: contentState,
    });
  }

  // Name the assets a bundle brought that this consumer doesn't have, for the range diff.
  const heldAssets = new Set(plannedBlocks.map((planned) => planned.assetId));
  for (const planned of plannedBlocks) {
    if (planned.update?.heldBy) planned.update.missingCompanions = companionsOf(index, planned.update.heldBy, planned.assetId, heldAssets);
  }

  const contents = new Map<string, string>();
  for (const planned of plannedBlocks) {
    const other = contents.get(planned.contentHash);
    if (other) notice('identical_text', [other, planned.assetId].sort(compareText));
    else contents.set(planned.contentHash, planned.assetId);
  }

  const instructionBytes = composedBytes(plannedBlocks.map((planned) => planned.bytes));
  if (instructionBytes > MAX_COMPOSED_BYTES) block('instructions_too_large', plannedBlocks.map((planned) => planned.assetId).sort(compareText));

  // Skills and MCP definitions: one destination each, by id, following the latest approved revision.
  const planned = new Map<string, PlannedAsset>();
  const removals = new Set(composition.removals);
  const additions = new Set(composition.additions);
  const baseRefs = new Set<string>();
  const entriesExcludedAddable: CompositionPlan['excluded'] = [];

  const contribute = (entry: CatalogEntry, record: AssetRevisionRecord, source: PlannedSource): void => {
    const destination = destinationOf(record.projection);
    if (!destination) return;
    const existing = planned.get(entry.id);
    if (existing) {
      if (existing.revision !== record.revision) block('conflicting_revisions', [entry.id]);
      existing.provenance.push(source);
      return;
    }
    const origin = originStatusOf(index, entry);
    planned.set(entry.id, {
      assetId: entry.id,
      kind: entry.kind as AddableAssetKind,
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

  if (accepted && templateRef) {
    const via: PlannedSource = { via: 'base', templateId: templateRef.templateId, templateRevision: templateRef.acceptedRevision };
    const refs: Array<[string, AddableAssetKind]> = [
      ...accepted.skills.map((id): [string, AddableAssetKind] => [id, 'skill']),
      ...accepted.mcps.map((id): [string, AddableAssetKind] => [id, 'mcp']),
    ];
    for (const [assetId, kind] of refs) {
      baseRefs.add(assetId);
      if (removals.has(assetId)) {
        entriesExcludedAddable.push({ kind, assetId });
        continue;
      }
      const entry = usable(assetId, [kind]);
      if (!entry) continue;
      let record = headOf(entry);
      const held = heldRevision(assetId);
      if (adoption.content.mode === 'hold') {
        if (held === undefined) {
          block('hold_incomplete', [assetId]);
          continue;
        }
        record = revisionOf(entry, held);
        if (!record) block('revision_unavailable', [assetId]);
      }
      if (record) contribute(entry, record, via);
    }
  }

  for (const assetId of composition.additions) {
    if (removals.has(assetId)) block('contradictory_override', [assetId]);
    const target = entryOf(index, assetId);
    if (!target) {
      block('asset_missing', [assetId]);
      continue;
    }
    if (target.kind !== 'skill' && target.kind !== 'mcp') {
      block('invalid_addition_kind', [assetId]);
      continue;
    }
    const entry = usable(assetId, ['skill', 'mcp']);
    const record = entry && headOf(entry);
    if (entry && record) contribute(entry, record, { via: 'addition' });
  }

  for (const assetId of composition.removals) {
    const entry = entryOf(index, assetId);
    if (entry && entry.kind !== 'skill' && entry.kind !== 'mcp') block('invalid_removal_kind', [assetId]);
    else if (!baseRefs.has(assetId) && !additions.has(assetId)) notice('inert_removal', [assetId]);
  }

  // Native subagents: a set keyed by stable id. Each block in one follows the same two tracks.
  const subagentsExcluded = new Set(composition.excludedSubagentEntryIds);
  const acceptedSubagents = new Map((accepted?.subagents ?? []).map((ref) => [ref.entryId, ref]));
  const subagentKeys = new Set(composition.subagents.map(entryKeyOf));
  const excludedSubagentsPlan: CompositionPlan['excluded'] = [];
  for (const ref of accepted?.subagents ?? []) {
    if (subagentsExcluded.has(ref.entryId)) {
      excludedSubagentsPlan.push({ kind: 'subagent', assetId: ref.subagentId, entryId: ref.entryId });
      if (subagentKeys.has(baseKey(ref.entryId))) block('excluded_entry_present', [ref.subagentId], { entries: [baseKey(ref.entryId)] });
    } else if (!subagentKeys.has(baseKey(ref.entryId))) {
      block('entry_missing_from_order', [ref.subagentId], { entries: [baseKey(ref.entryId)] });
    }
  }

  const plannedSubagents: PlannedSubagent[] = [];
  const pinnedLatest = (assetIds: readonly string[], kind: AddableAssetKind): Array<{ assetId: string; revision: number; contentHash: string }> => assetIds.flatMap((assetId) => {
    const entry = usable(assetId, [kind]);
    const record = entry && headOf(entry);
    if (!entry) return [];
    if (!record) {
      block('revision_unavailable', [assetId]);
      return [];
    }
    return [{ assetId, revision: record.revision, contentHash: record.contentHash }];
  });

  for (const item of composition.subagents) {
    const key = entryKeyOf(item);
    const ref = item.baseEntryId ? acceptedSubagents.get(item.baseEntryId) : undefined;
    if (item.baseEntryId && !ref) {
      if (accepted || !composition.template) block('entry_not_in_template', [], { entries: [key] });
      continue;
    }
    const subagentId = item.source.subagentId ?? ref?.subagentId;
    if (!subagentId) {
      block('entry_not_in_template', [], { entries: [key] });
      continue;
    }
    const entry = usable(subagentId, ['subagent']);
    if (!entry) continue;

    let record: AssetRevisionRecord | null;
    let floor: number | null = null;
    let takeable = entry.headRevision;
    let contentState: PlannedContentUpdate | null = null;
    if (item.source.kind === 'follow') {
      if (!ref && !hasOwn(composition.floors, subagentId)) block('missing_floor', [subagentId], { entries: [key] });
      const followed = resolveFollowed(entry, ref?.subagentRevision ?? null);
      record = followed.record;
      floor = followed.floor;
      takeable = followed.takeable;
      contentState = followed.update;
    } else {
      record = headOf(entry);
      if (!record) block('revision_unavailable', [subagentId]);
      if (entry.owner.kind === 'library') block('owner_mismatch', [subagentId]);
      if (item.source.kind === 'fork') {
        const { forkedFrom } = item.source;
        const matches = entry.source.kind === 'copy' && entry.source.originAssetId === forkedFrom.assetId && entry.source.originRevision === forkedFrom.revision;
        if (!matches) block('fork_origin_mismatch', [subagentId], { entries: [key] });
      }
    }
    if (!record || record.projection.kind !== 'subagent') continue;
    const projection = record.projection;

    if (projection.authorityFields.length > 0 && !isApproved(composition, entry.id, record.revision)) {
      block('subagent_authority_fields', [entry.id], { fields: projection.authorityFields });
    }

    const blocks = projection.blocks.flatMap((blockRef) => {
      const blockEntry = usable(blockRef.blockId, ['block']);
      if (!blockEntry) return [];
      if (item.source.kind !== 'follow' && blockEntry.owner.kind !== 'library') {
        const own = headOf(blockEntry);
        return own ? [{ entryId: blockRef.entryId, assetId: blockEntry.id, revision: own.revision, contentHash: own.contentHash, update: null }] : [];
      }
      const followed = resolveFollowed(blockEntry, blockRef.blockRevision);
      if (!followed.record) return [];
      return [{ entryId: blockRef.entryId, assetId: blockEntry.id, revision: followed.record.revision, contentHash: followed.record.contentHash, update: followed.update }];
    });

    const origin = originStatusOf(index, entry);
    if (origin?.originDeleted) notice('origin_deleted', [entry.id]);
    else if (origin?.newerRevisionAvailable) notice('origin_newer_revision', [entry.id]);
    if (contentState && !contentState.kept) notice('content_update_waiting', [entry.id], { entries: [key] });
    for (const planBlock of blocks) {
      if (planBlock.update && !planBlock.update.kept) notice('content_update_waiting', [planBlock.assetId], { entries: [key] });
    }

    plannedSubagents.push({
      entryKey: key,
      source: item.source.kind as PlannedEntrySource,
      assetId: entry.id,
      name: entry.name,
      agentName: projection.agentName,
      revision: record.revision,
      floor,
      takeableRevision: takeable,
      headRevision: entry.headRevision,
      contentHash: record.contentHash,
      owner: entry.owner,
      destination: destinationOf(projection) as ProjectedDestination,
      blocks,
      skills: pinnedLatest(projection.skills, 'skill'),
      mcps: pinnedLatest(projection.mcps, 'mcp'),
      providers: projection.providers,
      authorityFields: projection.authorityFields,
      toolFields: projection.toolFields,
      ...(origin && { origin }),
      update: contentState,
    });
  }

  // Destinations: two owners on one key block, naming both. Nothing picks a winner. Blocks aren't here: they share one by design.
  const allDestinations: Array<{ assetId: string; key: string }> = [
    ...[...planned.values()].map((asset) => ({ assetId: asset.assetId, key: asset.destination.key })),
    ...plannedSubagents.map((asset) => ({ assetId: asset.assetId, key: asset.destination.key })),
  ];
  const byKey = new Map<string, Array<{ assetId: string; key: string }>>();
  for (const item of [...allDestinations].sort((a, b) => compareText(a.assetId, b.assetId))) {
    const key = collisionKey(item.key);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  for (const group of byKey.values()) {
    if (group.length > 1) block('destination_collision', group.map((item) => item.assetId), { destination: group[0].key });
  }
  for (const item of request.foreign ?? []) {
    const group = byKey.get(collisionKey(item.key));
    if (group) {
      block('foreign_destination_collision', group.map((asset) => asset.assetId), { destination: group[0].key, foreignOwner: item.owner });
    }
  }

  const byDestination = (a: PlannedAsset, b: PlannedAsset): number => compareText(a.destination.key, b.destination.key) || compareText(a.assetId, b.assetId);
  const skills = [...planned.values()].filter((asset) => asset.kind === 'skill').sort(byDestination);
  const mcpServers = [...planned.values()].filter((asset) => asset.kind === 'mcp').sort(byDestination);
  for (const asset of [...skills, ...mcpServers]) asset.provenance = sortProvenance(asset.provenance);
  const subagents = [...plannedSubagents].sort((a, b) => compareText(a.entryKey, b.entryKey));

  const operationalDefaults: PlannedOperationalDefault[] = accepted && templateRef
    ? OPERATIONAL_KEYS.flatMap((key): PlannedOperationalDefault[] => {
      const value = accepted.operationalDefaults?.[key];
      return value === undefined ? [] : [{ key, value, templateId: templateRef.templateId, templateRevision: templateRef.acceptedRevision }];
    })
    : [];

  // The structure report. `stored` is what's accepted; `composition` may be a clean update this plan is resolving.
  const storedRevision = stored.template?.acceptedRevision;
  let structure: PlannedStructure | null = null;
  if (composition.template && templateEntry) {
    const acceptedStored = templateProjection(entryOf(index, composition.template.templateId), storedRevision ?? composition.template.acceptedRevision);
    const moved = hasMovedEntries(
      (acceptedStored?.entries ?? []).map((ref) => ref.entryId),
      stored.entries.flatMap((item) => (item.baseEntryId ? [item.baseEntryId] : [])),
      stored.excludedEntryIds,
    );
    const hasLocal = stored.entries.some((item) => !item.baseEntryId);
    const hasExclusion = (acceptedStored?.entries ?? []).some((ref) => stored.excludedEntryIds.includes(ref.entryId));
    structure = {
      templateId: composition.template.templateId,
      name: templateEntry.name,
      acceptedRevision: storedRevision ?? composition.template.acceptedRevision,
      resolvedRevision: composition.template.acceptedRevision,
      latestRevision: templateEntry.headRevision,
      customOrder: moved || hasLocal || hasExclusion,
      update: update ?? { status: 'current', targetRevision: composition.template.acceptedRevision, reasons: [], subagentReasons: [], blockers: [] },
    };
    const waiting = structure.update.status !== 'current' && structure.resolvedRevision < structure.latestRevision;
    if (waiting) {
      notice('structure_update_waiting', [composition.template.templateId], {
        entries: structure.update.reasons.flatMap((reason) => reason.entries),
      });
    }
    const target = templateProjection(templateEntry, templateEntry.headRevision);
    const readded = (target?.entries ?? []).filter((ref) => excludedIds.has(ref.entryId) && !(acceptedStored?.entries ?? []).some((item) => item.entryId === ref.entryId));
    for (const ref of readded) notice('excluded_entry_readded', [ref.blockId], { entries: [baseKey(ref.entryId)] });
    const readdedSubagents = (target?.subagents ?? []).filter((ref) => subagentsExcluded.has(ref.entryId) && !(acceptedStored?.subagents ?? []).some((item) => item.entryId === ref.entryId));
    for (const ref of readdedSubagents) notice('excluded_entry_readded', [ref.subagentId], { entries: [baseKey(ref.entryId)] });
  }

  const sortedBlockers = sortIssues(blockers);
  const sortedNotices = sortIssues(notices);
  const excluded = [...entriesExcluded, ...entriesExcludedAddable, ...excludedSubagentsPlan]
    .sort((a, b) => compareText(a.kind, b.kind) || compareText(a.assetId, b.assetId));
  const surfaceAdopted = !!composition.template || composition.entries.length > 0;

  const fingerprint = canonicalHash({
    agentId,
    compositionRevision,
    template: composition.template,
    // Order counts: this is the rendered order.
    entries: composition.entries,
    excludedEntryIds: [...composition.excludedEntryIds].sort(),
    subagents: composition.subagents.map((item) => [entryKeyOf(item), item.source]).sort((a, b) => compareText(a[0] as string, b[0] as string)),
    excludedSubagentEntryIds: [...composition.excludedSubagentEntryIds].sort(),
    additions: [...composition.additions].sort(),
    removals: [...composition.removals].sort(),
    floors: composition.floors,
    keepMarkers: composition.keepMarkers,
    authorityApprovals: composition.authorityApprovals,
    adoption: { content: adoption.content.mode, structure: adoption.structure.mode },
    blocks: plannedBlocks.map((item) => [item.entryKey, item.assetId, item.revision, item.contentHash]),
    assets: [...skills, ...mcpServers].map((asset) => [asset.assetId, asset.revision, asset.contentHash, asset.destination.key]),
    subagentAssets: subagents.map((asset) => [asset.entryKey, asset.assetId, asset.revision, asset.contentHash, asset.blocks.map((item) => [item.assetId, item.revision, item.contentHash])]),
    excluded,
    foreign: [...(request.foreign ?? [])].map((f) => [collisionKey(f.key), f.owner]).sort((a, b) => compareText(a.join('|'), b.join('|'))),
    blockers: sortedBlockers,
  });

  const activation: ActivationPlan | null = sortedBlockers.length > 0 ? null : {
    agentId,
    compositionRevision,
    fingerprint,
    structure: structure && {
      templateId: structure.templateId,
      acceptedRevision: structure.acceptedRevision,
      resolvedRevision: structure.resolvedRevision,
      latestRevision: structure.latestRevision,
      updateWaiting: structure.resolvedRevision < structure.latestRevision,
    },
    instructions: surfaceAdopted
      ? {
        destination: INSTRUCTION_DESTINATION,
        blocks: plannedBlocks.map((item) => ({
          entryKey: item.entryKey,
          source: item.source,
          assetId: item.assetId,
          revision: item.revision,
          contentHash: item.contentHash,
        })),
      }
      : null,
    assets: [...skills, ...mcpServers].map(toActivationAsset),
    subagents: subagents.map((asset) => ({
      entryKey: asset.entryKey,
      assetId: asset.assetId,
      revision: asset.revision,
      contentHash: asset.contentHash,
      destination: asset.destination,
      blocks: asset.blocks.map((item) => ({ assetId: item.assetId, revision: item.revision, contentHash: item.contentHash })),
      skills: asset.skills,
      mcps: asset.mcps,
    })),
    operationalDefaults,
  };

  return {
    agentId,
    compositionRevision,
    adoption: { content: adoption.content.mode, structure: adoption.structure.mode },
    structure,
    instructions: surfaceAdopted ? { destination: INSTRUCTION_DESTINATION, blocks: plannedBlocks, bytes: instructionBytes } : null,
    skills,
    mcpServers,
    subagents,
    excluded,
    operationalDefaults,
    blockers: sortedBlockers,
    notices: sortedNotices,
    activation,
    fingerprint,
  };
}

/** Other assets published in one bundle that this consumer doesn't have: what moving past it would leave out. */
function companionsOf(index: CatalogIndex, bundle: NonNullable<PlannedContentUpdate['heldBy']>, assetId: string, present: ReadonlySet<string>): string[] {
  return Object.values(index.assets)
    .filter((entry) => entry.id !== assetId && !present.has(entry.id) && entry.revisions.some(
      (record) => record.bundledBy?.templateId === bundle.templateId && record.bundledBy.templateRevision === bundle.templateRevision,
    ))
    .map((entry) => entry.id)
    .sort(compareText);
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
  return source.via === 'base' ? `base:${source.templateId}:${source.templateRevision}` : source.via;
}

function sortProvenance(sources: PlannedSource[]): PlannedSource[] {
  return [...sources].sort((a, b) => compareText(provenanceKey(a), provenanceKey(b)));
}

function issueKey(issue: PlanIssue<string>): string {
  return `${issue.code}|${issue.assetIds.join(',')}|${(issue.entries ?? []).join(',')}|${issue.destination ?? ''}|${issue.foreignOwner ?? ''}`;
}

function sortIssues<Code extends string>(issues: PlanIssue<Code>[]): PlanIssue<Code>[] {
  const unique = new Map(issues.map((issue) => [issueKey(issue), issue]));
  return [...unique.values()].sort((a, b) => compareText(issueKey(a), issueKey(b)));
}

// ── Consumers ────────────────────────────────────────────────────────────

/** Templates at their latest revision that refer to this asset. */
function templateConsumers(index: CatalogIndex, assetId: string): TemplateConsumer[] {
  const out: TemplateConsumer[] = [];
  for (const entry of Object.values(index.assets)) {
    if (entry.kind !== 'template' || entry.deletedAt) continue;
    const projection = headOf(entry)?.projection;
    if (projection?.kind !== 'template') continue;
    if (projection.entries.some((ref) => ref.blockId === assetId)) out.push({ templateId: entry.id, role: 'block' });
    if (projection.subagents.some((ref) => ref.subagentId === assetId)) out.push({ templateId: entry.id, role: 'subagent' });
    if (projection.skills.includes(assetId)) out.push({ templateId: entry.id, role: 'skill' });
    if (projection.mcps.includes(assetId)) out.push({ templateId: entry.id, role: 'mcp' });
  }
  return out.sort((a, b) => compareText(a.templateId, b.templateId) || compareText(a.role, b.role));
}

function subagentConsumers(index: CatalogIndex, assetId: string): string[] {
  return Object.values(index.assets)
    .filter((entry) => {
      if (entry.kind !== 'subagent' || entry.deletedAt) return false;
      const projection = headOf(entry)?.projection;
      return projection?.kind === 'subagent' && (
        projection.blocks.some((ref) => ref.blockId === assetId) || projection.skills.includes(assetId) || projection.mcps.includes(assetId)
      );
    })
    .map((entry) => entry.id)
    .sort(compareText);
}

function relationsOf(index: CatalogIndex, composition: AgentComposition, assetId: string): ConsumerRelation[] {
  const relations = new Set<ConsumerRelation>();
  const accepted = composition.template ? templateProjection(entryOf(index, composition.template.templateId), composition.template.acceptedRevision) : null;
  if (composition.template?.templateId === assetId) relations.add('base-template');
  if (composition.additions.includes(assetId)) relations.add('addition');

  const excludedEntries = new Set(composition.excludedEntryIds);
  for (const ref of accepted?.entries ?? []) {
    if (ref.blockId !== assetId) continue;
    const instance = composition.entries.find((entry) => entry.baseEntryId === ref.entryId);
    if (excludedEntries.has(ref.entryId)) relations.add('excluded');
    else if (instance?.source.kind === 'fork') relations.add('overridden');
    else relations.add('via-base');
  }
  for (const entry of composition.entries) {
    if (entry.source.blockId !== assetId) continue;
    relations.add(entry.source.kind === 'follow' ? 'direct' : 'own-entry');
  }

  const excludedSubagents = new Set(composition.excludedSubagentEntryIds);
  for (const ref of accepted?.subagents ?? []) {
    if (ref.subagentId !== assetId) continue;
    const instance = composition.subagents.find((entry) => entry.baseEntryId === ref.entryId);
    if (excludedSubagents.has(ref.entryId)) relations.add('excluded');
    else if (instance?.source.kind === 'fork') relations.add('overridden');
    else relations.add('via-base');
  }
  for (const entry of composition.subagents) {
    if (entry.source.subagentId === assetId) relations.add(entry.source.kind === 'follow' ? 'direct' : 'own-entry');
    const subagentId = subagentIdOf(entry, accepted);
    const subagent = subagentId ? entryOf(index, subagentId) : null;
    const projection = subagent && headOf(subagent)?.projection;
    if (projection?.kind === 'subagent' && (projection.blocks.some((ref) => ref.blockId === assetId) || projection.skills.includes(assetId) || projection.mcps.includes(assetId))) {
      relations.add('via-subagent');
    }
  }

  if (accepted?.skills.includes(assetId) || accepted?.mcps.includes(assetId)) {
    relations.add(composition.removals.includes(assetId) ? 'excluded' : 'via-base');
  }
  // A removal of something the base no longer carries still names the asset.
  if (relations.size === 0 && entryOf(index, assetId) && composition.removals.includes(assetId)) relations.add('excluded');
  return [...relations].sort(compareText) as ConsumerRelation[];
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
    if (entry.deletedAt || entry.source.kind !== 'copy' || entry.source.originAssetId !== assetId) continue;
    out.push({ assetId: entry.id, owner: entry.owner, originRevision: entry.source.originRevision });
  }
  return out.sort((a, b) => compareText(a.assetId, b.assetId));
}

/** Everything that refers to an asset. Exclusions and overrides are listed too, marked as not in effect. */
export function listConsumers(index: CatalogIndex, assetId: string): AssetConsumers {
  return {
    assetId,
    templates: templateConsumers(index, assetId),
    subagents: subagentConsumers(index, assetId),
    agents: agentConsumers(index, assetId),
    copies: copyConsumers(index, assetId),
  };
}

/** What stops a deletion: references that would dangle. An exclusion, or a copy's origin, wouldn't. */
export function hasHardReference(consumers: AssetConsumers): boolean {
  return consumers.templates.length > 0 || consumers.subagents.length > 0 || consumers.agents.some((agent) => agent.relations.some((relation) => relation !== 'excluded'));
}

// ── Impact ───────────────────────────────────────────────────────────────

function planStored(index: CatalogIndex, composition: AgentComposition, context: ImpactContext): CompositionPlan {
  return planComposition(index, {
    agentId: composition.agentId,
    composition,
    compositionRevision: composition.revision,
    // Impact asks where desired state would go, on what each consumer accepted. That doesn't decide when anyone adopts it.
    adoption: { content: { mode: 'takeable' }, structure: { mode: 'accepted' } },
    foreign: hasOwn(context.foreignByAgent ?? {}, composition.agentId) ? context.foreignByAgent![composition.agentId] : [],
  });
}

function plannedDestinations(plan: CompositionPlan): Array<{ assetId: string; revision: number; key: string }> {
  return [
    ...(plan.instructions?.blocks ?? []).map((item) => ({ assetId: item.assetId, revision: item.revision, key: INSTRUCTION_DESTINATION.key })),
    ...[...plan.skills, ...plan.mcpServers, ...plan.subagents].map((asset) => ({ assetId: asset.assetId, revision: asset.revision, key: asset.destination.key })),
  ];
}

function changesBetween(before: CompositionPlan, after: CompositionPlan): PlannedAssetChange[] {
  const was = new Map(plannedDestinations(before).map((asset) => [asset.assetId, asset]));
  const now = new Map(plannedDestinations(after).map((asset) => [asset.assetId, asset]));
  const changes: PlannedAssetChange[] = [];
  for (const assetId of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const from = was.get(assetId);
    const to = now.get(assetId);
    if (from?.revision === to?.revision && from?.key === to?.key) continue;
    changes.push({ assetId, fromRevision: from?.revision ?? null, toRevision: to?.revision ?? null, destination: (to ?? from)!.key });
  }
  return changes;
}

function heldAssetsOf(plan: CompositionPlan): string[] {
  const updates = [
    ...(plan.instructions?.blocks ?? []).map((item) => [item.assetId, item.update] as const),
    ...plan.subagents.map((item) => [item.assetId, item.update] as const),
    ...plan.subagents.flatMap((item) => item.blocks.map((nested) => [nested.assetId, nested.update] as const)),
  ];
  return [...new Set(updates.filter(([, update]) => update?.heldBy && !update.kept).map(([assetId]) => assetId))].sort(compareText);
}

/** The whole instruction list counts as one destination's content, by its exact order and revisions. */
function instructionContentOf(plan: CompositionPlan): string {
  return (plan.instructions?.blocks ?? []).map((item) => `${item.assetId}@${item.revision}`).join('\u0000');
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
  interface Group extends SharedDestination {
    contents: string[];
  }
  const groups = new Map<string, Group>();
  const add = (workspaceKey: string, destination: string, member: SharedDestination['agents'][number], content: string): void => {
    const key = `${workspaceKey}\u0000${collisionKey(destination)}`;
    const group = groups.get(key) ?? { workspaceKey, destination, agents: [], divergent: false, contents: [] };
    group.agents.push(member);
    group.contents.push(content);
    groups.set(key, group);
  };
  for (const plan of plans) {
    if (!hasOwn(workspaceByAgent, plan.agentId)) continue;
    const workspaceKey = workspaceByAgent[plan.agentId];
    for (const asset of [...plan.skills, ...plan.mcpServers, ...plan.subagents]) {
      add(workspaceKey, asset.destination.key, { agentId: plan.agentId, assetId: asset.assetId, revision: asset.revision }, `${asset.assetId}@${asset.revision}`);
    }
    for (const item of plan.instructions?.blocks ?? []) {
      add(workspaceKey, INSTRUCTION_DESTINATION.key, { agentId: plan.agentId, assetId: item.assetId, revision: item.revision }, instructionContentOf(plan));
    }
  }
  return [...groups.values()]
    .filter((group) => new Set(group.agents.map((agent) => agent.agentId)).size > 1)
    .map(({ contents, ...group }) => ({
      ...group,
      agents: [...group.agents].sort((a, b) => compareText(a.agentId, b.agentId) || compareText(a.assetId, b.assetId)),
      divergent: new Set(contents).size > 1,
    }))
    .sort((a, b) => compareText(a.workspaceKey, b.workspaceKey) || compareText(a.destination, b.destination));
}

interface ImpactSubject {
  assetId: string;
  fromRevision: number;
  toRevision: number;
  /** Everything being saved, so the fingerprint moves if any of it does. */
  contentHash: string;
  /** Other assets in the same publication, whose consumers count too. */
  alsoAffected?: readonly string[];
}

/**
 * What moving the catalog from `index` to `next` would do: every consumer, in
 * effect or not, what would change for it, what it would newly block, and what's
 * now waiting for it. Neither index is changed.
 */
export function previewCatalogChange(index: CatalogIndex, next: CatalogIndex, subject: ImpactSubject, context: ImpactContext = {}): AssetImpact {
  const assets = [subject.assetId, ...(subject.alsoAffected ?? [])];
  const before = assets.map((assetId) => listConsumers(index, assetId));
  const after = assets.map((assetId) => listConsumers(next, assetId));
  const consumerByAgent = new Map<string, AgentConsumer>();
  for (const consumer of [...before, ...after].flatMap((consumers) => consumers.agents)) {
    const existing = consumerByAgent.get(consumer.agentId);
    const relations = [...new Set([...(existing?.relations ?? []), ...consumer.relations])].sort(compareText) as ConsumerRelation[];
    consumerByAgent.set(consumer.agentId, {
      agentId: consumer.agentId,
      relations,
      effective: relations.some((relation) => !INEFFECTIVE.has(relation)),
    });
  }

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
      destinations: [...new Set(plannedDestinations(afterPlans[position]).map((asset) => asset.key))],
      held: heldAssetsOf(afterPlans[position]),
      structure: afterPlans[position].structure?.update ?? null,
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

  const unique = <T>(items: T[], key: (item: T) => string): T[] => [...new Map(items.map((item) => [key(item), item])).values()];
  // A template publishing its own blocks isn't a consumer anyone has to be told about.
  const templates = unique(after.flatMap((consumers) => consumers.templates), (item) => `${item.templateId}|${item.role}`)
    .filter((item) => item.templateId !== subject.assetId)
    .sort((a, b) => compareText(a.templateId, b.templateId) || compareText(a.role, b.role));
  const subagents = [...new Set(after.flatMap((consumers) => consumers.subagents))].sort(compareText);
  const copies = unique(before.flatMap((consumers) => consumers.copies), (item) => item.assetId).sort((a, b) => compareText(a.assetId, b.assetId));

  const impact = {
    assetId: subject.assetId,
    fromRevision: subject.fromRevision,
    toRevision: subject.toRevision,
    templates,
    subagents,
    agents,
    copies,
    sharedDestinations,
    blocked,
  };
  // Copies stay out: they don't change when the origin does, so a new one needn't invalidate a confirmation.
  const { copies: _copies, ...confirmed } = impact;
  return { ...impact, fingerprint: canonicalHash({ ...confirmed, contentHash: subject.contentHash }) };
}

/** Saving one candidate revision over an asset's head. The candidate isn't stored anywhere. */
export function previewAssetImpact(
  index: CatalogIndex,
  assetId: string,
  candidate: AssetRevisionRecord,
  context: ImpactContext = {},
): AssetImpact {
  const entry = index.assets[assetId];
  const next: CatalogIndex = {
    ...index,
    assets: { ...index.assets, [assetId]: { ...entry, headRevision: candidate.revision, revisions: [...entry.revisions, candidate] } },
  };
  return previewCatalogChange(index, next, {
    assetId,
    fromRevision: entry.headRevision,
    toRevision: candidate.revision,
    contentHash: candidate.contentHash,
  }, context);
}
