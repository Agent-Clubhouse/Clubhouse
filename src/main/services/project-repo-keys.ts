/**
 * Each project's git remote as a key (#3066), for suggesting a link with the
 * same project on another machine. Only the key leaves this module: the URL
 * may hold credentials. Read from git, and kept for a minute.
 */
import { normalizeGitRemote } from '../../shared/git-remote';
import { getRemoteUrl } from './git-service';

const TTL_MS = 60_000;
const cache = new Map<string, { key: string | null; at: number }>();

async function keyFor(projectPath: string, now: number): Promise<string | null> {
  const hit = cache.get(projectPath);
  if (hit && now - hit.at < TTL_MS) return hit.key;
  let key: string | null = null;
  try {
    key = normalizeGitRemote(await getRemoteUrl(projectPath));
  } catch {
    // telemetry-exempt: no key means no suggestion, which is fine
    key = null;
  }
  cache.set(projectPath, { key, at: now });
  return key;
}

/** Keys for the projects that have a git remote, by project id. */
export async function repoKeysFor(projects: ReadonlyArray<{ id: string; path: string }>, now = Date.now()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(projects.map(async (p) => {
    const key = await keyFor(p.path, now);
    if (key) out[p.id] = key;
  }));
  return out;
}

/** For tests. */
export function _clearRepoKeyCache(): void {
  cache.clear();
}
