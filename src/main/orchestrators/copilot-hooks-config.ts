import * as fsp from 'fs/promises';
import * as path from 'path';

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
      Object.values(hooks).some((entries) => !Array.isArray(entries)) || 'permissions' in doc) {
    throw new Error(`Invalid or conflicting Copilot hooks at ${file}. Review and repair the file, then restart the agent. Copilot hook documents require version 1 and a hooks object with event arrays; Clubhouse allow/deny rules are not supported there. Clubhouse did not modify it.`);
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
