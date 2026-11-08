/**
 * Copies of an agent's instructions file from before Clubhouse managed it
 * (#2893, #2901), in `<app data>/managed-agents/before-managed/<agent>`.
 * The switch keeps the file as it was then, never over an earlier copy. A
 * session still running on the old files can change it after that, so the
 * first managed start keeps it again when it differs, before writing the
 * managed one. The folder also holds a switch in progress.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { managedStateDir } from './state-store';
import { appLog } from '../log-service';

/** Set at the switch, cleared by the first managed start. */
const AWAITING_FIRST_START = '.awaiting-first-start';

export function beforeManagedDir(agentId: string): string {
  return path.join(managedStateDir(), 'before-managed', agentId);
}

function backupName(file: string): string {
  return path.basename(file || 'instructions.md');
}

/** "CLAUDE.md" becomes "CLAUDE.first-start.md". */
export function firstStartName(file: string): string {
  const { name, ext } = path.parse(backupName(file));
  return `${name}.first-start${ext}`;
}

/**
 * Write `content` as `name` in `dir`, never over an earlier file: when the
 * name is taken, a time suffix is added (as backupMcpFile does). Returns the
 * name written.
 */
async function writeNew(dir: string, name: string, content: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const stamp = Date.now();
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? name : n === 1 ? `${name}.${stamp}` : `${name}.${stamp}-${n}`;
    try {
      await fsp.writeFile(path.join(dir, candidate), content, { encoding: 'utf-8', flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw Object.assign(new Error('No free backup name'), { code: 'EEXIST' });
}

/**
 * Keep a copy of the instructions file before Clubhouse takes it over, so
 * nothing is lost. An earlier copy, from an earlier switch, is never
 * overwritten. Returns the copy's file name, or null when there was nothing to keep.
 */
export async function backupInstructions(agentId: string, file: string, existing: string): Promise<string | null> {
  if (!existing) return null;
  return writeNew(beforeManagedDir(agentId), backupName(file), existing);
}

/** A switch that failed takes back the copy it made, and the folder when that leaves it empty. */
export async function discardBackup(agentId: string, name: string | null): Promise<void> {
  const dir = beforeManagedDir(agentId);
  if (name) await fsp.rm(path.join(dir, name), { force: true });
  await removeIfEmpty(dir);
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
  } catch {
    // telemetry-exempt: no folder, or something else in it
  }
}

/**
 * After a switch is saved: the first managed start checks the file once
 * more, against `backup`, the copy this switch made.
 */
export async function markAwaitingFirstStart(agentId: string, backup?: string | null): Promise<void> {
  const dir = beforeManagedDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, AWAITING_FIRST_START), JSON.stringify({ at: new Date().toISOString(), ...(backup && { backup }) }), 'utf-8');
}

/** The copy the switch made, from the marker. An older marker holds only a time, and the copy has the plain name. */
function backupFromMarker(marker: string, file: string): string {
  try {
    const parsed = JSON.parse(marker) as { backup?: unknown };
    if (parsed && typeof parsed.backup === 'string' && parsed.backup === path.basename(parsed.backup)) return parsed.backup;
  } catch {
    // telemetry-exempt: an older marker
  }
  return backupName(file);
}

// ── A switch in progress (#2901) ──────────────────────────────────────

/**
 * Written before a switch makes any part, with the ids of the parts it made
 * so far, and removed once it is saved or undone. A switch cut short (the
 * app quit or crashed) leaves it, and the next switch of that agent removes
 * those parts first, so there are no duplicates.
 */
const PENDING = '.switch-pending.json';

export interface PendingSwitch {
  startedAt: string;
  parts: string[];
}

export async function readPendingSwitch(agentId: string): Promise<PendingSwitch | null> {
  const raw = await readOr(path.join(beforeManagedDir(agentId), PENDING), null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSwitch>;
    return {
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      parts: Array.isArray(parsed.parts) ? parsed.parts.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    // telemetry-exempt: a file cut short; there are no ids to remove
    return { startedAt: '', parts: [] };
  }
}

export async function writePendingSwitch(agentId: string, pending: PendingSwitch): Promise<void> {
  const dir = beforeManagedDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, PENDING);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(pending), 'utf-8');
  await fsp.rename(tmp, file);
}

export async function clearPendingSwitch(agentId: string): Promise<void> {
  const dir = beforeManagedDir(agentId);
  await fsp.rm(path.join(dir, PENDING), { force: true });
  await removeIfEmpty(dir);
}

/**
 * Whether the agent was switched to managed before (D59): its before-managed
 * folder exists with no switch in progress in it. Covers agents switched
 * before the switched-once marker was kept on the agent.
 */
export async function switchedBefore(agentId: string): Promise<boolean> {
  const dir = beforeManagedDir(agentId);
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return false;
  } catch {
    // telemetry-exempt: no folder, never switched
    return false;
  }
  return (await readPendingSwitch(agentId)) === null;
}

async function readOr(file: string, fallback: string | null): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    // telemetry-exempt: no such file
    return fallback;
  }
}

/**
 * At the first managed start after a switch, before the managed instructions
 * are written: when the file in the agent's folder differs from the copy kept
 * at the switch (a running session changed it), keep it too, as
 * `<name>.first-start<ext>` beside that copy. Does nothing at later starts.
 * Throws when it can't keep the copy, so the start doesn't overwrite it.
 */
export async function keepInstructionsAtFirstStart(agent: DurableAgentConfig, provider: OrchestratorProvider): Promise<void> {
  if (!agent.worktreePath) return;
  const dir = beforeManagedDir(agent.id);
  const marker = path.join(dir, AWAITING_FIRST_START);
  const markerText = await readOr(marker, null);
  if (markerText === null) return;
  const file = provider.conventions.legacyInstructionsFile;
  let now = '';
  try {
    now = await provider.readInstructions(agent.worktreePath);
  } catch {
    // telemetry-exempt: no instructions file, nothing to keep
  }
  const atSwitch = await readOr(path.join(dir, backupFromMarker(markerText, file)), '');
  if (now && now !== atSwitch) {
    await writeNew(dir, firstStartName(file), now);
    appLog('core:managed', 'info', 'Kept the instructions file a session changed after the switch to managed', { meta: { agentId: agent.id } });
  }
  await fsp.rm(marker, { force: true });
}

/** A switch that failed leaves no marker behind. */
export async function clearAwaitingFirstStart(agentId: string): Promise<void> {
  await fsp.rm(path.join(beforeManagedDir(agentId), AWAITING_FIRST_START), { force: true });
}
