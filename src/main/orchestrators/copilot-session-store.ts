/**
 * Copilot CLI's own session store (#2156). Each session is a directory
 * `<config>/session-state/<id>/` with a `workspace.yaml` that records `id`,
 * `cwd`, `created_at` and `updated_at`. Older Copilot versions wrote a flat
 * `<config>/session-state/<id>.jsonl` instead (no cwd).
 *
 * The store holds every Copilot session on the machine (tens of thousands is
 * normal), so lookups stat directories and read `workspace.yaml` only for the
 * few that could match.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export interface CopilotWorkspace {
  id?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CopilotSessionSummary {
  sessionId: string;
  startedAt: string;
  lastActiveAt: string;
}

/** Slack around a run's window, for clock skew and Copilot writing its files a moment before or after. */
export const RUN_WINDOW_SLACK_MS = 5_000;
/** Session directories read per listing, newest first; older ones aren't listed. */
const LIST_SCAN_MAX = 2_000;
/** Directories stat'ed at once. */
const STAT_BATCH = 256;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const YAML_ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0' };

/**
 * A YAML scalar's value. Double-quoted strings carry escapes (a Windows cwd is
 * written `"C:\\Users\\me"`); single-quoted ones double their quotes.
 */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(.)/g, (m, c: string) => YAML_ESCAPES[c] ?? m);
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** The flat `key: value` fields Clubhouse needs from `workspace.yaml`. */
export function parseWorkspaceYaml(text: string): CopilotWorkspace {
  const out: CopilotWorkspace = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = unquote(m[2]);
    if (!value) continue;
    if (m[1] === 'id') out.id = value;
    else if (m[1] === 'cwd') out.cwd = value;
    else if (m[1] === 'created_at') out.createdAt = value;
    else if (m[1] === 'updated_at') out.updatedAt = value;
  }
  return out;
}

async function readWorkspace(dir: string): Promise<CopilotWorkspace | null> {
  try {
    return parseWorkspaceYaml(await fsp.readFile(path.join(dir, 'workspace.yaml'), 'utf-8'));
  } catch {
    // telemetry-exempt: a session directory without a readable workspace.yaml isn't matched
    return null;
  }
}

/**
 * A cwd in comparable form: resolved, without a trailing separator, and on
 * Windows with one separator style and case folded (its paths are
 * case-insensitive, and Copilot may record `c:\\` where Node has `C:\\`).
 */
export function cwdKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.win32.resolve(p.replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();
  const r = path.posix.resolve(p);
  return r.length > 1 ? r.replace(/\/+$/, '') : r;
}

/** The paths a cwd may be recorded as: as given and with symlinks resolved (macOS /var vs /private/var). */
function cwdForms(cwd: string): Set<string> {
  const forms = new Set([cwdKey(cwd)]);
  try {
    forms.add(cwdKey(fs.realpathSync(cwd)));
  } catch {
    // telemetry-exempt: the cwd may be gone; the resolved form still matches
  }
  return forms;
}

function sameCwd(recorded: string | undefined, forms: Set<string>): boolean {
  return !!recorded && forms.has(cwdKey(recorded));
}

interface SessionDir {
  name: string;
  dir: string;
  mtimeMs: number;
}

/** Session directories in the store with their mtimes, newest first. [] when there is no store. */
async function sessionDirs(stateDir: string): Promise<SessionDir[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(stateDir, { withFileTypes: true });
  } catch {
    // telemetry-exempt: no store yet means no sessions
    return [];
  }
  const names = entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name);
  const dirs: SessionDir[] = [];
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(names.slice(i, i + STAT_BATCH).map(async (name) => {
      const dir = path.join(stateDir, name);
      try {
        return { name, dir, mtimeMs: (await fsp.stat(dir)).mtimeMs };
      } catch {
        // telemetry-exempt: removed while listing
        return null;
      }
    }));
    for (const d of batch) if (d) dirs.push(d);
  }
  return dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Sessions Copilot recorded for `cwd`, most recently active first. */
export async function listCopilotSessions(stateDir: string, cwd: string): Promise<CopilotSessionSummary[]> {
  const forms = cwdForms(cwd);
  const out: CopilotSessionSummary[] = [];
  for (const d of (await sessionDirs(stateDir)).slice(0, LIST_SCAN_MAX)) {
    const ws = await readWorkspace(d.dir);
    if (!ws || !sameCwd(ws.cwd, forms)) continue;
    const mtime = new Date(d.mtimeMs).toISOString();
    out.push({ sessionId: ws.id || d.name, startedAt: ws.createdAt || mtime, lastActiveAt: ws.updatedAt || mtime });
  }
  return out.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

/**
 * The session a terminal run used. Other Copilot sessions can share the cwd
 * (the user's own `copilot`, chat mode, other agents without a worktree), so:
 * - a resumed run wrote to `resumedId`'s directory: that one, if it was
 *   active during the run;
 * - otherwise the run's own new session, which can't predate the run: the
 *   earliest session for this cwd created inside the run window.
 * null when nothing matches; never an id that isn't in the store.
 */
export async function findCopilotRunSession(
  stateDir: string,
  run: { cwd: string; startedAt: number; endedAt: number; resumedId?: string },
): Promise<string | null> {
  const from = run.startedAt - RUN_WINDOW_SLACK_MS;
  const to = run.endedAt + RUN_WINDOW_SLACK_MS;
  const forms = cwdForms(run.cwd);

  if (run.resumedId && UUID.test(run.resumedId)) {
    const dir = path.join(stateDir, run.resumedId);
    const ws = await readWorkspace(dir);
    if (ws) {
      let active = ws.updatedAt ? Date.parse(ws.updatedAt) : NaN;
      if (!Number.isFinite(active)) {
        try {
          active = (await fsp.stat(dir)).mtimeMs;
        } catch {
          // telemetry-exempt: removed since; treated as inactive
          active = NaN;
        }
      }
      if (Number.isFinite(active) && active >= from) return ws.id || run.resumedId;
    }
  }

  // A directory created or touched during the run has an mtime inside the window
  const recent = (await sessionDirs(stateDir)).filter((d) => d.mtimeMs >= from);
  const started: Array<{ id: string; at: number }> = [];
  for (const d of recent) {
    const ws = await readWorkspace(d.dir);
    if (!ws || !sameCwd(ws.cwd, forms)) continue;
    const at = ws.createdAt ? Date.parse(ws.createdAt) : NaN;
    if (Number.isFinite(at) && at >= from && at <= to) started.push({ id: ws.id || d.name, at });
  }
  started.sort((a, b) => a.at - b.at);
  return started[0]?.id ?? null;
}

type Located = { kind: 'dir'; dir: string } | { kind: 'legacy' } | { kind: 'missing' } | { kind: 'unknown' };

/**
 * Where the store keeps `sessionId`. 'unknown' when the store directory is
 * missing or can't be read: Copilot may keep its state somewhere Clubhouse
 * didn't look (COPILOT_HOME), so that isn't proof the session is gone.
 */
async function locateSession(stateDir: string, sessionId: string): Promise<Located> {
  try {
    if (!(await fsp.stat(stateDir)).isDirectory()) return { kind: 'unknown' };
  } catch {
    // telemetry-exempt: no store where we looked; can't tell
    return { kind: 'unknown' };
  }
  for (const name of new Set([sessionId, sessionId.toLowerCase(), sessionId.toUpperCase()])) {
    const dir = path.join(stateDir, name);
    for (const [p, found] of [[dir, { kind: 'dir', dir }], [`${dir}.jsonl`, { kind: 'legacy' }]] as const) {
      try {
        await fsp.access(p);
        return found;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unknown' };
      }
    }
  }
  return { kind: 'missing' };
}

/**
 * Whether Copilot has `sessionId`: its directory, or a legacy `<id>.jsonl`.
 * undefined (can't tell) when the store doesn't exist or can't be read;
 * callers keep the id then.
 */
export async function hasCopilotSession(stateDir: string, sessionId: string): Promise<boolean | undefined> {
  if (!UUID.test(sessionId)) return false;
  const at = await locateSession(stateDir, sessionId);
  return at.kind === 'unknown' ? undefined : at.kind !== 'missing';
}

/**
 * Whether `sessionId` is a Copilot session recorded for `cwd` (its
 * workspace.yaml `cwd`). A UUID scraped from the terminal can be any session
 * the conversation mentions, so existing isn't enough. undefined when the
 * store can't tell: no store, or a legacy session with no cwd recorded.
 */
export async function copilotSessionInCwd(stateDir: string, sessionId: string, cwd: string): Promise<boolean | undefined> {
  if (!UUID.test(sessionId)) return false;
  const at = await locateSession(stateDir, sessionId);
  if (at.kind === 'missing') return false;
  if (at.kind !== 'dir') return undefined;
  const ws = await readWorkspace(at.dir);
  if (!ws?.cwd) return undefined;
  return sameCwd(ws.cwd, cwdForms(cwd));
}

/** Paths that can hold `sessionId`'s transcript, in the order they're tried. */
function transcriptCandidates(stateDir: string, sessionId: string, cwd: string): string[] {
  const encoded = path.resolve(cwd).replace(/[/\\]/g, '-');
  const out = [
    // Copilot 1.0.x: one directory per session
    path.join(stateDir, sessionId, 'events.jsonl'),
    // Older versions: flat files, at the root or under a dash-encoded cwd
    path.join(stateDir, `${sessionId}.jsonl`),
    path.join(stateDir, `${sessionId}.json`),
  ];
  for (const sub of new Set([encoded, encoded.replace(/^-/, '')])) {
    out.push(path.join(stateDir, sub, `${sessionId}.jsonl`), path.join(stateDir, sub, `${sessionId}.json`));
  }
  return out;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    // telemetry-exempt: not there
    return false;
  }
}

/**
 * The transcript file for `sessionId`, found by its id rather than by scanning
 * the store (#2277): a fixed handful of stats, plus one readdir of the
 * session's own directory when it has no events.jsonl. `probes` counts them.
 * null when there's none, or the id isn't a single path segment.
 */
export async function findCopilotTranscript(
  stateDir: string,
  sessionId: string,
  cwd: string,
  counter: { probes: number } = { probes: 0 },
): Promise<string | null> {
  if (!sessionId || sessionId !== path.basename(sessionId) || sessionId.startsWith('.')) return null;
  for (const p of transcriptCandidates(stateDir, sessionId, cwd)) {
    counter.probes++;
    if (await isFile(p)) return p;
  }
  // A session directory whose transcript has another name
  const dir = path.join(stateDir, sessionId);
  counter.probes++;
  try {
    const jsonl = (await fsp.readdir(dir)).find((e) => e.endsWith('.jsonl'));
    return jsonl ? path.join(dir, jsonl) : null;
  } catch {
    // telemetry-exempt: no such session directory
    return null;
  }
}
