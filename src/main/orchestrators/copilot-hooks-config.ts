import { isCopilotHooksDocument, isCopilotClubhouseHookEntry, hasUnrecognizedCopilotCallback } from './copilot-hooks-document';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from '../services/log-service';

/** Where a moved legacy permissions file goes. Not `.json`, so Copilot doesn't read it. */
export const LEGACY_PERMISSIONS_BACKUP_SUFFIX = '.clubhouse-permissions-backup';

/**
 * The exact document older Clubhouse builds wrote to Copilot's hook file
 * (#2866): one `permissions` key holding `allow` and `deny` string lists, and
 * nothing else. Copilot's hook format has no such key, so Copilot rejects it,
 * and no other tool writes this shape there.
 */
export function isLegacyClubhousePermissionsDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'permissions') return false;
  const permissions = (value as { permissions: unknown }).permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  const lists = Object.entries(permissions);
  return lists.length > 0 && lists.every(([key, list]) =>
    (key === 'allow' || key === 'deny') && Array.isArray(list) && list.every((rule) => typeof rule === 'string'));
}

/** Read the one hook document Clubhouse manages, without modifying ambiguous files. */
export async function readCopilotHooksConfig(cwd: string): Promise<Record<string, unknown> | null> {
  const file = path.join(cwd, '.github', 'hooks', 'hooks.json');
  let contents: string;
  try {
    contents = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error(`Cannot read Copilot hooks at ${file}: ${err instanceof Error ? err.message : String(err)}. Fix access and restart the agent.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in Copilot hooks at ${file}. Review and repair the file, then restart the agent. Clubhouse did not modify it.`);
  }
  if (isLegacyClubhousePermissionsDocument(value)) return moveLegacyPermissionsAside(cwd, file, contents);
  if (!isCopilotHooksDocument(value) || hasUnrecognizedCopilotCallback(value)) {
    throw new Error(`Invalid, unsupported, or conflicting Copilot hooks at ${file}. Review and repair the file, then restart the agent. Copilot hook documents require version 1 and a hooks object with valid event entries; Clubhouse allow/deny rules and unrecognized callback markers require manual review. Clubhouse did not modify it.`);
  }
  return value;
}

const moving = new Map<string, Promise<Record<string, unknown> | null>>();

/**
 * Move the legacy file aside, rather than delete it, so its rules can still be
 * read. One move per file at a time: agents starting together in one folder
 * share it, and a later read sees what the first left.
 */
function moveLegacyPermissionsAside(cwd: string, file: string, contents: string): Promise<Record<string, unknown> | null> {
  const running = moving.get(file);
  if (running) return running.then(() => readCopilotHooksConfig(cwd));
  const work = (async () => {
    // Re-check under the lock: another start may have replaced it with a valid document.
    const now = await fsp.readFile(file, 'utf-8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : contents));
    if (now !== contents) return readCopilotHooksConfig(cwd);
    let backup = `${file}${LEGACY_PERMISSIONS_BACKUP_SUFFIX}`;
    // Never replace an earlier backup, whose rules may differ.
    for (let n = 2; await fsp.lstat(backup).then(() => true, () => false); n++) backup = `${file}${LEGACY_PERMISSIONS_BACKUP_SUFFIX}-${n}`;
    try {
      await fsp.rename(file, backup);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return readCopilotHooksConfig(cwd);
      throw new Error(`Copilot hooks at ${file} hold only allow/deny rules written by an earlier Clubhouse, which Copilot rejects, and Clubhouse could not move them aside: ${err instanceof Error ? err.message : String(err)}. Move or delete the file, then restart the agent.`);
    }
    appLog('core:orchestrator', 'warn', 'Moved an invalid Copilot hook file written by an earlier Clubhouse aside', { meta: { file, backup } });
    return null;
  })();
  moving.set(file, work);
  void work.finally(() => { if (moving.get(file) === work) moving.delete(file); }).catch((): void => undefined);
  return work;
}

/** Clubhouse terminal callbacks overlap the chat protocol's own callbacks. */
export async function assertNoCopilotTerminalHooksForChat(cwd: string): Promise<void> {
  const doc = await readCopilotHooksConfig(cwd);
  const hooks = doc?.hooks as Record<string, unknown[]> | undefined;
  const hasTerminalHooks = Object.values(hooks ?? {}).some((entries) => entries.some(isCopilotClubhouseHookEntry));
  if (hasTerminalHooks) {
    const file = path.join(cwd, '.github', 'hooks', 'hooks.json');
    throw new Error(`Copilot chat cannot start while Clubhouse terminal hooks remain in ${file}: callbacks could be duplicated. Stop the terminal agent and remove the Clubhouse hooks, then restart chat. Custom hooks were not modified.`);
  }
}
