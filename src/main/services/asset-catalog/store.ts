/**
 * The installation-local asset catalog (#2737, with the composition model on
 * #2819), under the Clubhouse base dir:
 *
 *   asset-catalog/catalog.json                   the index: entries, compositions, run records
 *   asset-catalog/revisions/<asset>/<n>.json     one immutable payload per revision
 *
 * A write puts any payload files in place first, then replaces the index with a
 * temp file and rename, and only that rename commits. A crash before it leaves
 * files nothing refers to and the catalog as it was; the next save of that
 * revision number replaces them. Every write checks expected revisions against
 * what's on disk, one at a time, so nothing is last-write-wins. A publication
 * writes many payloads and still commits with one rename, so a reader sees all of
 * it or none, and never a tagged revision before its template.
 *
 * Reads never write, and a missing catalog reads as empty without creating it.
 * An index that won't parse fails explicitly and is left alone: continuing empty
 * would let the next save replace it, and with it every agent's composition.
 *
 * Not a settings-store store: that writes in place and has no expected revision.
 * Writes report to the settings audit by id alone, and refusals too. Instruction
 * text never reaches a log, an error or the index. Asset and composition writes
 * are refused from agent surfaces: agents can't create, edit, delete or copy
 * assets, and agent assignment arrives with grants (#2738).
 */

import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  ASSET_CATALOG_VERSION,
  type ActivationPlan,
  type AgentComposition,
  type AssetCatalogErrorCode,
  type AssetImpact,
  type AssetKind,
  type AssetOwner,
  type AssetPayload,
  type AssetPreview,
  type AssetProjection,
  type AssetRevisionRecord,
  type AssetSource,
  type BaseAdoption,
  type BlockAssetPayload,
  type BundledAssetKind,
  type CatalogEntry,
  type CatalogIndex,
  type CompositionInput,
  type CompositionPlan,
  type CopyableAssetKind,
  type ForeignDestination,
  type ImpactContext,
  type OriginStatus,
  type RunRecord,
  type StructureBinding,
  type StructureCheck,
  type StructureChoice,
  type SubagentSetCheck,
  type TemplateOperationalDefaults,
  type TemplateSwitchSelection,
  type ValidationIssue,
} from '../../../shared/asset-catalog-types';
import { persist } from '../../telemetry/persist';
import { getBaseDirPath } from '../base-dir';
import { pathExists } from '../fs-utils';
import { appLog } from '../log-service';
import { appendSettingsAudit, auditChanged, currentSettingsOrigin } from '../settings-audit';
import {
  acceptedRefsOf,
  canonicalHash,
  emptyComposition,
  hasHardReference,
  instanceFingerprint,
  listConsumers,
  originStatusOf,
  planComposition,
  previewAssetImpact,
  previewCatalogChange,
  structureInput,
  subagentSetInput,
  templateTargetOf,
} from './planner';
import {
  applyCleanUpdate,
  applyStructureChoice,
  checkStructure,
  checkSubagentSet,
  operationalIncreases,
  switchTemplate as switchedComposition,
} from './structure';
import { composeInstructions, type ComposedInstructions } from './composer';
import {
  collisionKey,
  hasOwn,
  isAssetId,
  isCatalogId,
  nameIssues,
  ownerIssues,
  previewPayload,
  projectionOf,
  sourceIssues,
  validateComposition,
  validatePayload,
} from './validation';

export class AssetCatalogError extends Error {
  constructor(
    readonly code: AssetCatalogErrorCode,
    readonly details: {
      issues?: readonly ValidationIssue[];
      expected?: unknown;
      current?: unknown;
      plan?: CompositionPlan;
      impact?: AssetImpact;
      assetId?: string;
      check?: StructureCheck;
      subagentCheck?: SubagentSetCheck;
      operationalIncreases?: readonly string[];
    } = {},
  ) {
    // The code alone: messages get logged, and a value never belongs in one.
    super(code);
    this.name = 'AssetCatalogError';
  }
}

export function assetCatalogDir(): string {
  return path.join(getBaseDirPath(), 'asset-catalog');
}

const INDEX_FILE = 'catalog.json';
/**
 * One turn at a time per catalog, in this process. Other processes are kept out by
 * the app's single-instance lock, and a dev build's base dir differs from a packaged one's.
 */
const writeQueues = new Map<string, Promise<unknown>>();
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 50;

/** Windows refuses a rename while something, often a virus scanner, holds the target open for a moment. */
async function renameWithRetry(rename: (from: string, to: string) => Promise<void>, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}

function emptyIndex(): CatalogIndex {
  return { version: ASSET_CATALOG_VERSION, assets: {}, compositions: {}, runs: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Enough to trust the index's structure. An asset id becomes a directory name, so a tampered one can't escape the catalog. */
function isEntryShape(key: string, entry: unknown): boolean {
  return isAssetId(key) && isRecord(entry) && entry.id === key && typeof entry.headRevision === 'number' && Array.isArray(entry.revisions);
}

function isCompositionShape(composition: unknown): boolean {
  return isRecord(composition) && Array.isArray(composition.entries) && Array.isArray(composition.subagents)
    && Array.isArray(composition.additions) && Array.isArray(composition.removals) && isRecord(composition.floors);
}

/** Agent-facing ways in. A user's are `ui` and `mobile`; `persona` and `system` are Clubhouse acting for one. */
const AGENT_SURFACES = new Set(['mcp', 'cli', 'dispatcher']);

function isUserWritePermitted(): boolean {
  const { surface, actorId } = currentSettingsOrigin();
  return !actorId && !AGENT_SURFACES.has(surface);
}

export interface AssetCatalogStoreOptions {
  dir: string;
  now?: () => string;
  newId?: () => string;
  /** For tests: fail or stall the rename that commits a write. */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface PlanRequest {
  agentId: string;
  /** The project this agent is planned under, for project-owned assets. */
  projectId?: string;
  adoption: BaseAdoption;
  /** The composition to preview. Without it, what's stored. */
  draft?: unknown;
  foreign?: readonly ForeignDestination[];
}

/** One asset in a publication. `expectedRevision` 0 creates it, under an id from `mintAssetId`. */
export interface PublicationWrite {
  assetId: string;
  kind: BundledAssetKind;
  expectedRevision: number;
  payload: unknown;
  /** New assets only. */
  name?: string;
  owner?: AssetOwner;
  source?: AssetSource;
}

export interface PublicationRequest {
  templateId: string;
  /** 0 creates the template. */
  expectedRevision: number;
  /** New templates only. */
  name?: string;
  owner?: AssetOwner;
  source?: AssetSource;
  /** Every one gets `bundledBy` naming the new template revision, which has to refer to it. */
  writes: readonly PublicationWrite[];
  /** The new template revision, referring to writes at `expectedRevision + 1`. */
  payload: unknown;
  context?: ImpactContext;
}

/** A built-in's definition, as Clubhouse ships it. */
export interface BuiltinInstall {
  assetId: string;
  kind: AssetKind;
  name: string;
  builtinId: string;
  expectedRevision: number;
  payload: unknown;
}

const builtinInstallers = new WeakMap<object, (input: BuiltinInstall) => Promise<CatalogEntry>>();

/**
 * The only way to write a built-in, and the only way into Clubhouse's reserved
 * namespaces. Not on the store, so nothing that hands out the store's API can reach
 * it. Clubhouse itself only: refused from any surface a person or agent comes in on.
 */
export function installBuiltinAsset(store: object, input: BuiltinInstall): Promise<CatalogEntry> {
  const install = builtinInstallers.get(store);
  if (!install) throw new TypeError('not an asset catalog store');
  return install(input);
}

export type AssetCatalogStore = ReturnType<typeof createAssetCatalogStore>;

export function createAssetCatalogStore(options: AssetCatalogStoreOptions) {
  const { dir } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => `asset-${randomUUID()}`);
  const rename = options.rename ?? fsp.rename;

  const indexPath = path.join(dir, INDEX_FILE);
  const revisionsDir = path.join(dir, 'revisions');
  const revisionPath = (assetId: string, revision: number): string => path.join(revisionsDir, assetId, `${revision}.json`);

  // By directory, not by instance: two stores on one catalog take turns, so neither commits over the other.
  const queueKey = path.resolve(dir);
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = (writeQueues.get(queueKey) ?? Promise.resolve()).catch((): void => undefined).then(fn);
    writeQueues.set(queueKey, run.catch((): void => undefined));
    return run;
  };

  async function writeAtomically(file: string, body: string): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
    try {
      const handle = await fsp.open(tmp, 'w');
      try {
        await handle.writeFile(body, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(rename, tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch((): void => undefined);
      throw err;
    }
  }

  async function loadIndex(): Promise<CatalogIndex> {
    let raw: string;
    try {
      raw = await fsp.readFile(indexPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
      throw err;
    }
    const corrupt = (): AssetCatalogError => {
      persist.recovery('asset_catalog', 'primary_corrupt');
      return new AssetCatalogError('catalog_corrupt');
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corrupt();
    }
    if (!isRecord(parsed) || typeof parsed.version !== 'number') throw corrupt();
    // A catalog from a newer build isn't ours to read, or to overwrite.
    if (parsed.version !== ASSET_CATALOG_VERSION) {
      throw new AssetCatalogError('catalog_version_unsupported', { current: parsed.version });
    }
    if (!isRecord(parsed.assets) || !isRecord(parsed.compositions) || !isRecord(parsed.runs)) throw corrupt();
    if (!Object.entries(parsed.assets).every(([key, entry]) => isEntryShape(key, entry))) throw corrupt();
    if (!Object.values(parsed.compositions).every(isCompositionShape)) throw corrupt();
    return parsed as unknown as CatalogIndex;
  }

  async function commitIndex(index: CatalogIndex): Promise<void> {
    await persist.timed('asset_catalog', () => writeAtomically(indexPath, JSON.stringify(index, null, 2)));
  }

  async function writeRevisionFile(entry: Pick<CatalogEntry, 'id' | 'kind'>, record: AssetRevisionRecord, payload: AssetPayload): Promise<void> {
    await writeAtomically(revisionPath(entry.id, record.revision), JSON.stringify({
      assetId: entry.id,
      kind: entry.kind,
      revision: record.revision,
      contentHash: record.contentHash,
      payload,
    }));
  }

  async function readRevisionFile(entry: CatalogEntry, revision: number): Promise<AssetPayload> {
    const record = entry.revisions.find((candidate) => candidate.revision === revision);
    if (!record) throw new AssetCatalogError('revision_unavailable', { assetId: entry.id });
    let file: { assetId?: unknown; revision?: unknown; payload?: AssetPayload };
    try {
      file = JSON.parse(await fsp.readFile(revisionPath(entry.id, revision), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AssetCatalogError('revision_unavailable', { assetId: entry.id });
      throw new AssetCatalogError('payload_corrupt', { assetId: entry.id });
    }
    if (file.assetId !== entry.id || file.revision !== revision || canonicalHash(file.payload) !== record.contentHash) {
      throw new AssetCatalogError('payload_corrupt', { assetId: entry.id });
    }
    return file.payload as AssetPayload;
  }

  function getEntry(index: CatalogIndex, assetId: unknown): CatalogEntry {
    if (!isAssetId(assetId) || !hasOwn(index.assets, assetId)) throw new AssetCatalogError('asset_missing');
    return index.assets[assetId];
  }

  function getLiveEntry(index: CatalogIndex, assetId: unknown): CatalogEntry {
    const entry = getEntry(index, assetId);
    if (entry.deletedAt) throw new AssetCatalogError('asset_deleted', { assetId: entry.id });
    return entry;
  }

  /** An owner may refer to library assets and its own. Nothing else, so one agent's copy can't leak into a shared definition. */
  function canRefer(referrer: AssetOwner, target: AssetOwner): boolean {
    if (target.kind === 'library') return true;
    if (target.kind === 'agent') return referrer.kind === 'agent' && referrer.agentId === target.agentId;
    return referrer.kind === 'project' && referrer.projectId === target.projectId;
  }

  /** What a template or subagent revision refers to has to exist now, at that revision, with the right kind and owner. */
  function checkReferences(index: CatalogIndex, owner: AssetOwner, projection: AssetProjection): void {
    const issues: ValidationIssue[] = [];
    const bad = (at: string): void => {
      issues.push({ code: 'invalid_identifier', path: at });
    };
    const check = (assetId: string, kind: AssetKind, at: string, revision?: number): CatalogEntry | null => {
      const entry = hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
      if (!entry || entry.deletedAt) bad(at);
      else if (entry.kind === 'template') issues.push({ code: 'nested_template', path: at });
      else if (entry.kind !== kind || !canRefer(owner, entry.owner)) bad(at);
      else if (revision !== undefined && !entry.revisions.some((record) => record.revision === revision)) issues.push({ code: 'invalid_revision', path: at });
      else return entry;
      return null;
    };
    if (projection.kind === 'template') {
      projection.entries.forEach((ref, position) => check(ref.blockId, 'block', `entries[${position}]`, ref.blockRevision));
      projection.skills.forEach((assetId, position) => check(assetId, 'skill', `skills[${position}]`));
      projection.mcps.forEach((assetId, position) => check(assetId, 'mcp', `mcps[${position}]`));
      const names = new Set<string>();
      projection.subagents.forEach((ref, position) => {
        const at = `subagents[${position}]`;
        const entry = check(ref.subagentId, 'subagent', at, ref.subagentRevision);
        const subagent = entry?.revisions.find((record) => record.revision === ref.subagentRevision)?.projection;
        if (subagent?.kind !== 'subagent') return;
        const name = collisionKey(subagent.agentName);
        if (names.has(name)) issues.push({ code: 'duplicate_subagent_name', path: at });
        names.add(name);
      });
    } else if (projection.kind === 'subagent') {
      projection.blocks.forEach((ref, position) => check(ref.blockId, 'block', `blocks[${position}]`, ref.blockRevision));
      projection.skills.forEach((assetId, position) => check(assetId, 'skill', `skills[${position}]`));
      projection.mcps.forEach((assetId, position) => check(assetId, 'mcp', `mcps[${position}]`));
    }
    if (issues.length > 0) throw new AssetCatalogError('invalid_reference', { issues });
  }

  function validated(kind: AssetKind, raw: unknown, source: AssetSource): { payload: AssetPayload; projection: AssetProjection } {
    const result = validatePayload(kind, raw, source.kind === 'builtin');
    if (result.ok === false) throw new AssetCatalogError('invalid_payload', { issues: result.issues });
    return { payload: result.payload, projection: result.projection };
  }

  function requireValidName(name: unknown): asserts name is string {
    const issues = nameIssues(name);
    if (issues.length > 0) throw new AssetCatalogError('invalid_payload', { issues });
  }

  /** The write has committed by now, so a failed record of it can't report the write as failed. */
  async function auditCommitted(scope: 'app' | 'agent', key: string, targetId: string): Promise<void> {
    try {
      await auditChanged(scope, key, targetId);
    } catch (err) {
      // telemetry-exempt: the change it describes has happened, and the log says the record is missing
      appLog('core:asset-catalog', 'warn', 'Could not record a committed catalog write', {
        meta: { key, targetId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Runs a write, recording the refusal if it's refused. Agents are stopped first. */
  async function guarded<T>(
    audit: { scope: 'app' | 'agent'; key: string; targetId?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      if (!isUserWritePermitted()) throw new AssetCatalogError('agent_not_permitted');
      return await fn();
    } catch (err) {
      if (err instanceof AssetCatalogError) {
        await appendSettingsAudit({
          ...currentSettingsOrigin(),
          scope: audit.scope,
          key: audit.key,
          ...(audit.targetId && { targetId: audit.targetId }),
          outcome: 'refused',
          code: err.code,
        });
      }
      throw err;
    }
  }

  function storedComposition(index: CatalogIndex, agentId: string): AgentComposition | null {
    return hasOwn(index.compositions, agentId) ? index.compositions[agentId] : null;
  }

  function requireAgentId(agentId: unknown): asserts agentId is string {
    if (!isCatalogId(agentId)) throw new AssetCatalogError('invalid_composition', { issues: [{ code: 'invalid_identifier', path: 'agentId' }] });
  }

  function planWith(index: CatalogIndex, request: PlanRequest): CompositionPlan {
    requireAgentId(request.agentId);
    requireAdoption(request.adoption);
    const stored = storedComposition(index, request.agentId);
    let composition: CompositionInput = stored ?? emptyComposition();
    if (request.draft !== undefined) {
      const result = validateComposition(request.draft);
      if (result.ok === false) throw new AssetCatalogError('invalid_composition', { issues: result.issues });
      composition = result.composition;
    }
    return planComposition(index, {
      agentId: request.agentId,
      ...(request.projectId !== undefined && { projectId: request.projectId }),
      composition,
      compositionRevision: stored?.revision ?? 0,
      adoption: request.adoption,
      foreign: request.foreign,
    });
  }

  /** Only these fields of a plan reach a receipt, each checked. A plan is only as trustworthy as whoever built it. */
  function receiptStructure(plan: ActivationPlan): RunRecord['structure'] {
    const issues: ValidationIssue[] = [];
    if (!isCatalogId(plan.agentId)) issues.push({ code: 'invalid_identifier', path: 'plan.agentId' });
    if (typeof plan.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(plan.fingerprint)) issues.push({ code: 'invalid_identifier', path: 'plan.fingerprint' });
    const { structure } = plan;
    const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    if (structure !== null && (
      !isRecord(structure) || !isAssetId(structure.templateId) || !isCount(structure.acceptedRevision) || !isCount(structure.resolvedRevision)
      || !isCount(structure.latestRevision) || typeof structure.updateWaiting !== 'boolean'
      || Object.keys(structure).length !== 5
    )) {
      issues.push({ code: 'invalid_shape', path: 'plan.structure' });
    }
    if (issues.length > 0) throw new AssetCatalogError('invalid_composition', { issues });
    return structure;
  }

  function requireAdoption(adoption: BaseAdoption | undefined): void {
    const content = adoption?.content?.mode;
    const structure = adoption?.structure?.mode;
    if ((content !== 'takeable' && content !== 'hold') || (structure !== 'accepted' && structure !== 'latest-if-clean')) {
      throw new AssetCatalogError('adoption_policy_required');
    }
  }

  function switched(index: CatalogIndex, stored: AgentComposition | null, templateId: string, selection: TemplateSwitchSelection): CompositionInput {
    const targetRevision = getLiveEntry(index, templateId).headRevision;
    const target = templateAt(index, templateId, targetRevision);
    const from = stored ?? emptyComposition();
    const result = switchedComposition(from, templateTargetOf(templateId, targetRevision, target.projection), selection, acceptedRefsOf(acceptedProjection(index, from)));
    if (result.ok === false) throw new AssetCatalogError('invalid_choice', { issues: result.issues });
    return checkedComposition(result.composition);
  }

  /** What a choice or selection produces goes through the same check as anything else saved. */
  function checkedComposition(composition: CompositionInput): CompositionInput {
    const result = validateComposition(composition);
    if (result.ok === false) throw new AssetCatalogError('invalid_choice', { issues: result.issues });
    return result.composition;
  }

  function candidateRecord(index: CatalogIndex, entry: CatalogEntry, projection: AssetProjection, payload: AssetPayload): AssetRevisionRecord {
    checkReferences(index, entry.owner, projection);
    return { revision: entry.headRevision + 1, savedAt: now(), contentHash: canonicalHash(payload), projection };
  }

  /** The revisions of an asset that something still needs once the asset itself is gone. */
  function retainedRevisions(index: CatalogIndex, assetId: string): Set<number> {
    const retained = new Set<number>();
    for (const run of Object.values(index.runs)) {
      for (const frozen of run.revisions) {
        if (frozen.assetId === assetId) retained.add(frozen.revision);
      }
    }
    for (const entry of Object.values(index.assets)) {
      if (entry.deletedAt) continue;
      if (entry.source.kind === 'copy' && entry.source.originAssetId === assetId) retained.add(entry.source.originRevision);
    }
    for (const composition of Object.values(index.compositions)) {
      for (const map of [composition.floors, composition.keepMarkers]) {
        if (hasOwn(map, assetId)) retained.add(map[assetId]);
      }
      if (hasOwn(composition.authorityApprovals, assetId)) retained.add(composition.authorityApprovals[assetId].revision);
      if (!composition.template) continue;
      if (composition.template.templateId === assetId) retained.add(composition.template.acceptedRevision);
      const accepted = acceptedProjection(index, composition);
      for (const ref of accepted?.entries ?? []) if (ref.blockId === assetId) retained.add(ref.blockRevision);
      for (const ref of accepted?.subagents ?? []) {
        if (ref.subagentId === assetId) retained.add(ref.subagentRevision);
        const subagent = hasOwn(index.assets, ref.subagentId) ? index.assets[ref.subagentId] : null;
        const nested = subagent?.revisions.find((record) => record.revision === ref.subagentRevision)?.projection;
        if (nested?.kind === 'subagent') for (const block of nested.blocks) if (block.blockId === assetId) retained.add(block.blockRevision);
      }
    }
    return retained;
  }

  function acceptedProjection(index: CatalogIndex, composition: CompositionInput): Extract<AssetProjection, { kind: 'template' }> | null {
    if (!composition.template || !hasOwn(index.assets, composition.template.templateId)) return null;
    const { templateId, acceptedRevision } = composition.template;
    const projection = index.assets[templateId].revisions.find((record) => record.revision === acceptedRevision)?.projection;
    return projection?.kind === 'template' ? projection : null;
  }

  function templateAt(index: CatalogIndex, templateId: string, revision: number): { entry: CatalogEntry; record: AssetRevisionRecord; projection: Extract<AssetProjection, { kind: 'template' }> } {
    const entry = getLiveEntry(index, templateId);
    const record = entry.revisions.find((candidate) => candidate.revision === revision);
    if (entry.kind !== 'template' || record?.projection.kind !== 'template') throw new AssetCatalogError('revision_unavailable', { assetId: templateId });
    return { entry, record, projection: record.projection };
  }

  /** What a choice has to match: the revision accepted, the revision on offer, and this instance as it stood. */
  function bindingFor(index: CatalogIndex, stored: AgentComposition | null, agentId: string, targetHash: string): StructureBinding {
    const composition = stored ?? { ...emptyComposition(), agentId, revision: 0, updatedAt: '' };
    const accepted = composition.template && hasOwn(index.assets, composition.template.templateId)
      ? index.assets[composition.template.templateId].revisions.find((record) => record.revision === composition.template?.acceptedRevision)
      : null;
    return {
      fromFingerprint: accepted?.contentHash ?? 'none',
      toFingerprint: targetHash,
      instanceFingerprint: instanceFingerprint(composition),
    };
  }

  function sameBinding(a: StructureBinding | undefined, b: StructureBinding): boolean {
    return a?.fromFingerprint === b.fromFingerprint && a.toFingerprint === b.toFingerprint && a.instanceFingerprint === b.instanceFingerprint;
  }

  /** The latest revision of an instance's template, and what taking it would mean. No intermediate adoption. */
  function structureUpdate(index: CatalogIndex, stored: AgentComposition, foreign: readonly ForeignDestination[]) {
    if (!stored.template) throw new AssetCatalogError('invalid_composition');
    const { templateId, acceptedRevision } = stored.template;
    const latest = getLiveEntry(index, templateId).headRevision;
    const target = templateAt(index, templateId, latest);
    const accepted = acceptedProjection(index, stored);
    return {
      latest,
      target,
      accepted,
      acceptedRevision,
      refs: templateTargetOf(templateId, latest, target.projection),
      check: checkStructure(structureInput(index, stored, accepted, target.projection)),
      subagentCheck: checkSubagentSet(subagentSetInput(index, stored, accepted, target.projection, foreign)),
      operationalIncreases: operationalIncreases(accepted?.operationalDefaults, target.projection.operationalDefaults),
      binding: bindingFor(index, stored, stored.agentId, target.record.contentHash),
    };
  }

  /** Everything a publication would change, unwritten. Refuses before any file exists. */
  function buildPublication(index: CatalogIndex, input: PublicationRequest) {
    if (!isAssetId(input.templateId)) throw new AssetCatalogError('asset_missing');
    const creating = input.expectedRevision === 0;
    if (creating && hasOwn(index.assets, input.templateId)) throw new AssetCatalogError('asset_exists', { assetId: input.templateId });
    const existingTemplate = creating ? null : getLiveEntry(index, input.templateId);
    if (existingTemplate && existingTemplate.kind !== 'template') throw new AssetCatalogError('invalid_publication', { assetId: input.templateId });
    if (existingTemplate?.source.kind === 'builtin') throw new AssetCatalogError('builtin_read_only', { assetId: input.templateId });
    if (existingTemplate && existingTemplate.headRevision !== input.expectedRevision) {
      throw new AssetCatalogError('stale_revision', { assetId: input.templateId, expected: input.expectedRevision, current: existingTemplate.headRevision });
    }
    const templateRevision = input.expectedRevision + 1;
    const bundledBy = { templateId: input.templateId, templateRevision };
    const savedAt = now();
    const assets = { ...index.assets };
    const records: Array<{ entry: CatalogEntry; record: AssetRevisionRecord; payload: AssetPayload }> = [];

    const seen = new Set<string>([input.templateId]);
    for (const write of input.writes) {
      if (!isAssetId(write.assetId) || seen.has(write.assetId) || (write.kind !== 'block' && write.kind !== 'subagent')) {
        throw new AssetCatalogError('invalid_publication', { assetId: write.assetId });
      }
      seen.add(write.assetId);
      let base: CatalogEntry;
      if (write.expectedRevision === 0) {
        if (hasOwn(index.assets, write.assetId)) throw new AssetCatalogError('asset_exists', { assetId: write.assetId });
        const source = write.source ?? { kind: 'user' as const };
        const issues = [...nameIssues(write.name), ...sourceIssues(source), ...ownerIssues(write.owner ?? { kind: 'library' })];
        if (issues.length > 0) throw new AssetCatalogError('invalid_publication', { issues });
        base = {
          id: write.assetId, kind: write.kind, name: write.name as string, owner: write.owner ?? { kind: 'library' },
          source, createdAt: savedAt, headRevision: 0, revisions: [],
        };
      } else {
        base = getLiveEntry(index, write.assetId);
        if (base.kind !== write.kind) throw new AssetCatalogError('invalid_publication', { assetId: write.assetId });
        if (base.source.kind === 'builtin') throw new AssetCatalogError('builtin_read_only', { assetId: write.assetId });
        if (base.headRevision !== write.expectedRevision) {
          throw new AssetCatalogError('stale_revision', { assetId: write.assetId, expected: write.expectedRevision, current: base.headRevision });
        }
      }
      const { payload, projection } = validated(write.kind, write.payload, base.source);
      const record: AssetRevisionRecord = {
        revision: base.headRevision + 1, savedAt, contentHash: canonicalHash(payload), projection, bundledBy,
      };
      const entry: CatalogEntry = { ...base, headRevision: record.revision, revisions: [...base.revisions, record] };
      assets[entry.id] = entry;
      records.push({ entry, record, payload });
    }

    const source = existingTemplate?.source ?? input.source ?? { kind: 'user' as const };
    if (creating) {
      const issues = [...nameIssues(input.name), ...sourceIssues(source), ...ownerIssues(input.owner ?? { kind: 'library' })];
      if (issues.length > 0) throw new AssetCatalogError('invalid_publication', { issues });
    }
    const { payload, projection } = validated('template', input.payload, source);
    if (projection.kind !== 'template') throw new AssetCatalogError('invalid_publication');
    const record: AssetRevisionRecord = { revision: templateRevision, savedAt, contentHash: canonicalHash(payload), projection };
    const templateEntry: CatalogEntry = existingTemplate
      ? { ...existingTemplate, headRevision: templateRevision, revisions: [...existingTemplate.revisions, record] }
      : {
        id: input.templateId, kind: 'template', name: input.name as string, owner: input.owner ?? { kind: 'library' },
        source, createdAt: savedAt, headRevision: templateRevision, revisions: [record],
      };
    assets[templateEntry.id] = templateEntry;
    const next: CatalogIndex = { ...index, assets };

    for (const item of records) checkReferences(next, item.entry.owner, item.record.projection);
    checkReferences(next, templateEntry.owner, projection);

    // A tagged revision nothing refers to could never be accepted, so it would hold everyone back for good.
    const reachable = new Set<string>();
    for (const ref of projection.entries) reachable.add(`${ref.blockId}@${ref.blockRevision}`);
    for (const ref of projection.subagents) reachable.add(`${ref.subagentId}@${ref.subagentRevision}`);
    for (const item of records) {
      if (item.record.projection.kind !== 'subagent' || !reachable.has(`${item.entry.id}@${item.record.revision}`)) continue;
      for (const ref of item.record.projection.blocks) reachable.add(`${ref.blockId}@${ref.blockRevision}`);
    }
    const unreferenced = records
      .filter((item) => !reachable.has(`${item.entry.id}@${item.record.revision}`))
      .map((item): ValidationIssue => ({ code: 'unreferenced_bundle_write', path: item.entry.id }));
    if (unreferenced.length > 0) throw new AssetCatalogError('invalid_publication', { issues: unreferenced });

    return {
      next,
      records,
      templateEntry,
      record,
      payload,
      contentHash: canonicalHash([record.contentHash, ...records.map((item) => [item.entry.id, item.record.contentHash])]),
      alsoAffected: records.map((item) => item.entry.id),
    };
  }

  function publicationImpact(index: CatalogIndex, input: PublicationRequest, built: ReturnType<typeof buildPublication>): AssetImpact {
    return previewCatalogChange(index, built.next, {
      assetId: input.templateId,
      fromRevision: input.expectedRevision,
      toRevision: input.expectedRevision + 1,
      contentHash: built.contentHash,
      alsoAffected: built.alsoAffected,
    }, input.context);
  }

  /** Marks an asset deleted, keeping only what's still referred to. With nothing left, its entry goes too. */
  function tombstoned(index: CatalogIndex, entry: CatalogEntry, deletedAt: string): CatalogIndex {
    const retained = retainedRevisions(index, entry.id);
    const assets = { ...index.assets };
    if (retained.size === 0) delete assets[entry.id];
    else assets[entry.id] = { ...entry, deletedAt, revisions: entry.revisions.filter((record) => retained.has(record.revision)) };
    return { ...index, assets };
  }

  /** Re-applies deletion rules after a reference went away, so kept revisions don't outlive what needed them. */
  function pruneTombstones(index: CatalogIndex): CatalogIndex {
    let next = index;
    for (const entry of Object.values(index.assets)) {
      if (entry.deletedAt) next = tombstoned(next, entry, entry.deletedAt);
    }
    return next;
  }

  /**
   * Remove what no index entry refers to: temp files and payloads from interrupted
   * or deleted work. Only inside a write's turn, so never racing one, and a failure
   * leaves files that nothing reads.
   */
  async function sweepUnlocked(index: CatalogIndex): Promise<void> {
    const list = async (at: string): Promise<string[]> => {
      try {
        return await fsp.readdir(at);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    };
    for (const name of await list(dir)) {
      if (name.startsWith(`${INDEX_FILE}.tmp.`)) await fsp.rm(path.join(dir, name), { force: true });
    }
    for (const assetId of await list(revisionsDir)) {
      const assetDir = path.join(revisionsDir, assetId);
      const entry = hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
      if (!entry) {
        await fsp.rm(assetDir, { recursive: true, force: true });
        continue;
      }
      const wanted = new Set(entry.revisions.map((record) => `${record.revision}.json`));
      for (const name of await list(assetDir)) {
        if (!wanted.has(name)) await fsp.rm(path.join(assetDir, name), { force: true });
      }
    }
  }

  async function sweepAfterCommit(index: CatalogIndex): Promise<void> {
    try {
      await sweepUnlocked(index);
    } catch (err) {
      // telemetry-exempt: the write has committed; leftovers are unread and the next sweep gets them
      appLog('core:asset-catalog', 'warn', 'Could not remove unreferenced catalog files', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  function installBuiltin(input: BuiltinInstall): Promise<CatalogEntry> {
    return guarded({ scope: 'app', key: 'assetCatalog.builtin', targetId: isAssetId(input.assetId) ? input.assetId : undefined }, () => serial(async () => {
      if (currentSettingsOrigin().surface !== 'system') throw new AssetCatalogError('agent_not_permitted');
      const source: AssetSource = { kind: 'builtin', builtinId: input.builtinId };
      const issues = [...nameIssues(input.name), ...sourceIssues(source, true)];
      if (!isAssetId(input.assetId)) issues.push({ code: 'invalid_identifier', path: 'assetId' });
      if (issues.length > 0) throw new AssetCatalogError('invalid_payload', { issues });
      const { payload, projection } = validated(input.kind, input.payload, source);
      const index = await loadIndex();
      const existing = hasOwn(index.assets, input.assetId) ? index.assets[input.assetId] : null;
      if ((existing?.headRevision ?? 0) !== input.expectedRevision) {
        throw new AssetCatalogError('stale_revision', { assetId: input.assetId, expected: input.expectedRevision, current: existing?.headRevision ?? 0 });
      }
      if (existing && (existing.source.kind !== 'builtin' || existing.kind !== input.kind)) throw new AssetCatalogError('asset_exists', { assetId: input.assetId });
      const savedAt = now();
      const owner = { kind: 'library' as const };
      checkReferences(index, owner, projection);
      const record: AssetRevisionRecord = { revision: input.expectedRevision + 1, savedAt, contentHash: canonicalHash(payload), projection };
      const entry: CatalogEntry = existing
        ? { ...existing, headRevision: record.revision, revisions: [...existing.revisions, record] }
        : { id: input.assetId, kind: input.kind, name: input.name, owner, source, createdAt: savedAt, headRevision: record.revision, revisions: [record] };
      if (existing && previewAssetImpact(index, entry.id, record).blocked) throw new AssetCatalogError('consumer_conflict', { assetId: entry.id });
      await writeRevisionFile(entry, record, payload);
      await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: entry } });
      await auditCommitted('app', 'assetCatalog.builtin', entry.id);
      return entry;
    }));
  }

  const api = {
    /** The whole index, as stored. Holds no payload content: for planning and listing. */
    read(): Promise<CatalogIndex> {
      return loadIndex();
    },

    /** A revision's exact payload, for activation. Checked against its recorded hash. */
    async readRevision(assetId: string, revision: number): Promise<AssetPayload> {
      return readRevisionFile(getEntry(await loadIndex(), assetId), revision);
    },

    /** A revision redacted for previews, diffs and anything an agent might be shown. */
    async previewRevision(assetId: string, revision: number): Promise<AssetPreview> {
      const entry = getEntry(await loadIndex(), assetId);
      return previewPayload(entry.kind, await readRevisionFile(entry, revision));
    },

    /** An id for an asset a publication is about to create, so a template payload can refer to it. */
    mintAssetId(): string {
      return newId();
    },

    /** Save a new asset, unassigned. */
    createAsset(input: { kind: AssetKind; name: string; payload: unknown; source?: AssetSource; owner?: AssetOwner }): Promise<CatalogEntry> {
      return guarded({ scope: 'app', key: `assetCatalog.${input.kind}` }, () => serial(async () => {
        const source = input.source ?? { kind: 'user' as const };
        const owner = input.owner ?? { kind: 'library' as const };
        const issues = [...nameIssues(input.name), ...sourceIssues(source), ...ownerIssues(owner)];
        if (issues.length > 0) throw new AssetCatalogError('invalid_payload', { issues });
        const { payload, projection } = validated(input.kind, input.payload, source);
        const index = await loadIndex();
        checkReferences(index, owner, projection);

        const savedAt = now();
        const record: AssetRevisionRecord = { revision: 1, savedAt, contentHash: canonicalHash(payload), projection };
        const entry: CatalogEntry = {
          id: newId(),
          kind: input.kind,
          name: input.name,
          owner,
          source,
          createdAt: savedAt,
          headRevision: 1,
          revisions: [record],
        };
        await writeRevisionFile(entry, record, payload);
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: entry } });
        await auditCommitted('app', `assetCatalog.${entry.kind}.created`, entry.id);
        return entry;
      }));
    },

    /** What saving this payload would do to every consumer. Writes nothing. */
    previewAssetEdit(input: { assetId: string; payload: unknown; context?: ImpactContext }): Promise<AssetImpact> {
      return serial(async () => {
        const index = await loadIndex();
        const entry = getLiveEntry(index, input.assetId);
        const { payload, projection } = validated(entry.kind, input.payload, entry.source);
        return previewAssetImpact(index, entry.id, candidateRecord(index, entry, projection, payload), input.context);
      });
    },

    /**
     * Save a new immutable revision, which becomes the latest approved one. With
     * consumers, the caller passes back the fingerprint from {@link previewAssetEdit}:
     * that's the user's impact confirmation. There's no separate publish step.
     */
    saveRevision(input: {
      assetId: string;
      expectedRevision: number;
      payload: unknown;
      impactFingerprint?: string;
      context?: ImpactContext;
    }): Promise<CatalogEntry> {
      return guarded({ scope: 'app', key: 'assetCatalog.revision', targetId: isAssetId(input.assetId) ? input.assetId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        const entry = getLiveEntry(index, input.assetId);
        if (entry.source.kind === 'builtin') throw new AssetCatalogError('builtin_read_only', { assetId: entry.id });
        if (input.expectedRevision !== entry.headRevision) {
          throw new AssetCatalogError('stale_revision', { assetId: entry.id, expected: input.expectedRevision, current: entry.headRevision });
        }
        const { payload, projection } = validated(entry.kind, input.payload, entry.source);
        const record = candidateRecord(index, entry, projection, payload);

        const impact = previewAssetImpact(index, entry.id, record, input.context);
        if (impact.blocked) throw new AssetCatalogError('consumer_conflict', { assetId: entry.id, impact });
        if (impact.agents.length > 0 || impact.templates.length > 0 || impact.subagents.length > 0) {
          if (input.impactFingerprint === undefined) throw new AssetCatalogError('impact_confirmation_required', { assetId: entry.id, impact });
          if (input.impactFingerprint !== impact.fingerprint) throw new AssetCatalogError('stale_preview', { assetId: entry.id, impact });
        }

        const updated: CatalogEntry = { ...entry, headRevision: record.revision, revisions: [...entry.revisions, record] };
        await writeRevisionFile(entry, record, payload);
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: updated } });
        await auditCommitted('app', `assetCatalog.${entry.kind}.revision`, entry.id);
        return updated;
      }));
    },

    /** Change the display name. References are by id and destinations come from the payload, so neither moves. */
    renameAsset(input: { assetId: string; expectedName: string; name: string }): Promise<CatalogEntry> {
      return guarded({ scope: 'app', key: 'assetCatalog.name', targetId: isAssetId(input.assetId) ? input.assetId : undefined }, () => serial(async () => {
        requireValidName(input.name);
        const index = await loadIndex();
        const entry = getLiveEntry(index, input.assetId);
        if (entry.source.kind === 'builtin') throw new AssetCatalogError('builtin_read_only', { assetId: entry.id });
        if (entry.name !== input.expectedName) throw new AssetCatalogError('stale_name', { assetId: entry.id });
        const updated: CatalogEntry = { ...entry, name: input.name };
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: updated } });
        await auditCommitted('app', `assetCatalog.${entry.kind}.name`, entry.id);
        return updated;
      }));
    },

    /**
     * Delete an asset nothing depends on. Refused while a template, subagent or agent uses
     * it. Revisions a recorded run or a copy's origin names stay readable; the rest
     * of its payloads go.
     */
    deleteAsset(input: { assetId: string; expectedRevision: number }): Promise<void> {
      return guarded({ scope: 'app', key: 'assetCatalog.delete', targetId: isAssetId(input.assetId) ? input.assetId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        const entry = getLiveEntry(index, input.assetId);
        if (entry.source.kind === 'builtin') throw new AssetCatalogError('builtin_read_only', { assetId: entry.id });
        if (input.expectedRevision !== entry.headRevision) {
          throw new AssetCatalogError('stale_revision', { assetId: entry.id, expected: input.expectedRevision, current: entry.headRevision });
        }
        if (hasHardReference(listConsumers(index, entry.id))) throw new AssetCatalogError('asset_in_use', { assetId: entry.id });
        // A copy going can free what its origin kept for it, so tombstones are looked at again.
        const next = pruneTombstones(tombstoned(index, entry, now()));
        await commitIndex(next);
        await auditCommitted('app', `assetCatalog.${entry.kind}.deleted`, entry.id);
        await sweepAfterCommit(next);
      }));
    },

    /**
     * A user's copy of a block, skill or subagent definition, owned by one agent, which
     * records the exact origin revision it started from. It's only a copy: nothing
     * merges, rebases or syncs it, and it isn't assigned until a composition says so.
     * A copy of a built-in keeps a reserved skill name until the user saves one of their own.
     */
    copyAsset(input: { assetId: string; revision: number; agentId: string; name?: string }): Promise<CatalogEntry> {
      return guarded({ scope: 'agent', key: 'assetCatalog.copy', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        requireAgentId(input.agentId);
        const index = await loadIndex();
        const origin = getLiveEntry(index, input.assetId);
        const copyable: readonly CopyableAssetKind[] = ['skill', 'block', 'subagent'];
        if (!(copyable as readonly string[]).includes(origin.kind)) throw new AssetCatalogError('not_copyable', { assetId: origin.id });
        const name = input.name ?? origin.name;
        requireValidName(name);
        const payload = await readRevisionFile(origin, input.revision);

        const savedAt = now();
        const record: AssetRevisionRecord = { revision: 1, savedAt, contentHash: canonicalHash(payload), projection: projectionOf(origin.kind, payload) };
        const entry: CatalogEntry = {
          id: newId(),
          kind: origin.kind,
          name,
          owner: { kind: 'agent', agentId: input.agentId },
          source: { kind: 'copy', originAssetId: origin.id, originRevision: input.revision },
          createdAt: savedAt,
          headRevision: 1,
          revisions: [record],
        };
        await writeRevisionFile(entry, record, payload);
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: entry } });
        await auditCommitted('agent', 'assetCatalog.copy', input.agentId);
        return entry;
      }));
    },

    /** Where a copy stands against its origin. Reports only: nothing changes for asking. */
    async originStatus(assetId: string): Promise<OriginStatus | null> {
      const index = await loadIndex();
      return originStatusOf(index, getEntry(index, assetId)) ?? null;
    },

    /** Plan the stored composition, or a draft, without storing anything. */
    async plan(request: PlanRequest): Promise<CompositionPlan> {
      return planWith(await loadIndex(), request);
    },

    /** What the template's latest revision would mean for this instance, and what a choice has to bind to. Writes nothing. */
    async previewStructureUpdate(input: { agentId: string; adoption: BaseAdoption; foreign?: readonly ForeignDestination[]; projectId?: string }): Promise<{
      binding: StructureBinding;
      targetRevision: number;
      check: StructureCheck;
      subagentCheck: SubagentSetCheck;
      operationalIncreases: ReadonlyArray<keyof TemplateOperationalDefaults>;
      plan: CompositionPlan;
    }> {
      requireAgentId(input.agentId);
      requireAdoption(input.adoption);
      const index = await loadIndex();
      const stored = storedComposition(index, input.agentId);
      if (!stored?.template) throw new AssetCatalogError('invalid_composition');
      const update = structureUpdate(index, stored, input.foreign ?? []);
      const clean = update.check.clean && update.subagentCheck.clean && update.operationalIncreases.length === 0;
      const draft = clean ? applyCleanUpdate(stored, update.refs, update.check.order) : stored;
      return {
        binding: update.binding,
        targetRevision: update.latest,
        check: update.check,
        subagentCheck: update.subagentCheck,
        operationalIncreases: update.operationalIncreases,
        plan: planComposition(index, {
          agentId: input.agentId,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          composition: draft,
          compositionRevision: stored.revision,
          adoption: input.adoption,
          foreign: input.foreign,
        }),
      };
    },

    /**
     * Accept the template's latest revision: everything it changed or none of it.
     * A clean one takes no choice. Anything else needs a choice accounting for every
     * entry. Either way the binding has to match what the person saw. Updates
     * desired state only: a running session never changes.
     */
    acceptStructureUpdate(input: {
      agentId: string;
      expectedRevision: number;
      targetRevision: number;
      binding: StructureBinding;
      choice?: StructureChoice;
      adoption: BaseAdoption;
      foreign?: readonly ForeignDestination[];
      projectId?: string;
    }): Promise<AgentComposition> {
      return guarded({ scope: 'agent', key: 'assetCatalog.structure', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        requireAgentId(input.agentId);
        requireAdoption(input.adoption);
        const index = await loadIndex();
        const stored = storedComposition(index, input.agentId);
        if (!stored?.template) throw new AssetCatalogError('invalid_composition');
        if (stored.revision !== input.expectedRevision) {
          throw new AssetCatalogError('stale_revision', { expected: input.expectedRevision, current: stored.revision });
        }
        const update = structureUpdate(index, stored, input.foreign ?? []);
        if (input.targetRevision !== update.latest || update.latest === update.acceptedRevision) {
          throw new AssetCatalogError('stale_revision', { expected: input.targetRevision, current: update.latest });
        }
        if (!sameBinding(input.binding, update.binding)) throw new AssetCatalogError('stale_choice');

        let next: CompositionInput;
        if (input.choice) {
          // Raising access or orchestration is a person's call, named key by key.
          const agreed = input.choice.acceptOperationalIncreases ?? [];
          const unagreed = update.operationalIncreases.filter((key) => !agreed.includes(key));
          if (unagreed.length > 0) {
            throw new AssetCatalogError('invalid_choice', { issues: unagreed.map((key): ValidationIssue => ({ code: 'invalid_choice', path: `acceptOperationalIncreases:${key}` })) });
          }
          const applied = applyStructureChoice(stored, update.refs, input.choice, acceptedRefsOf(update.accepted));
          if (applied.ok === false) throw new AssetCatalogError('invalid_choice', { issues: applied.issues });
          const { template, entries, excludedEntryIds, subagents, excludedSubagentEntryIds, additions, removals, floors, keepMarkers, authorityApprovals } = applied.composition;
          next = checkedComposition({ template, entries, excludedEntryIds, subagents, excludedSubagentEntryIds, additions, removals, floors, keepMarkers, authorityApprovals });
        } else {
          if (!update.check.clean || !update.subagentCheck.clean || update.operationalIncreases.length > 0) {
            throw new AssetCatalogError('structure_needs_choice', { check: update.check, subagentCheck: update.subagentCheck, operationalIncreases: update.operationalIncreases });
          }
          next = applyCleanUpdate(stored, update.refs, update.check.order);
        }
        const plan = planComposition(index, {
          agentId: input.agentId,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          composition: next,
          compositionRevision: stored.revision,
          adoption: input.adoption,
          foreign: input.foreign,
        });
        if (plan.blockers.length > 0) throw new AssetCatalogError('composition_blocked', { plan });

        const { agentId } = stored;
        const { template, entries, excludedEntryIds, subagents, excludedSubagentEntryIds, additions, removals, floors, keepMarkers, authorityApprovals } = next;
        const saved: AgentComposition = {
          template, entries, excludedEntryIds, subagents, excludedSubagentEntryIds, additions, removals, floors, keepMarkers, authorityApprovals,
          agentId, revision: stored.revision + 1, updatedAt: now(),
        };
        await commitIndex({ ...index, compositions: { ...index.compositions, [agentId]: saved } });
        await auditCommitted('agent', 'assetCatalog.structure', agentId);
        return saved;
      }));
    },

    /** A switch to another template as a replace: the result, and what the commit has to bind to. Writes nothing. */
    async previewTemplateSwitch(input: {
      agentId: string;
      templateId: string;
      selection: TemplateSwitchSelection;
      adoption: BaseAdoption;
      foreign?: readonly ForeignDestination[];
      projectId?: string;
    }): Promise<{
      binding: StructureBinding;
      targetRevision: number;
      composition: CompositionInput;
      /** What this switch would raise, for the person making it to see. Making the switch is their choice. */
      operationalIncreases: ReadonlyArray<keyof TemplateOperationalDefaults>;
      plan: CompositionPlan;
    }> {
      requireAgentId(input.agentId);
      requireAdoption(input.adoption);
      const index = await loadIndex();
      const stored = storedComposition(index, input.agentId);
      const composition = switched(index, stored, input.templateId, input.selection);
      const targetRevision = getLiveEntry(index, input.templateId).headRevision;
      return {
        binding: bindingFor(index, stored, input.agentId, templateAt(index, input.templateId, targetRevision).record.contentHash),
        targetRevision,
        composition,
        operationalIncreases: operationalIncreases(
          stored ? acceptedProjection(index, stored)?.operationalDefaults : undefined,
          templateAt(index, input.templateId, targetRevision).projection.operationalDefaults,
        ),
        plan: planComposition(index, {
          agentId: input.agentId,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          composition,
          compositionRevision: stored?.revision ?? 0,
          adoption: input.adoption,
          foreign: input.foreign,
        }),
      };
    },

    /** Commit a template switch. Only what was selected carries over. The agent id, and all that hangs off it, stays. */
    switchTemplate(input: {
      agentId: string;
      expectedRevision: number;
      templateId: string;
      selection: TemplateSwitchSelection;
      binding: StructureBinding;
      adoption: BaseAdoption;
      foreign?: readonly ForeignDestination[];
      projectId?: string;
    }): Promise<AgentComposition> {
      return guarded({ scope: 'agent', key: 'assetCatalog.structure', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        requireAgentId(input.agentId);
        requireAdoption(input.adoption);
        const index = await loadIndex();
        const stored = storedComposition(index, input.agentId);
        if ((stored?.revision ?? 0) !== input.expectedRevision) {
          throw new AssetCatalogError('stale_revision', { expected: input.expectedRevision, current: stored?.revision ?? 0 });
        }
        const targetRevision = getLiveEntry(index, input.templateId).headRevision;
        const binding = bindingFor(index, stored, input.agentId, templateAt(index, input.templateId, targetRevision).record.contentHash);
        if (!sameBinding(input.binding, binding)) throw new AssetCatalogError('stale_choice');

        const next = switched(index, stored, input.templateId, input.selection);
        const plan = planComposition(index, {
          agentId: input.agentId,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          composition: next,
          compositionRevision: stored?.revision ?? 0,
          adoption: input.adoption,
          foreign: input.foreign,
        });
        if (plan.blockers.length > 0) throw new AssetCatalogError('composition_blocked', { plan });

        const saved: AgentComposition = { ...next, agentId: input.agentId, revision: (stored?.revision ?? 0) + 1, updatedAt: now() };
        await commitIndex({ ...index, compositions: { ...index.compositions, [input.agentId]: saved } });
        await auditCommitted('agent', 'assetCatalog.structure', input.agentId);
        return saved;
      }));
    },

    /** What publishing would do to every consumer. Writes nothing. */
    previewPublication(input: PublicationRequest): Promise<AssetImpact> {
      return serial(async () => {
        const index = await loadIndex();
        return publicationImpact(index, input, buildPublication(index, input));
      });
    },

    /**
     * Publish a template revision and the block and subagent revisions that go with
     * it, as one commit. Tags are set here and never again. An independent block
     * edit is {@link saveRevision}, a separate action on purpose: Clubhouse makes no
     * claim to detect whether an edit is safe to flow, so the author chooses.
     */
    publishTemplate(input: PublicationRequest & { impactFingerprint?: string }): Promise<CatalogEntry> {
      return guarded({ scope: 'app', key: 'assetCatalog.template.published', targetId: isAssetId(input.templateId) ? input.templateId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        const built = buildPublication(index, input);
        const impact = publicationImpact(index, input, built);
        if (impact.blocked) throw new AssetCatalogError('consumer_conflict', { assetId: input.templateId, impact });
        if (impact.agents.length > 0 || impact.templates.length > 0 || impact.subagents.length > 0) {
          if (input.impactFingerprint === undefined) throw new AssetCatalogError('impact_confirmation_required', { assetId: input.templateId, impact });
          if (input.impactFingerprint !== impact.fingerprint) throw new AssetCatalogError('stale_preview', { assetId: input.templateId, impact });
        }
        for (const item of built.records) await writeRevisionFile(item.entry, item.record, item.payload);
        await writeRevisionFile(built.templateEntry, built.record, built.payload);
        await commitIndex(built.next);
        await auditCommitted('app', 'assetCatalog.template.published', input.templateId);
        return built.templateEntry;
      }));
    },

    /**
     * The effective instructions, exactly as they'd be delivered, with each block's
     * text: for a person's preview in a local UI, and so not redacted, since a preview
     * that differs from what's delivered isn't one. Refused from agent surfaces, and
     * never to be logged. Works on a blocked plan, whose blocks are still worth seeing.
     */
    async previewInstructions(request: PlanRequest): Promise<{
      plan: CompositionPlan;
      blocks: Array<{ entryKey: string; assetId: string; name: string; source: string; revision: number; text: string }>;
      composed: ComposedInstructions;
    }> {
      if (!isUserWritePermitted()) throw new AssetCatalogError('agent_not_permitted');
      const index = await loadIndex();
      const plan = planWith(index, request);
      const blocks = await Promise.all((plan.instructions?.blocks ?? []).map(async (block) => {
        const payload = await readRevisionFile(getEntry(index, block.assetId), block.revision);
        const text = (payload as BlockAssetPayload).content;
        return { entryKey: block.entryKey, assetId: block.assetId, name: block.name, source: block.source, revision: block.revision, text };
      }));
      return { plan, blocks, composed: composeInstructions(blocks.map((block) => ({ content: block.text }))) };
    },

    /**
     * Commit a desired composition. It must match the preview the user saw
     * (`previewFingerprint`), and nothing may block: no partial application.
     */
    saveComposition(input: {
      agentId: string;
      expectedRevision: number;
      composition: unknown;
      adoption: BaseAdoption;
      previewFingerprint: string;
      foreign?: readonly ForeignDestination[];
      projectId?: string;
    }): Promise<AgentComposition> {
      return guarded({ scope: 'agent', key: 'assetCatalog.composition', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        const plan = planWith(index, {
          agentId: input.agentId,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          adoption: input.adoption,
          draft: input.composition,
          foreign: input.foreign,
        });
        if (input.expectedRevision !== plan.compositionRevision) {
          throw new AssetCatalogError('stale_revision', { expected: input.expectedRevision, current: plan.compositionRevision });
        }
        const composition = validateComposition(input.composition);
        if (composition.ok === false) throw new AssetCatalogError('invalid_composition', { issues: composition.issues });
        // A new template revision or another template arrives through accepting or switching, which check it.
        const was = storedComposition(index, input.agentId)?.template;
        const nextTemplate = composition.composition.template;
        if (was && (was.templateId !== nextTemplate?.templateId || was.acceptedRevision !== nextTemplate?.acceptedRevision)) {
          throw new AssetCatalogError('structure_change_requires_acceptance');
        }
        if (plan.blockers.length > 0) throw new AssetCatalogError('composition_blocked', { plan });
        if (input.previewFingerprint !== plan.fingerprint) throw new AssetCatalogError('stale_preview', { plan });

        const stored: AgentComposition = {
          ...composition.composition,
          agentId: input.agentId,
          revision: plan.compositionRevision + 1,
          updatedAt: now(),
        };
        await commitIndex({ ...index, compositions: { ...index.compositions, [input.agentId]: stored } });
        await auditCommitted('agent', 'assetCatalog.composition', input.agentId);
        return stored;
      }));
    },

    /** The agent is gone: forget its composition and its own copies. Shared assets stay. */
    removeAgent(input: { agentId: string; expectedRevision: number }): Promise<void> {
      return guarded({ scope: 'agent', key: 'assetCatalog.composition', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        requireAgentId(input.agentId);
        const index = await loadIndex();
        const stored = storedComposition(index, input.agentId);
        if ((stored?.revision ?? 0) !== input.expectedRevision) {
          throw new AssetCatalogError('stale_revision', { expected: input.expectedRevision, current: stored?.revision ?? 0 });
        }
        const compositions = { ...index.compositions };
        delete compositions[input.agentId];
        let next: CatalogIndex = { ...index, compositions };
        const deletedAt = now();
        const owned = Object.values(index.assets).filter((entry) => !entry.deletedAt && entry.owner.kind === 'agent' && entry.owner.agentId === input.agentId);
        for (const entry of owned) next = tombstoned(next, entry, deletedAt);
        next = pruneTombstones(next);
        await commitIndex(next);
        await auditCommitted('agent', 'assetCatalog.composition', input.agentId);
        await sweepAfterCommit(next);
      }));
    },

    /**
     * The receipt of a start: the structure accepted and available, the exact
     * revisions used, and whether an update was waiting. They stay readable however
     * desired state moves. Clubhouse's own bookkeeping, whoever asked for the start,
     * so agent surfaces aren't refused: it only ever keeps things, and nothing from
     * the plan reaches the index unchecked.
     */
    recordRun(input: { runId: string; plan: ActivationPlan }): Promise<RunRecord> {
      return serial(async () => {
        if (!isCatalogId(input.runId)) throw new AssetCatalogError('invalid_composition', { issues: [{ code: 'invalid_identifier', path: 'runId' }] });
        const index = await loadIndex();
        if (hasOwn(index.runs, input.runId)) throw new AssetCatalogError('run_exists');
        const { plan } = input;
        const structure = receiptStructure(plan);
        const listed: RunRecord['revisions'] = [
          ...(plan.structure ? [{ assetId: plan.structure.templateId, kind: 'template' as const, revision: plan.structure.resolvedRevision }] : []),
          ...(plan.instructions?.blocks ?? []).map((block) => ({ assetId: block.assetId, kind: 'block' as const, revision: block.revision })),
          ...plan.assets.map((asset) => ({ assetId: asset.assetId, kind: asset.kind, revision: asset.revision })),
          ...plan.subagents.flatMap((subagent): RunRecord['revisions'] => [
            { assetId: subagent.assetId, kind: 'subagent', revision: subagent.revision },
            ...subagent.blocks.map((block) => ({ assetId: block.assetId, kind: 'block' as const, revision: block.revision })),
            ...subagent.skills.map((skill) => ({ assetId: skill.assetId, kind: 'skill' as const, revision: skill.revision })),
            ...subagent.mcps.map((mcp) => ({ assetId: mcp.assetId, kind: 'mcp' as const, revision: mcp.revision })),
          ]),
        ];
        const revisions = [...new Map(listed.map((frozen) => [`${frozen.assetId}@${frozen.revision}`, frozen])).values()];
        for (const frozen of revisions) {
          const entry = getEntry(index, frozen.assetId);
          if (!entry.revisions.some((record) => record.revision === frozen.revision)) {
            throw new AssetCatalogError('revision_unavailable', { assetId: frozen.assetId });
          }
          // The catalog says what kind it is. A plan only says which one it means.
          frozen.kind = entry.kind;
        }
        const run: RunRecord = {
          runId: input.runId,
          agentId: plan.agentId,
          recordedAt: now(),
          planFingerprint: plan.fingerprint,
          structure,
          revisions,
        };
        await commitIndex({ ...index, runs: { ...index.runs, [run.runId]: run } });
        return run;
      });
    },

    /** The payloads a run started with, exactly. */
    async readRunPayloads(runId: string): Promise<Array<{ assetId: string; kind: AssetKind; revision: number; payload: AssetPayload }>> {
      const index = await loadIndex();
      if (!hasOwn(index.runs, runId)) throw new AssetCatalogError('run_missing');
      return Promise.all(index.runs[runId].revisions.map(async (frozen) => ({
        ...frozen,
        payload: await readRevisionFile(getEntry(index, frozen.assetId), frozen.revision),
      })));
    },

    /** Forget a run. Revisions only it kept, of assets since deleted, go with it. */
    releaseRun(runId: string): Promise<void> {
      // This can free what deletion kept, so it's refused from agent surfaces like any other write that removes things.
      return guarded({ scope: 'agent', key: 'assetCatalog.run', targetId: isCatalogId(runId) ? runId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        if (!hasOwn(index.runs, runId)) throw new AssetCatalogError('run_missing');
        const runs = { ...index.runs };
        delete runs[runId];
        const next = pruneTombstones({ ...index, runs });
        await commitIndex(next);
        await sweepAfterCommit(next);
      }));
    },

    /** Clear leftovers from an interrupted write. Never part of a read. */
    sweep(): Promise<void> {
      return guarded({ scope: 'app', key: 'assetCatalog.sweep' }, () => serial(async () => {
        // No index says nothing about what's wanted, so it can't mean every payload is unwanted.
        if (await pathExists(indexPath)) await sweepUnlocked(await loadIndex());
      }));
    },
  };
  builtinInstallers.set(api, installBuiltin);
  return api;
}
