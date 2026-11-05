/**
 * What a template's update means for one instance (#2819's composition model).
 * Pure and deterministic. Two tracks:
 *
 * - Content: {@link takeableRevision}. Block history is linear, and a consumer
 *   can't move past a revision bundled with a template revision. Accepting that
 *   template is what moves its floor past the tag.
 * - Structure: {@link checkStructure}. A is the last accepted base order, B the
 *   new one, I the instance's. A revision is clean or the whole of it waits. There
 *   is no partial acceptance, and several revisions behind compares A with the
 *   latest only.
 *
 * Nothing here blocks a start: an instance with an unresolved update runs on what
 * it last accepted. Choices are applied whole or refused.
 */

import { ACCESS_LEVELS, DEFAULT_MAX_HELPERS, ORCHESTRATION_CONTROLS } from '../../../shared/orchestration-policy';
import type {
  BundledBy,
  CompositionInput,
  InstanceEntry,
  InstanceSubagent,
  StructureCheck,
  StructureChoice,
  StructureInput,
  StructureReason,
  SubagentSetCheck,
  SubagentSetInput,
  SubagentSetReason,
  TemplateOperationalDefaults,
  TemplateSwitchSelection,
  ValidationIssue,
} from '../../../shared/asset-catalog-types';
import { collisionKey } from './validation';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const baseKey = (entryId: string): string => `base:${entryId}`;
export const localKey = (localId: string): string => `local:${localId}`;

export function entryKeyOf(entry: { baseEntryId?: string | null; localId?: string | null }): string {
  return entry.baseEntryId ? baseKey(entry.baseEntryId) : localKey(entry.localId as string);
}

// ── Content ──────────────────────────────────────────────────────────────

interface HistoryRevision {
  revision: number;
  bundledBy?: BundledBy;
}

/**
 * The highest revision reachable from `floor` without crossing a bundled one.
 * An independent edit made on top of a bundled edit waits with it.
 */
export function takeableRevision(history: readonly HistoryRevision[], floor: number): number {
  let takeable = floor;
  for (const record of [...history].sort((a, b) => a.revision - b.revision)) {
    if (record.revision <= floor) continue;
    if (record.bundledBy) break;
    takeable = record.revision;
  }
  return takeable;
}

/**
 * {@link takeableRevision} for something that refers to other assets, such as a
 * subagent definition and its blocks. An independent revision can't pull a
 * bundled revision past this consumer's floor, so it stops there too.
 */
export function takeableThroughRefs<T extends HistoryRevision>(
  history: readonly T[],
  floor: number,
  crossedBy: (record: T) => BundledBy | null,
): { takeable: number; heldBy: BundledBy | null } {
  let takeable = floor;
  for (const record of [...history].sort((a, b) => a.revision - b.revision)) {
    if (record.revision <= floor) continue;
    if (record.bundledBy) return { takeable, heldBy: record.bundledBy };
    const crossed = crossedBy(record);
    if (crossed) return { takeable, heldBy: crossed };
    takeable = record.revision;
  }
  return { takeable, heldBy: null };
}

/** The first bundled revision above a floor, up to `upTo`: what's in the way, if anything is. */
export function firstBundleAbove(history: readonly HistoryRevision[], floor: number, upTo = Number.POSITIVE_INFINITY): BundledBy | null {
  const above = history.filter((record) => record.revision > floor && record.revision <= upTo).sort((a, b) => a.revision - b.revision);
  return above.find((record) => record.bundledBy)?.bundledBy ?? null;
}

// ── Order state ──────────────────────────────────────────────────────────

function indexMap(items: readonly string[]): Map<string, number> {
  return new Map(items.map((item, position) => [item, position]));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Whether an order differs from the base's, ignoring excluded entries. Exclusions and local entries count separately in the label. */
export function hasMovedEntries(acceptedIds: readonly string[], instanceBaseIds: readonly string[], excluded: readonly string[]): boolean {
  const skip = new Set(excluded);
  const present = new Set(instanceBaseIds);
  const a = acceptedIds.filter((id) => !skip.has(id) && present.has(id));
  const known = new Set(a);
  const i = instanceBaseIds.filter((id) => known.has(id));
  return a.some((id, position) => id !== i[position]);
}

interface Analysis {
  excluded: Set<string>;
  acceptedIds: string[];
  acceptedSet: Set<string>;
  targetIds: string[];
  targetSet: Set<string>;
  instance: StructureInput['instance'];
  positionInInstance: Map<string, number>;
  /** Base entries in I that A has. */
  baseEntries: Array<StructureInput['instance'][number]>;
  /** Of those, the ones B keeps. */
  retained: Array<StructureInput['instance'][number]>;
  movedPairs: Set<string>;
  movedKeys: Set<string>;
  positionInTarget: Map<string, number>;
  positionInAccepted: Map<string, number>;
}

function analyze(input: StructureInput): Analysis {
  const excluded = new Set(input.excluded);
  const acceptedIds = input.accepted.map((entry) => entry.entryId).filter((id) => !excluded.has(id));
  const targetIds = input.target.map((entry) => entry.entryId).filter((id) => !excluded.has(id));
  const acceptedSet = new Set(acceptedIds);
  const targetSet = new Set(targetIds);
  const instance = input.instance.filter((entry) => entry.baseEntryId === null || !excluded.has(entry.baseEntryId));
  const positionInInstance = indexMap(instance.map((entry) => entry.key));
  const positionInAccepted = indexMap(acceptedIds);
  const positionInTarget = indexMap(targetIds);
  const baseEntries = instance.filter((entry) => entry.baseEntryId !== null && acceptedSet.has(entry.baseEntryId));
  const retained = baseEntries.filter((entry) => targetSet.has(entry.baseEntryId as string));

  const movedPairs = new Set<string>();
  const movedKeys = new Set<string>();
  for (let i = 0; i < baseEntries.length; i++) {
    for (let j = i + 1; j < baseEntries.length; j++) {
      // i comes before j in the instance; moved if A has them the other way round.
      const first = baseEntries[i];
      const second = baseEntries[j];
      if ((positionInAccepted.get(first.baseEntryId as string) as number) > (positionInAccepted.get(second.baseEntryId as string) as number)) {
        movedPairs.add(pairKey(first.key, second.key));
        movedKeys.add(first.key);
        movedKeys.add(second.key);
      }
    }
  }
  return {
    excluded, acceptedIds, acceptedSet, targetIds, targetSet, instance, positionInInstance,
    baseEntries, retained, movedPairs, movedKeys, positionInTarget, positionInAccepted,
  };
}

function isPlaced(analysis: Analysis, entry: StructureInput['instance'][number]): boolean {
  return entry.baseEntryId === null || analysis.movedKeys.has(entry.key);
}

/** Pairs among retained entries whose relative order changed between A and B. */
function changedPairs(analysis: Analysis): Array<[StructureInput['instance'][number], StructureInput['instance'][number]]> {
  const pairs: Array<[StructureInput['instance'][number], StructureInput['instance'][number]]> = [];
  const { retained, positionInAccepted, positionInTarget } = analysis;
  for (let i = 0; i < retained.length; i++) {
    for (let j = i + 1; j < retained.length; j++) {
      const a = retained[i].baseEntryId as string;
      const b = retained[j].baseEntryId as string;
      const acceptedOrder = (positionInAccepted.get(a) as number) < (positionInAccepted.get(b) as number);
      const targetOrder = (positionInTarget.get(a) as number) < (positionInTarget.get(b) as number);
      if (acceptedOrder !== targetOrder) pairs.push([retained[i], retained[j]]);
    }
  }
  return pairs;
}

/** Whether anything local or moved sits strictly between two entries in I. */
function placedBetween(analysis: Analysis, a: string, b: string): boolean {
  const from = analysis.positionInInstance.get(a) as number;
  const to = analysis.positionInInstance.get(b) as number;
  const [low, high] = from < to ? [from, to] : [to, from];
  return analysis.instance.slice(low + 1, high).some((entry) => isPlaced(analysis, entry));
}

/** Runs of consecutive new entries in B, with the base neighbors either side. */
function newRuns(analysis: Analysis): Array<{ ids: string[]; before: string | null; after: string | null }> {
  const runs: Array<{ ids: string[]; before: string | null; after: string | null }> = [];
  let current: string[] = [];
  let before: string | null = null;
  for (const id of analysis.targetIds) {
    if (analysis.acceptedSet.has(id)) {
      if (current.length > 0) runs.push({ ids: current, before, after: id });
      current = [];
      before = id;
    } else {
      current.push(id);
    }
  }
  if (current.length > 0) runs.push({ ids: current, before, after: null });
  return runs;
}

/**
 * Nothing the person placed: no local entries and nothing moved. A fork isn't a
 * move, so forks alone still count. Such an instance passes the order rules
 * whatever the base does, since it has no order of its own to protect.
 */
function hasNothingPlaced(analysis: Analysis): boolean {
  return analysis.movedKeys.size === 0 && analysis.instance.every((entry) => entry.baseEntryId !== null);
}

/** B's order, with a fork the base removed staying after whatever it followed: only ever a suggestion, since that needs a choice. */
function baseOrderKeepingForks(analysis: Analysis): string[] {
  const order = analysis.targetIds.map(baseKey);
  analysis.instance.forEach((entry, position) => {
    if (!entry.forked || analysis.targetSet.has(entry.baseEntryId as string)) return;
    const previous = position > 0 ? order.indexOf(analysis.instance[position - 1].key) : -1;
    order.splice(previous + 1, 0, entry.key);
  });
  return order;
}

/**
 * The order the instance would have under B: changed pairs take B's order unless
 * the person placed something that makes that unsafe, each new run goes next to
 * its neighbor, and removed entries go, forks excepted. Always gives an answer:
 * when a revision isn't clean this is only the preview's suggestion.
 */
export function mergeOrder(input: StructureInput): string[] {
  const analysis = analyze(input);
  if (hasNothingPlaced(analysis)) return baseOrderKeepingForks(analysis);

  const { retained, positionInInstance, positionInTarget, movedPairs, targetSet } = analysis;
  const flips = new Set(
    changedPairs(analysis)
      .filter(([a, b]) => !movedPairs.has(pairKey(a.key, b.key)) && !placedBetween(analysis, a.key, b.key))
      .map(([a, b]) => pairKey(a.key, b.key)),
  );
  const precedes = (a: StructureInput['instance'][number], b: StructureInput['instance'][number]): boolean => (
    flips.has(pairKey(a.key, b.key))
      ? (positionInTarget.get(a.baseEntryId as string) as number) < (positionInTarget.get(b.baseEntryId as string) as number)
      : (positionInInstance.get(a.key) as number) < (positionInInstance.get(b.key) as number)
  );

  // A stable topological sort, earliest in the instance first. A cycle keeps the instance's own order.
  const remaining = [...retained];
  const sorted: typeof retained = [];
  while (remaining.length > 0) {
    const next = remaining.findIndex((candidate) => remaining.every((other) => other === candidate || !precedes(other, candidate)));
    if (next < 0) {
      sorted.length = 0;
      sorted.push(...retained);
      break;
    }
    sorted.push(remaining.splice(next, 1)[0]);
  }

  // Retained entries fill the slots retained entries held, so everything placed stays where it was.
  let slot = 0;
  const order: string[] = [];
  for (const entry of analysis.instance) {
    if (entry.baseEntryId === null) order.push(entry.key);
    else if (targetSet.has(entry.baseEntryId) && analysis.acceptedSet.has(entry.baseEntryId)) order.push(sorted[slot++].key);
    else if (entry.forked) order.push(entry.key);
  }

  for (const run of newRuns(analysis)) {
    const keys = run.ids.map(baseKey);
    const after = run.before !== null ? order.indexOf(baseKey(run.before)) : -1;
    const before = run.after !== null ? order.indexOf(baseKey(run.after)) : -1;
    const at = after >= 0 ? after + 1 : run.before === null && before >= 0 ? before : order.length;
    order.splice(at, 0, ...keys);
  }
  return order;
}

function neighborsOf(order: readonly string[], key: string): [string | null, string | null] {
  const at = order.indexOf(key);
  return [order[at - 1] ?? null, order[at + 1] ?? null];
}

/** The four rules, then Correction 1, then a check that the merge really is B's order for everything unplaced. */
export function checkStructure(input: StructureInput): StructureCheck {
  const analysis = analyze(input);
  const reasons: StructureReason[] = [];
  const order = mergeOrder(input);
  const { instance, positionInInstance, movedPairs, movedKeys, targetSet, acceptedSet, targetIds } = analysis;

  // Removing a fork always needs a choice: keep it or let it go.
  for (const entry of analysis.baseEntries) {
    if (entry.forked && !targetSet.has(entry.baseEntryId as string)) reasons.push({ code: 'removed_forked', entries: [entry.key] });
  }

  if (!hasNothingPlaced(analysis)) {
    for (const [a, b] of changedPairs(analysis)) {
      if (movedPairs.has(pairKey(a.key, b.key)) || placedBetween(analysis, a.key, b.key)) {
        reasons.push({ code: 'reorder_conflict', entries: [a.key, b.key].sort(compareText) });
      }
    }

    for (const run of newRuns(analysis)) {
      const p = run.before !== null ? positionInInstance.get(baseKey(run.before)) : undefined;
      const s = run.after !== null ? positionInInstance.get(baseKey(run.after)) : undefined;
      const adjacent = run.before !== null && run.after !== null
        ? p !== undefined && s !== undefined && s === p + 1
        : run.before === null && run.after !== null
          ? s === 0
          : run.before !== null
            ? p === instance.length - 1
            : instance.length === 0;
      if (!adjacent) reasons.push({ code: 'add_position', entries: run.ids.map(baseKey) });
    }

    for (const entry of analysis.baseEntries) {
      if (targetSet.has(entry.baseEntryId as string)) continue;
      if (movedKeys.has(entry.key)) reasons.push({ code: 'removed_moved', entries: [entry.key] });
      const at = positionInInstance.get(entry.key) as number;
      const beside = [instance[at - 1], instance[at + 1]].some((neighbor) => neighbor && neighbor.baseEntryId === null);
      if (beside) reasons.push({ code: 'removed_beside_local', entries: [entry.key] });
    }

    for (const entry of instance) {
      // Something removed has no neighbors left to keep: its own rule above speaks for it.
      if (!isPlaced(analysis, entry) || !order.includes(entry.key)) continue;
      const before = neighborsOf(instance.map((item) => item.key), entry.key);
      const after = neighborsOf(order, entry.key);
      if (before[0] !== after[0] || before[1] !== after[1]) reasons.push({ code: 'neighbors_changed', entries: [entry.key] });
    }

    const positionInOrder = indexMap(order);
    const inBase = targetIds.filter((id) => positionInOrder.has(baseKey(id)) && !movedKeys.has(baseKey(id)));
    for (let i = 0; i < inBase.length; i++) {
      for (let j = i + 1; j < inBase.length; j++) {
        if ((positionInOrder.get(baseKey(inBase[i])) as number) > (positionInOrder.get(baseKey(inBase[j])) as number)) {
          reasons.push({ code: 'order_unverified', entries: [baseKey(inBase[i]), baseKey(inBase[j])] });
        }
      }
    }
  }

  // Identity holds for everyone, against how things stand afterwards: what the revision removes no longer
  // counts, and a followed entry the base points elsewhere is its new block, so a swap isn't a clash.
  const targetById = new Map(input.target.map((entry) => [entry.entryId, entry]));
  const after = instance
    .filter((entry) => entry.baseEntryId === null || targetSet.has(entry.baseEntryId))
    .map((entry) => {
      const target = entry.baseEntryId !== null && !entry.forked ? targetById.get(entry.baseEntryId) : undefined;
      return target ? { key: entry.key, sources: [target.blockId], name: target.name } : { key: entry.key, sources: entry.sources, name: entry.name };
    });
  const clashes = (key: string, blockId: string, name: string): boolean => after.some((other) => (
    other.key !== key && (other.sources.includes(blockId) || collisionKey(other.name) === collisionKey(name))
  ));
  const acceptedBlocks = new Map(input.accepted.map((entry) => [entry.entryId, entry.blockId]));
  for (const entry of input.target) {
    if (analysis.excluded.has(entry.entryId)) continue;
    const key = baseKey(entry.entryId);
    const was = acceptedBlocks.get(entry.entryId);
    const isNew = !acceptedSet.has(entry.entryId);
    // A new entry, or one the base pointed at another block. A fork keeps its own.
    const repointed = !isNew && was !== entry.blockId && !instance.find((other) => other.key === key)?.forked;
    if ((isNew || repointed) && clashes(key, entry.blockId, entry.name)) reasons.push({ code: 'identity_conflict', entries: [key] });
  }

  const unique = new Map(reasons.map((reason) => [`${reason.code}|${reason.entries.join(',')}`, reason]));
  return {
    clean: unique.size === 0,
    reasons: [...unique.entries()].sort(([a], [b]) => compareText(a, b)).map(([, reason]) => reason),
    order,
    reAddedExcluded: input.target
      .filter((entry) => analysis.excluded.has(entry.entryId) && !input.accepted.some((accepted) => accepted.entryId === entry.entryId))
      .map((entry) => entry.entryId)
      .sort(compareText),
  };
}

// ── Operational defaults ─────────────────────────────────────────────────

const ACCESS_RANK = new Map<string, number>(ACCESS_LEVELS.map((level, rank) => [level, rank]));
const TOP_ACCESS = ACCESS_LEVELS.length - 1;

/**
 * Whether access goes up. Null means it isn't known from here: `same`, or the
 * agent's own setting. Going to something unknown is a rise unless it was already
 * the most it could be, and coming from it unless it's now the least.
 */
function accessRaised(from: number | null, to: number | null): boolean {
  if (from === null && to === null) return false;
  if (to === null) return from !== TOP_ACCESS;
  if (from === null) return to !== 0;
  return to > from;
}

const accessRank = (value: string | undefined): number | null => (value === undefined ? null : ACCESS_RANK.get(value) ?? null);

/**
 * The defaults a template revision raises: more access, more orchestration, fewer
 * questions, more helpers. Each needs a person. A decrease can stay clean. A field
 * left out reads as what it falls back to, so taking one away can raise it too.
 */
export function operationalIncreases(
  from: TemplateOperationalDefaults | undefined,
  to: TemplateOperationalDefaults | undefined,
): Array<keyof TemplateOperationalDefaults> {
  const was = from ?? {};
  const now = to ?? {};
  // Listed most careful first, and hands-off is what an unset control means.
  const controlRank = (value: string | undefined): number => ORCHESTRATION_CONTROLS.length - 1 - ORCHESTRATION_CONTROLS.indexOf((value ?? 'hands-off') as typeof ORCHESTRATION_CONTROLS[number]);
  const raised: Array<keyof TemplateOperationalDefaults> = [];
  if (accessRaised(accessRank(was.agentAccess), accessRank(now.agentAccess))) raised.push('agentAccess');
  if (accessRaised(accessRank(was.access), accessRank(now.access))) raised.push('access');
  if (controlRank(now.control) > controlRank(was.control)) raised.push('control');
  if ((now.maxHelpers ?? DEFAULT_MAX_HELPERS) > (was.maxHelpers ?? DEFAULT_MAX_HELPERS)) raised.push('maxHelpers');
  for (const key of ['orchestrate', 'crossProjectHelpers', 'connectToDispatcher', 'autoHelpers'] as const) {
    if (now[key] && !was[key]) raised.push(key);
  }
  return raised;
}

// ── Native subagent set ──────────────────────────────────────────────────

/** Keyed by stable id, with no order and no pair logic. Same follow, fork, exclude and local rules. */
export function checkSubagentSet(input: SubagentSetInput): SubagentSetCheck {
  const excluded = new Set(input.excluded);
  const acceptedIds = new Set(input.accepted.map((entry) => entry.entryId));
  const targetById = new Map(input.target.map((entry) => [entry.entryId, entry]));
  const reasons: SubagentSetReason[] = [];
  const foreign = new Set((input.foreignNames ?? []).map(collisionKey));

  const instance = input.instance.filter((entry) => entry.baseEntryId === null || !excluded.has(entry.baseEntryId));
  const added = input.target.filter((entry) => !acceptedIds.has(entry.entryId) && !excluded.has(entry.entryId));
  const removedEntries = instance.filter((entry) => entry.baseEntryId !== null && !targetById.has(entry.baseEntryId));
  for (const entry of removedEntries) {
    if (entry.forked) reasons.push({ code: 'removed_forked', entries: [entry.key] });
  }

  // What's held afterwards: forks keep their own name, and followed entries take the new one.
  const staying = instance.filter((entry) => !(entry.baseEntryId !== null && !targetById.has(entry.baseEntryId) && !entry.forked));
  const nameAfter = (entry: typeof instance[number]): string => (
    entry.baseEntryId !== null && !entry.forked ? (targetById.get(entry.baseEntryId) as { name: string }).name : entry.name
  );

  for (const entry of added) {
    const name = collisionKey(entry.name);
    if (staying.some((other) => collisionKey(nameAfter(other)) === name)) reasons.push({ code: 'name_collision', entries: [baseKey(entry.entryId)] });
    if (foreign.has(name)) reasons.push({ code: 'foreign_name_collision', entries: [baseKey(entry.entryId)] });
  }

  for (const entry of staying) {
    if (entry.baseEntryId === null || entry.forked) continue;
    const name = collisionKey(nameAfter(entry));
    if (name === collisionKey(entry.name)) continue;
    const onto = staying.some((other) => other !== entry && collisionKey(nameAfter(other)) === name);
    if (onto) reasons.push({ code: 'renamed_onto_existing', entries: [entry.key] });
    if (foreign.has(name)) reasons.push({ code: 'foreign_name_collision', entries: [entry.key] });
  }

  for (const entryId of input.reviewEntries ?? []) reasons.push({ code: 'review_fields', entries: [baseKey(entryId)] });

  const unique = new Map(reasons.map((reason) => [`${reason.code}|${reason.entries.join(',')}`, reason]));
  return {
    clean: unique.size === 0,
    reasons: [...unique.entries()].sort(([a], [b]) => compareText(a, b)).map(([, reason]) => reason),
    added: added.map((entry) => baseKey(entry.entryId)).sort(compareText),
    removed: removedEntries.map((entry) => entry.key).sort(compareText),
    reAddedExcluded: input.target
      .filter((entry) => excluded.has(entry.entryId) && !acceptedIds.has(entry.entryId))
      .map((entry) => entry.entryId)
      .sort(compareText),
  };
}

// ── Applying ─────────────────────────────────────────────────────────────

interface TargetRefs {
  templateId: string;
  revision: number;
  entryIds: readonly string[];
  subagentIds: readonly string[];
}

/** A followed entry the base no longer has keeps following its block, directly, from the revision it had. */
function keptEntry(entry: InstanceEntry, blockId: string): InstanceEntry {
  const localId = entry.baseEntryId as string;
  return entry.source.kind === 'follow' ? { localId, source: { kind: 'follow', blockId } } : { localId, source: entry.source };
}

function keptSubagent(entry: InstanceSubagent, subagentId: string): InstanceSubagent {
  const localId = entry.baseEntryId as string;
  return entry.source.kind === 'follow' ? { localId, source: { kind: 'follow', subagentId } } : { localId, source: entry.source };
}

/** A clean revision's result: the merged order, new entries following, removed ones gone. */
export function applyCleanUpdate(composition: CompositionInput, target: TargetRefs, order: readonly string[]): CompositionInput {
  const byKey = new Map(composition.entries.map((entry) => [entryKeyOf(entry), entry]));
  const entries = order.map((key): InstanceEntry => (
    byKey.get(key) ?? { baseEntryId: key.slice('base:'.length), source: { kind: 'follow' } }
  ));
  return {
    ...composition,
    template: { templateId: target.templateId, acceptedRevision: target.revision },
    entries,
    subagents: mergedSubagents(composition, target),
  };
}

function mergedSubagents(composition: CompositionInput, target: TargetRefs): InstanceSubagent[] {
  const targetIds = new Set(target.subagentIds);
  const excluded = new Set(composition.excludedSubagentEntryIds);
  const present = new Set(composition.subagents.map((entry) => entry.baseEntryId).filter(Boolean));
  const kept = composition.subagents.filter((entry) => !entry.baseEntryId || targetIds.has(entry.baseEntryId) || entry.source.kind === 'fork');
  const added = target.subagentIds
    .filter((id) => !excluded.has(id) && !present.has(id))
    .map((baseEntryId): InstanceSubagent => ({ baseEntryId, source: { kind: 'follow' } }));
  return sortSubagents([...kept, ...added]);
}

export function sortSubagents(subagents: readonly InstanceSubagent[]): InstanceSubagent[] {
  return [...subagents].sort((a, b) => compareText(entryKeyOf(a), entryKeyOf(b)));
}

export interface ChoiceContext {
  /** The block and subagent each accepted base entry refers to, for keeping one the base removed. */
  acceptedBlocks: Readonly<Record<string, { assetId: string; revision: number }>>;
  acceptedSubagents: Readonly<Record<string, { assetId: string; revision: number }>>;
}

/** A person's answer, applied whole. Anything unaccounted for refuses all of it. */
export function applyStructureChoice(
  composition: CompositionInput,
  target: TargetRefs,
  choice: StructureChoice,
  context: ChoiceContext,
): { ok: true; composition: CompositionInput } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const invalid = (path: string): void => {
    issues.push({ code: 'invalid_choice', path });
  };

  if (!Array.isArray(choice.order)) return { ok: false, issues: [{ code: 'invalid_choice', path: 'order' }] };
  const order = choice.order;
  const inOrder = new Set(order);
  if (inOrder.size !== order.length) invalid('order');
  const excludeBase = new Set(choice.excludeBaseEntries ?? []);
  const keepRemoved = new Set(choice.keepRemoved ?? []);
  const dropRemoved = new Set(choice.dropRemoved ?? []);
  const dropLocal = new Set(choice.dropLocal ?? []);
  const targetIds = new Set(target.entryIds);
  const excludedBefore = new Set(composition.excludedEntryIds);
  const current = new Map(composition.entries.map((entry) => [entryKeyOf(entry), entry]));

  // Every entry the new base has, unless it's excluded, either before or by this choice.
  for (const id of target.entryIds) {
    const key = baseKey(id);
    const excluded = excludedBefore.has(id) || excludeBase.has(key);
    if (inOrder.has(key) === excluded) invalid(`entry:${key}`);
  }
  // Everything else here: kept or removed, explicitly.
  for (const [key, entry] of current) {
    if (entry.baseEntryId) {
      if (targetIds.has(entry.baseEntryId)) continue;
      if (inOrder.has(key) !== keepRemoved.has(key)) invalid(`entry:${key}`);
      if (entry.source.kind === 'fork' && keepRemoved.has(key) === dropRemoved.has(key)) invalid(`entry:${key}`);
    } else if (inOrder.has(key) === dropLocal.has(key)) {
      invalid(`entry:${key}`);
    }
  }
  for (const key of order) {
    const knownBase = key.startsWith('base:') && targetIds.has(key.slice('base:'.length));
    if (!current.has(key) && !knownBase) invalid(`entry:${key}`);
  }
  for (const key of keepRemoved) {
    const id = key.slice('base:'.length);
    const removedByBase = key.startsWith('base:') && current.has(key) && !targetIds.has(id);
    // It becomes a local entry under its own id, which has to be free.
    if (!removedByBase || !context.acceptedBlocks[id] || current.has(localKey(id))) invalid(`keepRemoved:${key}`);
  }
  for (const key of excludeBase) {
    if (!key.startsWith('base:') || !targetIds.has(key.slice('base:'.length))) invalid(`excludeBaseEntries:${key}`);
  }
  for (const key of dropLocal) {
    if (!key.startsWith('local:') || !current.has(key)) invalid(`dropLocal:${key}`);
  }

  // The subagent set, the same way.
  const choiceSubagents = choice.subagents ?? {};
  const subagentTargets = new Set(target.subagentIds);
  const excludeSubagents = new Set(choiceSubagents.excludeBaseEntries ?? []);
  const keepSubagents = new Set(choiceSubagents.keepRemoved ?? []);
  const dropRemovedSubagents = new Set(choiceSubagents.dropRemoved ?? []);
  const dropSubagents = new Set(choiceSubagents.dropLocal ?? []);
  const currentSubagents = new Map(composition.subagents.map((entry) => [entryKeyOf(entry), entry]));
  for (const key of excludeSubagents) {
    if (!key.startsWith('base:') || !subagentTargets.has(key.slice('base:'.length))) invalid(`subagents.excludeBaseEntries:${key}`);
  }
  for (const key of keepSubagents) {
    const entry = currentSubagents.get(key);
    if (!entry?.baseEntryId || subagentTargets.has(entry.baseEntryId) || !context.acceptedSubagents[entry.baseEntryId]) invalid(`subagents.keepRemoved:${key}`);
  }
  for (const key of dropSubagents) {
    if (!key.startsWith('local:') || !currentSubagents.has(key)) invalid(`subagents.dropLocal:${key}`);
  }
  // A fork the base removed is someone's work: keep it or drop it by name, as for blocks.
  for (const [key, entry] of currentSubagents) {
    if (!entry.baseEntryId || subagentTargets.has(entry.baseEntryId) || entry.source.kind !== 'fork') continue;
    if (keepSubagents.has(key) === dropRemovedSubagents.has(key)) invalid(`subagents.entry:${key}`);
  }
  if (issues.length > 0) return { ok: false, issues };

  const floors = { ...composition.floors };
  const entries = order.map((key): InstanceEntry => {
    const entry = current.get(key);
    if (!entry) return { baseEntryId: key.slice('base:'.length), source: { kind: 'follow' } };
    if (!keepRemoved.has(key)) return entry;
    const ref = context.acceptedBlocks[entry.baseEntryId as string];
    floors[ref.assetId] = Math.max(floors[ref.assetId] ?? 0, ref.revision);
    return keptEntry(entry, ref.assetId);
  });

  const subagents: InstanceSubagent[] = [];
  for (const [key, entry] of currentSubagents) {
    if (dropSubagents.has(key)) continue;
    if (entry.baseEntryId && !subagentTargets.has(entry.baseEntryId)) {
      if (!keepSubagents.has(key)) continue;
      const ref = context.acceptedSubagents[entry.baseEntryId];
      floors[ref.assetId] = Math.max(floors[ref.assetId] ?? 0, ref.revision);
      subagents.push(keptSubagent(entry, ref.assetId));
    } else if (!excludeSubagents.has(key)) {
      subagents.push(entry);
    }
  }
  const excludedSubagents = new Set(composition.excludedSubagentEntryIds);
  for (const key of excludeSubagents) excludedSubagents.add(key.slice('base:'.length));
  for (const id of target.subagentIds) {
    if (!excludedSubagents.has(id) && !currentSubagents.has(baseKey(id))) subagents.push({ baseEntryId: id, source: { kind: 'follow' } });
  }

  return {
    ok: true,
    composition: {
      ...composition,
      template: { templateId: target.templateId, acceptedRevision: target.revision },
      entries,
      excludedEntryIds: [...new Set([...composition.excludedEntryIds, ...[...excludeBase].map((key) => key.slice('base:'.length))])].sort(compareText),
      subagents: sortSubagents(subagents),
      excludedSubagentEntryIds: [...excludedSubagents].sort(compareText),
      floors,
      authorityApprovals: { ...composition.authorityApprovals, ...(choice.authorityApprovals ?? {}) },
    },
  };
}

/** A new instance of a template, following everything. */
export function instanceFromTemplate(target: TargetRefs): CompositionInput {
  return {
    template: { templateId: target.templateId, acceptedRevision: target.revision },
    entries: target.entryIds.map((baseEntryId): InstanceEntry => ({ baseEntryId, source: { kind: 'follow' } })),
    excludedEntryIds: [],
    subagents: sortSubagents(target.subagentIds.map((baseEntryId): InstanceSubagent => ({ baseEntryId, source: { kind: 'follow' } }))),
    excludedSubagentEntryIds: [],
    additions: [],
    removals: [],
    floors: {},
    keepMarkers: {},
    authorityApprovals: {},
  };
}

/**
 * Template switch: a replace, not a merge. The new base as it stands, then what
 * was selected, in the order it had, as local entries since their slots belonged
 * to the old template. Identity, session and wires hang off the agent id, not this.
 */
export function switchTemplate(
  composition: CompositionInput,
  target: TargetRefs,
  selection: TemplateSwitchSelection,
  context: ChoiceContext,
): { ok: true; composition: CompositionInput } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const entryKeys = new Set(selection.entries ?? []);
  const subagentKeys = new Set(selection.subagents ?? []);
  const known = new Set(composition.entries.map(entryKeyOf));
  const knownSubagents = new Set(composition.subagents.map(entryKeyOf));
  for (const key of entryKeys) if (!known.has(key)) issues.push({ code: 'invalid_choice', path: `entries:${key}` });
  for (const key of subagentKeys) if (!knownSubagents.has(key)) issues.push({ code: 'invalid_choice', path: `subagents:${key}` });
  for (const id of selection.additions ?? []) if (!composition.additions.includes(id)) issues.push({ code: 'invalid_choice', path: `additions:${id}` });
  for (const id of selection.removals ?? []) if (!composition.removals.includes(id)) issues.push({ code: 'invalid_choice', path: `removals:${id}` });
  for (const id of selection.excludeEntries ?? []) if (!target.entryIds.includes(id)) issues.push({ code: 'invalid_choice', path: `excludeEntries:${id}` });
  for (const id of selection.excludeSubagents ?? []) if (!target.subagentIds.includes(id)) issues.push({ code: 'invalid_choice', path: `excludeSubagents:${id}` });
  if (issues.length > 0) return { ok: false, issues };

  const next = instanceFromTemplate(target);
  const excludeEntries = new Set(selection.excludeEntries ?? []);
  const excludeSubagents = new Set(selection.excludeSubagents ?? []);
  const floors: Record<string, number> = {};
  const carriedEntries = composition.entries.filter((entry) => entryKeys.has(entryKeyOf(entry))).map((entry): InstanceEntry => {
    if (!entry.baseEntryId) {
      if (entry.source.kind === 'follow' && entry.source.blockId && composition.floors[entry.source.blockId] !== undefined) {
        floors[entry.source.blockId] = composition.floors[entry.source.blockId];
      }
      return entry;
    }
    const ref = context.acceptedBlocks[entry.baseEntryId];
    if (entry.source.kind === 'follow') floors[ref.assetId] = Math.max(composition.floors[ref.assetId] ?? 0, ref.revision);
    return keptEntry(entry, ref?.assetId);
  });
  const carriedSubagents = composition.subagents.filter((entry) => subagentKeys.has(entryKeyOf(entry))).map((entry): InstanceSubagent => {
    if (!entry.baseEntryId) {
      if (entry.source.kind === 'follow' && entry.source.subagentId && composition.floors[entry.source.subagentId] !== undefined) {
        floors[entry.source.subagentId] = composition.floors[entry.source.subagentId];
      }
      return entry;
    }
    const ref = context.acceptedSubagents[entry.baseEntryId];
    if (entry.source.kind === 'follow') floors[ref.assetId] = Math.max(composition.floors[ref.assetId] ?? 0, ref.revision);
    return keptSubagent(entry, ref?.assetId);
  });

  return {
    ok: true,
    composition: {
      ...next,
      entries: [...next.entries.filter((entry) => !excludeEntries.has(entry.baseEntryId as string)), ...carriedEntries],
      excludedEntryIds: [...excludeEntries].sort(compareText),
      subagents: sortSubagents([...next.subagents.filter((entry) => !excludeSubagents.has(entry.baseEntryId as string)), ...carriedSubagents]),
      excludedSubagentEntryIds: [...excludeSubagents].sort(compareText),
      additions: composition.additions.filter((id) => selection.additions?.includes(id)),
      removals: [...new Set([...composition.removals.filter((id) => selection.removals?.includes(id)), ...(selection.removeBaseAssets ?? [])])].sort(compareText),
      floors,
      authorityApprovals: selection.authorityApprovals ?? {},
    },
  };
}
