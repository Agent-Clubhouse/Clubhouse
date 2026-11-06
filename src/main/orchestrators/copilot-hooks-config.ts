import { isCopilotHooksDocument, isCopilotClubhouseHookEntry, hasUnrecognizedCopilotCallback } from './copilot-hooks-document';
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
