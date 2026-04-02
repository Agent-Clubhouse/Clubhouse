/**
 * Imperative command palette registry — provides the current command list
 * outside React component context.
 *
 * The CommandPalette component syncs its hook-derived command list here
 * so that IPC handlers (e.g., assistant MCP tools) can access commands
 * without React hooks.
 */

import type { CommandItem } from './command-registry';

let currentCommands: CommandItem[] = [];

/** Update the global command list (called by CommandPalette on each render). */
export function syncCommands(commands: CommandItem[]): void {
  currentCommands = commands;
}

/** Get the current command list. */
export function getCommands(): CommandItem[] {
  return currentCommands;
}

/** Find a command by ID. */
export function findCommand(id: string): CommandItem | undefined {
  return currentCommands.find((c) => c.id === id);
}

/** Execute a command by ID. Returns true if found and executed. */
export function executeCommand(id: string): boolean {
  const cmd = findCommand(id);
  if (!cmd) return false;
  cmd.execute();
  return true;
}
