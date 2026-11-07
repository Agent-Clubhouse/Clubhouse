/**
 * Provider profiles were removed (#2749): every agent runs on its CLI's own
 * login, from the environment Clubhouse starts in. Nothing reads
 * `profiles.json` for launches any more, and the file is kept as it is.
 *
 * Someone who had saved profiles is told once, in the log and with a notice in
 * the app, which profiles were removed and which variables they set for each
 * CLI, so a changed account or a fresh session has an explanation. Only
 * variable names are logged or shown: a profile can hold any value, secrets
 * included, and its values are never logged, shown or copied anywhere. The log
 * line leaves out profile names too; the notice, which stays on this machine's
 * screen, shows them.
 *
 * Sessions a profile saved under its own CLAUDE_CONFIG_DIR, CODEX_HOME or
 * COPILOT_HOME are still in those folders. {@link removedProfileStateDirs}
 * reads just those folder paths, read-only and in memory, so a session found
 * there is kept in Clubhouse's history instead of being pruned as missing.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { appLog } from './log-service';
import { peekProjects } from './project-store';
import { readProjectAgentDefaults } from './agent-settings-service';
import { cliStateDir, homePath } from '../orchestrators/shared';

const PROFILES_FILE = 'profiles.json';
/** Records that the log line and the notice went out, so neither repeats. Holds no profile data. */
const NOTED_FILE = 'profiles-removed.json';

/** The variable that moves each CLI's state folder, and that folder's default under home. */
const STATE_DIR: Readonly<Record<string, { key: string; fallback: string }>> = {
  'claude-code': { key: 'CLAUDE_CONFIG_DIR', fallback: '.claude' },
  'codex-cli': { key: 'CODEX_HOME', fallback: '.codex' },
  'copilot-cli': { key: 'COPILOT_HOME', fallback: '.copilot' },
};

interface SavedProfile {
  id: string;
  name: string;
  /** Variable names it set, per CLI. */
  variables: Record<string, string[]>;
  /** Its state folder per CLI, when it moved one. Never logged or shown. */
  stateDirs: Record<string, string>;
}

export type RemovedProfilesOutcome = 'none' | 'noted' | 'already_noted' | 'unreadable';

export interface RemovedProfilesNotice {
  profiles: Array<{ name: string; variables: Record<string, string[]> }>;
}

function expandHome(value: string): string {
  if (value === '~') return homePath();
  if (value.startsWith('~/') || value.startsWith('~\\')) return homePath(value.slice(2));
  return value;
}

function parseSavedProfiles(raw: string): SavedProfile[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // telemetry-exempt: an unreadable file is reported once by the caller, without its content
    return null;
  }
  const list = (parsed as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list)) return null;
  const profiles: SavedProfile[] = [];
  for (const entry of list) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) continue;
    const rawName = (entry as { name?: unknown }).name;
    const orchestrators = (entry as { orchestrators?: unknown }).orchestrators;
    const variables: Record<string, string[]> = {};
    const stateDirs: Record<string, string> = {};
    if (orchestrators && typeof orchestrators === 'object') {
      for (const [provider, config] of Object.entries(orchestrators as Record<string, unknown>)) {
        const env = (config as { env?: unknown } | null)?.env;
        const envRecord = env && typeof env === 'object' ? env as Record<string, unknown> : {};
        variables[provider] = Object.keys(envRecord).sort();
        const key = STATE_DIR[provider]?.key;
        const dir = key ? envRecord[key] : undefined;
        if (typeof dir === 'string' && dir.trim()) stateDirs[provider] = expandHome(dir.trim());
      }
    }
    profiles.push({ id, name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id, variables, stateDirs });
  }
  return profiles;
}

/** null: no file. 'unreadable': a file that isn't a profiles list. */
async function readSavedProfiles(): Promise<SavedProfile[] | 'unreadable' | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(app.getPath('userData'), PROFILES_FILE), 'utf-8');
  } catch {
    // telemetry-exempt: no saved profiles file, nothing to say
    return null;
  }
  return parseSavedProfiles(raw) ?? 'unreadable';
}

/**
 * The state folders saved profiles gave `providerId` (CLAUDE_CONFIG_DIR,
 * CODEX_HOME or COPILOT_HOME), other than the one the launch environment uses
 * now. Read-only; empty without saved profiles. Never throws.
 */
export async function removedProfileStateDirs(providerId: string): Promise<string[]> {
  const spec = STATE_DIR[providerId];
  if (!spec) return [];
  try {
    const profiles = await readSavedProfiles();
    if (!Array.isArray(profiles)) return [];
    const current = path.resolve(cliStateDir(spec.key, spec.fallback));
    const dirs = new Set<string>();
    for (const profile of profiles) {
      const dir = profile.stateDirs[providerId];
      if (dir && path.resolve(dir) !== current) dirs.add(path.resolve(dir));
    }
    return [...dirs];
  } catch {
    // telemetry-exempt: no extra folders to check; the caller's own store check stands
    return [];
  }
}

interface NotedState {
  notedAt?: string;
  noticeShownAt?: string;
}

/** Marker writes queue, so the log line and the notice at startup don't overwrite each other's field. */
let markerQueue: Promise<unknown> = Promise.resolve();

function updateMarker<T>(fn: (state: NotedState) => Promise<{ result: T; next?: NotedState }>): Promise<T> {
  const run = markerQueue.then(async () => {
    const file = path.join(app.getPath('userData'), NOTED_FILE);
    let state: NotedState = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as unknown;
      // A marker from before the notice existed holds only notedAt; any readable one counts as logged.
      state = parsed && typeof parsed === 'object' ? parsed as NotedState : { notedAt: 'unknown' };
    } catch (err) {
      // telemetry-exempt: no marker yet; an unreadable one counts as both done, so nothing repeats
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') state = { notedAt: 'unknown', noticeShownAt: 'unknown' };
    }
    const { result, next } = await fn(state);
    if (next) await fsp.writeFile(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    return result;
  });
  markerQueue = run.catch((): undefined => undefined);
  return run;
}

/** The projects whose saved defaults still name a profile, with what that profile set. */
async function projectsThatUsedOne(profiles: SavedProfile[]): Promise<Array<{ project: string; variables: Record<string, string[]> | 'profile_missing' }>> {
  const byId = new Map(profiles.map((p) => [p.id, p.variables]));
  const used: Array<{ project: string; variables: Record<string, string[]> | 'profile_missing' }> = [];
  for (const project of await peekProjects().catch((): [] => [])) {
    const profileId = await readProjectAgentDefaults(project.path).then((d) => d?.profileId, (): undefined => undefined);
    if (!profileId) continue;
    used.push({ project: project.displayName || project.name, variables: byId.get(profileId) ?? 'profile_missing' });
  }
  return used;
}

/**
 * Log, once, what saved profiles held. Never deletes or changes `profiles.json`.
 * People with no saved profiles get nothing. Never throws.
 */
export async function noteRemovedProviderProfiles(): Promise<RemovedProfilesOutcome> {
  try {
    return await updateMarker(async (state) => {
      if (state.notedAt) return { result: 'already_noted' as const };
      const profiles = await readSavedProfiles();
      if (profiles === null || (Array.isArray(profiles) && profiles.length === 0)) return { result: 'none' as const };
      const next = { ...state, notedAt: new Date().toISOString() };
      if (profiles === 'unreadable') {
        appLog('core:agent', 'warn', 'Provider profiles were removed (#2749), and the saved profiles file could not be read. It is kept unchanged; agents run on each CLI\'s own login.');
        return { result: 'unreadable' as const, next };
      }
      const projects = await projectsThatUsedOne(profiles);
      appLog('core:agent', 'warn',
        'Provider profiles were removed (#2749). Agents now run on each CLI\'s own login, from the environment Clubhouse starts in. '
        + 'To use another account, sign in to it in that CLI, or start Clubhouse with that CLI\'s variable set (such as CLAUDE_CONFIG_DIR or CODEX_HOME). '
        + 'Sessions saved under a profile\'s config folder start fresh and stay in each agent\'s history. profiles.json is kept unchanged.',
        { meta: { profileCount: profiles.length, variablesByProfile: profiles.map((p) => p.variables), projects } },
      );
      return { result: 'noted' as const, next };
    });
  } catch (err) {
    // telemetry-exempt: a one-time log line; the next launch tries again.
    appLog('core:agent', 'warn', 'Could not check for removed provider profiles', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
    return 'none';
  }
}

/**
 * The one-time notice for the app: which profiles were removed and the
 * variable names they set, never values. Returned once, then marked shown;
 * null when there were no saved profiles or it was already shown. Never throws.
 */
export async function takeRemovedProfilesNotice(): Promise<RemovedProfilesNotice | null> {
  try {
    return await updateMarker(async (state) => {
      if (state.noticeShownAt) return { result: null };
      const profiles = await readSavedProfiles();
      if (!Array.isArray(profiles) || profiles.length === 0) return { result: null };
      return {
        result: { profiles: profiles.map((p) => ({ name: p.name, variables: p.variables })) },
        next: { ...state, noticeShownAt: new Date().toISOString() },
      };
    });
  } catch (err) {
    // telemetry-exempt: the log line still says it; the next launch tries the notice again.
    appLog('core:agent', 'warn', 'Could not read the removed provider profiles notice', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
    return null;
  }
}
