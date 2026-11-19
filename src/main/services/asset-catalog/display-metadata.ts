/** Fixed-path committed metadata only. No revision payloads, prompts, MCP config or credentials are read. */
import * as path from 'path';
import { createHash } from 'crypto';
import { ASSET_CATALOG_VERSION } from '../../../shared/asset-catalog-types';
import type { DisplayReceipt } from '../display-settings';
import { peekMetadataFileForDisplay, peekMetadataFileForDisplaySync, type PeekedSettings } from '../settings-store';
import { isAssetId } from './validation';

export const CATALOG_DISPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const CATALOG_DISPLAY_MAX_HEADS = 100;
export interface DisplayPartHead { id: string; kind: 'block' | 'skill' | 'mcp'; name: string; revision: number; builtin: boolean; skillName?: string }
type Assets = Record<string, unknown>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unavailable = (): never => { throw new Error('Managed display catalog metadata is unavailable.'); };
function assets(raw: PeekedSettings): Assets {
  if (raw === 'missing') return {};
  if (raw === 'unreadable' || raw.version !== ASSET_CATALOG_VERSION || !record(raw.assets)) return unavailable();
  return raw.assets;
}
function selected(index: Assets, id: string): { head: DisplayPartHead | null; stamp: string } {
  if (!isAssetId(id)) return unavailable();
  if (!Object.prototype.hasOwnProperty.call(index, id)) return { head: null, stamp: 'missing' };
  const entry = index[id];
  if (!record(entry) || entry.id !== id || !['block', 'skill', 'mcp'].includes(String(entry.kind))
    || typeof entry.name !== 'string' || !entry.name || entry.name.length > 2048 || !record(entry.source)
    || !['user', 'builtin', 'import', 'plugin', 'project', 'copy'].includes(String(entry.source.kind))
    || !Number.isSafeInteger(entry.headRevision) || (entry.headRevision as number) < 1 || !Array.isArray(entry.revisions)) return unavailable();
  if (entry.deletedAt !== undefined) {
    if (typeof entry.deletedAt !== 'string' || !entry.deletedAt) return unavailable();
    return { head: null, stamp: 'missing' };
  }
  const heads = entry.revisions.filter((revision) => record(revision) && revision.revision === entry.headRevision);
  if (heads.length !== 1 || !record(heads[0]) || typeof heads[0].contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(heads[0].contentHash)
    || !record(heads[0].projection) || heads[0].projection.kind !== entry.kind) return unavailable();
  const skillName = heads[0].projection.skillName;
  if (entry.kind === 'skill' && (typeof skillName !== 'string' || !skillName || skillName.length > 2048)) return unavailable();
  // Only a digest is retained by the outgoing receipt; no entry/config object.
  const stamp = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  return { stamp, head: { id, kind: entry.kind as DisplayPartHead['kind'], name: entry.name, revision: entry.headRevision as number,
    builtin: entry.source.kind === 'builtin', ...(entry.kind === 'skill' && { skillName: skillName as string }) } };
}

/** Separate factory: this closure never captures the parsed global index or a reader/payload cache. */
function finalReceipt(file: string, observations: Map<string, string>): DisplayReceipt {
  return { current: () => { try {
    const now = assets(peekMetadataFileForDisplaySync(file, CATALOG_DISPLAY_MAX_BYTES));
    return [...observations].every(([id, stamp]) => selected(now, id).stamp === stamp);
  } catch { return false; } } };
}
function headReader(index: Assets, observations: Map<string, string>) {
  let calls = 0;
  const admitted = new Map<string, { head: DisplayPartHead | null; stamp: string }>();
  return async (id: string): Promise<DisplayPartHead | null> => {
    if (++calls > CATALOG_DISPLAY_MAX_HEADS) throw new Error('Managed display setup exceeds the part limit.');
    let result = admitted.get(id);
    if (!result) { result = selected(index, id); admitted.set(id, result); }
    observations.set(id, result.stamp); return result.head ? { ...result.head } : null;
  };
}

/** Caller supplies only the catalog's fixed host directory, never a remote requested path. */
export async function openCatalogMetadataForDisplay(dir: string) {
  const file = path.join(dir, 'catalog.json');
  const index = assets(await peekMetadataFileForDisplay(file, CATALOG_DISPLAY_MAX_BYTES));
  const observations = new Map<string, string>();
  return { head: headReader(index, observations), receipt: finalReceipt(file, observations), observedAt: Date.now(),
    source: 'primary' as const, payloadsVerified: false as const };
}
