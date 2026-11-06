import * as fsp from 'fs/promises';
import * as path from 'path';

/** Check documented hook item forms without changing unknown or invalid input. */
function validHookEntry(event: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const kind = item.type ?? 'command';
  const text = (key: string) => typeof item[key] === 'string' && (item[key] as string).trim().length > 0;
  const optionalText = (key: string) => item[key] === undefined || typeof item[key] === 'string';
  const optionalNumber = (key: string) => item[key] === undefined || (typeof item[key] === 'number' && Number.isFinite(item[key]));
  const stringMap = (key: string) => item[key] === undefined || (!!item[key] && typeof item[key] === 'object' && !Array.isArray(item[key]) && Object.values(item[key] as object).every((v) => typeof v === 'string'));
  if (!optionalNumber('timeout') || !optionalNumber('timeoutSec') || !optionalText('matcher')) return false;
  if (kind === 'command') {
    return ['bash', 'powershell', 'command', 'exec'].every(optionalText) &&
      ['bash', 'powershell', 'command', 'exec'].some(text) && optionalText('cwd') &&
      !(item.exec !== undefined && ['bash', 'powershell', 'command'].some((key) => item[key] !== undefined)) &&
      (item.args === undefined || (Array.isArray(item.args) && item.args.every((arg) => typeof arg === 'string'))) &&
      stringMap('env');
  }
  if (kind === 'http') {
    if (!text('url') || !stringMap('headers') ||
        (item.allowedEnvVars !== undefined && (!Array.isArray(item.allowedEnvVars) || !item.allowedEnvVars.every((v) => typeof v === 'string')))) return false;
    try {
      const url = new URL(item.url as string);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const requiresHttps = ['preToolUse', 'PreToolUse', 'permissionRequest', 'PermissionRequest'].includes(event) || item.allowedEnvVars !== undefined;
      return !requiresHttps || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  if (kind === 'prompt') return (event === 'sessionStart' || event === 'SessionStart') && text('prompt');
  // Unknown types may belong to a newer CLI. Refuse to rewrite them, not delete them.
  return false;
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
  const doc = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const hooks = doc?.hooks;
  if (!doc || doc.version !== 1 || !hooks || typeof hooks !== 'object' || Array.isArray(hooks) ||
      Object.entries(hooks).some(([event, entries]) => !Array.isArray(entries) || entries.some((entry) => !validHookEntry(event, entry))) || 'permissions' in doc) {
    throw new Error(`Invalid, unsupported, or conflicting Copilot hooks at ${file}. Review and repair the file, then restart the agent. Copilot hook documents require version 1 and a hooks object with valid event entries; Clubhouse allow/deny rules are not supported there. Clubhouse did not modify it.`);
  }
  return doc;
}

/** Clubhouse terminal callbacks overlap the chat protocol's own callbacks. */
export async function assertNoCopilotTerminalHooksForChat(cwd: string): Promise<void> {
  const doc = await readCopilotHooksConfig(cwd);
  const hooks = doc?.hooks as Record<string, unknown[]> | undefined;
  const hasTerminalHooks = Object.values(hooks ?? {}).some((entries) => entries.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const command = (entry as Record<string, unknown>).bash;
    return typeof command === 'string' && command.includes('CLUBHOUSE_AGENT_ID') && command.includes('CLUBHOUSE_HOOK_NONCE');
  }));
  if (hasTerminalHooks) {
    const file = path.join(cwd, '.github', 'hooks', 'hooks.json');
    throw new Error(`Copilot chat cannot start while Clubhouse terminal hooks remain in ${file}: callbacks could be duplicated. Stop the terminal agent and remove the Clubhouse hooks, then restart chat. Custom hooks were not modified.`);
  }
}
