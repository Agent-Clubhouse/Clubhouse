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

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
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

/** The paths a cwd may be recorded as: as given and with symlinks resolved (macOS /var vs /private/var). */
function cwdForms(cwd: string): Set<string> {
  const forms = new Set([path.resolve(cwd)]);
  try {
    forms.add(fs.realpathSync(cwd));
  } catch {
    // telemetry-exempt: the cwd may be gone; the resolved form still matches
  }
  return forms;
}

function sameCwd(recorded: string | undefined, forms: Set<string>): boolean {
  return !!recorded && forms.has(path.resolve(recorded));
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

/**
 * Whether Copilot has `sessionId`: its directory, or a legacy `<id>.jsonl`.
 * false when the store doesn't exist; undefined when it can't be read.
 */
export async function hasCopilotSession(stateDir: string, sessionId: string): Promise<boolean | undefined> {
  if (!UUID.test(sessionId)) return false;
  try {
    await fsp.access(stateDir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
  for (const name of new Set([sessionId, sessionId.toLowerCase(), sessionId.toUpperCase()])) {
    for (const p of [path.join(stateDir, name), path.join(stateDir, `${name}.jsonl`)]) {
      try {
        await fsp.access(p);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      }
    }
  }
  return false;
}
