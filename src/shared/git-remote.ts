/**
 * A git remote as a key two machines can compare (#3066): host and path, no
 * scheme, user, credentials, port or `.git`, lowercased. `git@github.com:org/repo.git`
 * and `https://user:token@github.com/Org/Repo` are both `github.com/org/repo`.
 * Null for anything that isn't a remote (a local path, say).
 */
export function normalizeGitRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  // A Windows drive path (C:\src\app) isn't a remote, though it looks like `host:path`.
  if (!raw || /^[a-z]:[\\/]/i.test(raw)) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return null; }
    if (parsed.protocol === 'file:' || !parsed.hostname) return null;
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }
  const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!cleanPath) return null;
  return `${host}/${cleanPath}`.toLowerCase();
}
