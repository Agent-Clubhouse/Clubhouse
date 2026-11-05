/**
 * The installation-local asset catalog (#2737), under the Clubhouse base dir:
 *
 *   asset-catalog/catalog.json                   the index: entries, compositions, run records
 *   asset-catalog/revisions/<asset>/<n>.json     one immutable payload per revision
 *
 * A write puts any payload file in place first, then replaces the index with a
 * temp file and rename, and only that rename commits. A crash before it leaves a
 * file nothing refers to and the catalog as it was; the next save of that
 * revision number replaces it. Every write checks an expected revision against
 * what's on disk, one at a time, so nothing is last-write-wins.
 *
 * Reads never write, and a missing catalog reads as empty without creating it.
 * An index that won't parse fails explicitly and is left alone: continuing empty
 * would let the next save replace it, and with it every agent's composition.
 *
 * Not a settings-store store: that writes in place and has no expected revision.
 * Writes report to the settings audit by id alone, and refusals too. Asset and
 * composition writes are refused from agent surfaces: agents can't create, edit,
 * delete or copy assets, and agent assignment arrives with grants (#2738).
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
  type AssetPayload,
  type AssetPreview,
  type AssetProjection,
  type AssetRevisionRecord,
  type AssetSource,
  type BaseAdoption,
  type CatalogEntry,
  type CatalogIndex,
  type CompositionInput,
  type CompositionPlan,
  type CopyableAssetKind,
  type ForeignDestination,
  type ImpactContext,
  type OriginStatus,
  type RunRecord,
  type ValidationIssue,
} from '../../../shared/asset-catalog-types';
import { persist } from '../../telemetry/persist';
import { getBaseDirPath } from '../base-dir';
import { pathExists } from '../fs-utils';
import { appLog } from '../log-service';
import { appendSettingsAudit, auditChanged, currentSettingsOrigin } from '../settings-audit';
import {
  canonicalHash,
  emptyComposition,
  hasHardReference,
  listConsumers,
  originStatusOf,
  planComposition,
  previewAssetImpact,
} from './planner';
import {
  hasOwn,
  isAssetId,
  isCatalogId,
  nameIssues,
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
  return isRecord(composition) && Array.isArray(composition.additions) && Array.isArray(composition.removals);
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
  adoption: BaseAdoption;
  /** The composition to preview. Without it, what's stored. */
  draft?: unknown;
  foreign?: readonly ForeignDestination[];
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

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.catch((): void => undefined).then(fn);
    queue = run.catch((): void => undefined);
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

  /** A preset refers only to library assets of the right kind that exist now. No preset refers to a preset. */
  function checkPresetReferences(index: CatalogIndex, projection: AssetProjection): void {
    if (projection.kind !== 'preset') return;
    const issues: ValidationIssue[] = [];
    const check = (assetId: string, kind: AssetKind, at: string): void => {
      const entry = hasOwn(index.assets, assetId) ? index.assets[assetId] : null;
      if (!entry || entry.deletedAt) issues.push({ code: 'invalid_identifier', path: at });
      else if (entry.kind === 'preset') issues.push({ code: 'nested_preset', path: at });
      else if (entry.kind !== kind) issues.push({ code: 'invalid_identifier', path: at });
      else if (entry.owner.kind !== 'library') issues.push({ code: 'invalid_identifier', path: at });
    };
    check(projection.instruction, 'instruction', 'instruction');
    projection.skills.forEach((assetId, position) => check(assetId, 'skill', `skills[${position}]`));
    projection.mcps.forEach((assetId, position) => check(assetId, 'mcp', `mcps[${position}]`));
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
    if (request.adoption?.mode !== 'latest' && request.adoption?.mode !== 'hold') throw new AssetCatalogError('adoption_policy_required');
    const stored = storedComposition(index, request.agentId);
    let composition: CompositionInput = stored ?? emptyComposition();
    if (request.draft !== undefined) {
      const result = validateComposition(request.draft);
      if (result.ok === false) throw new AssetCatalogError('invalid_composition', { issues: result.issues });
      composition = result.composition;
    }
    return planComposition(index, {
      agentId: request.agentId,
      composition,
      compositionRevision: stored?.revision ?? 0,
      adoption: request.adoption,
      foreign: request.foreign,
    });
  }

  function candidateRecord(index: CatalogIndex, entry: CatalogEntry, projection: AssetProjection, payload: AssetPayload): AssetRevisionRecord {
    checkPresetReferences(index, projection);
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
    return retained;
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

  return {
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

    /** Save a new, unassigned library asset. */
    createAsset(input: { kind: AssetKind; name: string; payload: unknown; source?: AssetSource }): Promise<CatalogEntry> {
      return guarded({ scope: 'app', key: `assetCatalog.${input.kind}` }, () => serial(async () => {
        const source = input.source ?? { kind: 'user' as const };
        const issues = [...nameIssues(input.name), ...sourceIssues(source)];
        if (issues.length > 0) throw new AssetCatalogError('invalid_payload', { issues });
        const { payload, projection } = validated(input.kind, input.payload, source);
        const index = await loadIndex();
        checkPresetReferences(index, projection);

        const savedAt = now();
        const record: AssetRevisionRecord = { revision: 1, savedAt, contentHash: canonicalHash(payload), projection };
        const entry: CatalogEntry = {
          id: newId(),
          kind: input.kind,
          name: input.name,
          owner: { kind: 'library' },
          source,
          createdAt: savedAt,
          headRevision: 1,
          revisions: [record],
        };
        await writeRevisionFile(entry, record, payload);
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: entry } });
        await auditChanged('app', `assetCatalog.${entry.kind}.created`, entry.id);
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
        if (input.expectedRevision !== entry.headRevision) {
          throw new AssetCatalogError('stale_revision', { assetId: entry.id, expected: input.expectedRevision, current: entry.headRevision });
        }
        const { payload, projection } = validated(entry.kind, input.payload, entry.source);
        const record = candidateRecord(index, entry, projection, payload);

        const impact = previewAssetImpact(index, entry.id, record, input.context);
        if (impact.blocked) throw new AssetCatalogError('consumer_conflict', { assetId: entry.id, impact });
        if (impact.agents.length > 0 || impact.presets.length > 0) {
          if (input.impactFingerprint === undefined) throw new AssetCatalogError('impact_confirmation_required', { assetId: entry.id, impact });
          if (input.impactFingerprint !== impact.fingerprint) throw new AssetCatalogError('stale_preview', { assetId: entry.id, impact });
        }

        const updated: CatalogEntry = { ...entry, headRevision: record.revision, revisions: [...entry.revisions, record] };
        await writeRevisionFile(entry, record, payload);
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: updated } });
        await auditChanged('app', `assetCatalog.${entry.kind}.revision`, entry.id);
        return updated;
      }));
    },

    /** Change the display name. References are by id and destinations come from the payload, so neither moves. */
    renameAsset(input: { assetId: string; expectedName: string; name: string }): Promise<CatalogEntry> {
      return guarded({ scope: 'app', key: 'assetCatalog.name', targetId: isAssetId(input.assetId) ? input.assetId : undefined }, () => serial(async () => {
        requireValidName(input.name);
        const index = await loadIndex();
        const entry = getLiveEntry(index, input.assetId);
        if (entry.name !== input.expectedName) throw new AssetCatalogError('stale_name', { assetId: entry.id });
        const updated: CatalogEntry = { ...entry, name: input.name };
        await commitIndex({ ...index, assets: { ...index.assets, [entry.id]: updated } });
        await auditChanged('app', `assetCatalog.${entry.kind}.name`, entry.id);
        return updated;
      }));
    },

    /**
     * Delete an asset nothing depends on. Refused while a preset or an agent uses
     * it. Revisions a recorded run or a copy's origin names stay readable; the rest
     * of its payloads go.
     */
    deleteAsset(input: { assetId: string; expectedRevision: number }): Promise<void> {
      return guarded({ scope: 'app', key: 'assetCatalog.delete', targetId: isAssetId(input.assetId) ? input.assetId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        const entry = getLiveEntry(index, input.assetId);
        if (input.expectedRevision !== entry.headRevision) {
          throw new AssetCatalogError('stale_revision', { assetId: entry.id, expected: input.expectedRevision, current: entry.headRevision });
        }
        if (hasHardReference(listConsumers(index, entry.id))) throw new AssetCatalogError('asset_in_use', { assetId: entry.id });
        // A copy going can free what its origin kept for it, so tombstones are looked at again.
        const next = pruneTombstones(tombstoned(index, entry, now()));
        await commitIndex(next);
        await auditChanged('app', `assetCatalog.${entry.kind}.deleted`, entry.id);
        await sweepAfterCommit(next);
      }));
    },

    /**
     * A user's copy of an instruction document or skill, owned by one agent, which
     * records the exact origin revision it started from. It's only a copy: nothing
     * merges, rebases or syncs it, and it isn't assigned until a composition says so.
     * A copy of a built-in keeps a reserved skill name until the user saves one of their own.
     */
    copyAsset(input: { assetId: string; revision: number; agentId: string; name?: string }): Promise<CatalogEntry> {
      return guarded({ scope: 'agent', key: 'assetCatalog.copy', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        requireAgentId(input.agentId);
        const index = await loadIndex();
        const origin = getLiveEntry(index, input.assetId);
        const copyable: readonly CopyableAssetKind[] = ['skill', 'instruction'];
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
        await auditChanged('agent', 'assetCatalog.copy', input.agentId);
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
    }): Promise<AgentComposition> {
      return guarded({ scope: 'agent', key: 'assetCatalog.composition', targetId: isCatalogId(input.agentId) ? input.agentId : undefined }, () => serial(async () => {
        const index = await loadIndex();
        const plan = planWith(index, { agentId: input.agentId, adoption: input.adoption, draft: input.composition, foreign: input.foreign });
        if (input.expectedRevision !== plan.compositionRevision) {
          throw new AssetCatalogError('stale_revision', { expected: input.expectedRevision, current: plan.compositionRevision });
        }
        if (plan.blockers.length > 0) throw new AssetCatalogError('composition_blocked', { plan });
        if (input.previewFingerprint !== plan.fingerprint) throw new AssetCatalogError('stale_preview', { plan });

        const composition = validateComposition(input.composition);
        if (composition.ok === false) throw new AssetCatalogError('invalid_composition', { issues: composition.issues });
        const stored: AgentComposition = {
          ...composition.composition,
          agentId: input.agentId,
          revision: plan.compositionRevision + 1,
          updatedAt: now(),
        };
        await commitIndex({ ...index, compositions: { ...index.compositions, [input.agentId]: stored } });
        await auditChanged('agent', 'assetCatalog.composition', input.agentId);
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
        await auditChanged('agent', 'assetCatalog.composition', input.agentId);
        await sweepAfterCommit(next);
      }));
    },

    /**
     * Freeze the exact revisions a run started with, so they stay readable however
     * desired state moves. Clubhouse's own bookkeeping, whoever asked for the start.
     */
    recordRun(input: { runId: string; plan: ActivationPlan }): Promise<RunRecord> {
      return serial(async () => {
        if (!isCatalogId(input.runId)) throw new AssetCatalogError('invalid_composition', { issues: [{ code: 'invalid_identifier', path: 'runId' }] });
        const index = await loadIndex();
        if (hasOwn(index.runs, input.runId)) throw new AssetCatalogError('run_exists');
        const { plan } = input;
        const revisions: RunRecord['revisions'] = [
          ...(plan.base ? [{ assetId: plan.base.presetId, kind: 'preset' as const, revision: plan.base.revision }] : []),
          ...plan.assets.map((asset) => ({ assetId: asset.assetId, kind: asset.kind, revision: asset.revision })),
        ];
        for (const frozen of revisions) {
          const entry = getEntry(index, frozen.assetId);
          if (!entry.revisions.some((record) => record.revision === frozen.revision)) {
            throw new AssetCatalogError('revision_unavailable', { assetId: frozen.assetId });
          }
        }
        const run: RunRecord = {
          runId: input.runId,
          agentId: plan.agentId,
          recordedAt: now(),
          planFingerprint: plan.fingerprint,
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
      return serial(async () => {
        const index = await loadIndex();
        if (!hasOwn(index.runs, runId)) throw new AssetCatalogError('run_missing');
        const runs = { ...index.runs };
        delete runs[runId];
        const next = pruneTombstones({ ...index, runs });
        await commitIndex(next);
        await sweepAfterCommit(next);
      });
    },

    /** Clear leftovers from an interrupted write. Never part of a read. */
    sweep(): Promise<void> {
      return serial(async () => {
        // No index says nothing about what's wanted, so it can't mean every payload is unwanted.
        if (await pathExists(indexPath)) await sweepUnlocked(await loadIndex());
      });
    },
  };
}
