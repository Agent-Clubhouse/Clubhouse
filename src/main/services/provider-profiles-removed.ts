/**
 * Provider profiles were removed (#2749): every agent runs on its CLI's own
 * login, from the environment Clubhouse starts in. Nothing reads
 * `profiles.json` for launches any more, and the file is kept as it is.
 *
 * Someone who had saved profiles gets one log line, once, saying which projects
 * used one and which variables it set for each CLI, so a changed account or a
 * missing session has an explanation. Only variable names are logged: a
 * profile can hold any value, secrets included, and its values and names are
 * never logged or copied anywhere.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { appLog } from './log-service';
import { peekProjects } from './project-store';
import { readProjectAgentDefaults } from './agent-settings-service';

const PROFILES_FILE = 'profiles.json';
/** Written once the log line is out, so it isn't repeated. Holds no profile data. */
const NOTED_FILE = 'profiles-removed.json';

/** Each saved profile's id, and the variable names it set per CLI. */
type SavedProfiles = Map<string, Record<string, string[]>>;

export type RemovedProfilesOutcome = 'none' | 'noted' | 'already_noted' | 'unreadable';

function readSavedProfiles(raw: string): SavedProfiles | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // telemetry-exempt: an unreadable file is reported once by the caller, without its content
    return null;
  }
  const list = (parsed as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list)) return null;
  const profiles: SavedProfiles = new Map();
  for (const entry of list) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) continue;
    const orchestrators = (entry as { orchestrators?: unknown }).orchestrators;
    const keys: Record<string, string[]> = {};
    if (orchestrators && typeof orchestrators === 'object') {
      for (const [provider, config] of Object.entries(orchestrators as Record<string, unknown>)) {
        const env = (config as { env?: unknown } | null)?.env;
        keys[provider] = env && typeof env === 'object' ? Object.keys(env).sort() : [];
      }
    }
    profiles.set(id, keys);
  }
  return profiles;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    // telemetry-exempt: a missing marker means the line hasn't been logged yet
    return false;
  }
}

/** The projects whose saved defaults still name a profile, with what that profile set. */
async function projectsThatUsedOne(profiles: SavedProfiles): Promise<Array<{ project: string; variables: Record<string, string[]> | 'profile_missing' }>> {
  const used: Array<{ project: string; variables: Record<string, string[]> | 'profile_missing' }> = [];
  for (const project of await peekProjects().catch((): [] => [])) {
    const profileId = await readProjectAgentDefaults(project.path).then((d) => d?.profileId, (): undefined => undefined);
    if (!profileId) continue;
    used.push({ project: project.displayName || project.name, variables: profiles.get(profileId) ?? 'profile_missing' });
  }
  return used;
}

/**
 * Log, once, what saved profiles held. Never deletes or changes `profiles.json`.
 * People with no saved profiles get nothing. Never throws.
 */
export async function noteRemovedProviderProfiles(): Promise<RemovedProfilesOutcome> {
  try {
    const dir = app.getPath('userData');
    const notedFile = path.join(dir, NOTED_FILE);
    if (await exists(notedFile)) return 'already_noted';
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, PROFILES_FILE), 'utf-8');
    } catch {
      // telemetry-exempt: no saved profiles file, nothing to say
      return 'none';
    }
    const profiles = readSavedProfiles(raw);
    let outcome: RemovedProfilesOutcome;
    if (!profiles) {
      appLog('core:agent', 'warn', 'Provider profiles were removed (#2749), and the saved profiles file could not be read. It is kept unchanged; agents run on each CLI\'s own login.');
      outcome = 'unreadable';
    } else if (profiles.size === 0) {
      return 'none';
    } else {
      const projects = await projectsThatUsedOne(profiles);
      appLog('core:agent', 'warn',
        'Provider profiles were removed (#2749). Agents now run on each CLI\'s own login, from the environment Clubhouse starts in. '
        + 'To use another account, sign in to it in that CLI, or start Clubhouse with that CLI\'s variable set (such as CLAUDE_CONFIG_DIR or CODEX_HOME). '
        + 'Sessions saved under a profile\'s config folder start fresh. profiles.json is kept unchanged.',
        { meta: { profileCount: profiles.size, variablesByProfile: [...profiles.values()], projects } },
      );
      outcome = 'noted';
    }
    await fsp.writeFile(notedFile, `${JSON.stringify({ notedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    return outcome;
  } catch (err) {
    // telemetry-exempt: a one-time log line; the next launch tries again.
    appLog('core:agent', 'warn', 'Could not check for removed provider profiles', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
    return 'none';
  }
}
