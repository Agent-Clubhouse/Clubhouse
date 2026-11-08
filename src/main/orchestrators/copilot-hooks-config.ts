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
  if (isLegacyClubhousePermissionsDocument(value)) {
    // Moved aside rather than deleted, so its rules can still be read. Nothing
    // else is in it: a file with any other key is left for manual review below.
    const backup = `${file}${LEGACY_PERMISSIONS_BACKUP_SUFFIX}`;
    try {
      await fsp.rename(file, backup);
    } catch (err) {
      throw new Error(`Copilot hooks at ${file} hold only allow/deny rules written by an earlier Clubhouse, which Copilot rejects, and Clubhouse could not move them aside: ${err instanceof Error ? err.message : String(err)}. Move or delete the file, then restart the agent.`);
    }
    appLog('core:orchestrator', 'warn', 'Moved an invalid Copilot hook file written by an earlier Clubhouse aside', { meta: { file, backup } });
    return null;
  }
  if (!isCopilotHooksDocument(value) || hasUnrecognizedCopilotCallback(value)) {
    throw new Error(`Invalid, unsupported, or conflicting Copilot hooks at ${file}. Review and repair the file, then restart the agent. Copilot hook documents require version 1 and a hooks object with valid event entries; Clubhouse allow/deny rules and unrecognized callback markers require manual review. Clubhouse did not modify it.`);
  }
  return value;
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
