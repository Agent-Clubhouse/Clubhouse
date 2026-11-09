import * as fsp from 'fs/promises';
import * as path from 'path';
import { inspectChatLink } from './agent-runtime/chat-files';

/** A folder's listing stops here and says it was cut short. */
export const MOBILE_LINK_MAX_ENTRIES = 500;
/** Longer than desktop resolution takes: the href is refused as `not_allowed`, not looked up. */
const MAX_HREF_LENGTH = 1024;

/** A request the route can't take: the phone sent something it shouldn't have. */
export class MobileLinkQueryError extends Error {}

export type MobileLinkEntry = { name: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size?: number };

/**
 * Where a chat link points, for a phone (#3208): `GET /api/v1/mobile/agents/:id/link?href=`.
 * Resolved exactly as desktop chat links are (`inspectChatLink`, behind
 * `resolveChatLink`): relative against the agent's worktree, absolute as is,
 * percent-decoded, `#heading` dropped, network and device paths refused,
 * symlinks resolved. No folder confinement (#2478), as for `/content`. A
 * folder comes with a bounded listing. Behind the same rich content setting
 * as `/content`, rechecked after the read.
 */
export async function readMobileChatLink(query: URLSearchParams, agentId: string, enabled: () => boolean) {
  if (!enabled()) throw new Error('Rich content disabled');
  const href = query.get('href');
  if ([...query.keys()].some((key) => key !== 'href') || query.getAll('href').length !== 1 || !href) {
    throw new MobileLinkQueryError('Invalid link request');
  }
  const target = href.length > MAX_HREF_LENGTH ? { type: 'not_allowed' as const } : await inspectChatLink(agentId, href);
  let result;
  if (target.type === 'file') {
    result = { version: 1, type: 'file', path: target.path, name: path.basename(target.path), kind: target.kind, size: target.size };
  } else if (target.type === 'directory') {
    const listing = await listFolder(target.path, MOBILE_LINK_MAX_ENTRIES);
    result = listing
      ? { version: 1, type: 'directory', path: target.path, name: path.basename(target.path), ...listing }
      : { version: 1, type: 'not_allowed' };
  } else {
    result = { version: 1, type: target.type };
  }
  if (!enabled()) throw new Error('Rich content disabled');
  return result;
}

/**
 * Up to `max` entries of a folder, sorted by name, or undefined when it can't
 * be read. Symlinks are listed as themselves, not followed: one could name a
 * network path. Sizes are for regular files only.
 */
export async function listFolder(dir: string, max: number): Promise<{ entries: MobileLinkEntry[]; truncated: boolean } | undefined> {
  let handle;
  try {
    handle = await fsp.opendir(dir);
  } catch {
    // telemetry-exempt: the folder is answered as not_allowed.
    return undefined;
  }
  const found: Array<{ name: string; kind: MobileLinkEntry['kind'] }> = [];
  let truncated = false;
  try {
    // Leaving the loop early closes the handle.
    for await (const entry of handle) {
      if (found.length >= max) { truncated = true; break; }
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
      found.push({ name: entry.name, kind });
    }
  } catch {
    // telemetry-exempt: a folder that fails partway is answered as not_allowed.
    return undefined;
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries = await Promise.all(found.map(async (entry): Promise<MobileLinkEntry> => {
    if (entry.kind !== 'file') return entry;
    const st = await fsp.lstat(path.join(dir, entry.name)).catch((): null => null);
    return st ? { ...entry, size: st.size } : entry;
  }));
  return { entries, truncated };
}
