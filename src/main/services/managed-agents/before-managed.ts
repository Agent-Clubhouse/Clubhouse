/**
 * Copies of an agent's instructions file from before Clubhouse managed it
 * (#2893, #2901), in `<app data>/managed-agents/before-managed/<agent>`.
 * The switch keeps the file as it was then. A session still running on the
 * old files can change it after that, so the first managed start keeps it
 * again when it differs, before writing the managed one.
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

/** Keep a copy of the instructions file before Clubhouse takes it over, so nothing is lost. */
export async function backupInstructions(agentId: string, file: string, existing: string): Promise<void> {
  if (!existing) return;
  const dir = beforeManagedDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, backupName(file)), existing, 'utf-8');
}

/** After a switch is saved: the first managed start checks the file once more. */
export async function markAwaitingFirstStart(agentId: string): Promise<void> {
  const dir = beforeManagedDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, AWAITING_FIRST_START), new Date().toISOString(), 'utf-8');
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
  if (await readOr(marker, null) === null) return;
  const file = provider.conventions.legacyInstructionsFile;
  let now = '';
  try {
    now = await provider.readInstructions(agent.worktreePath);
  } catch {
    // telemetry-exempt: no instructions file, nothing to keep
  }
  const atSwitch = await readOr(path.join(dir, backupName(file)), '');
  if (now && now !== atSwitch) {
    await fsp.writeFile(path.join(dir, firstStartName(file)), now, 'utf-8');
    appLog('core:managed', 'info', 'Kept the instructions file a session changed after the switch to managed', { meta: { agentId: agent.id } });
  }
  await fsp.rm(marker, { force: true });
}

/** A switch that failed leaves no marker behind. */
export async function clearAwaitingFirstStart(agentId: string): Promise<void> {
  await fsp.rm(path.join(beforeManagedDir(agentId), AWAITING_FIRST_START), { force: true });
}
