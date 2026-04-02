/**
 * Renderer-side handler for command palette operations from the main process.
 *
 * Listens for CMD_PALETTE.REQUEST via preload bridge, executes the operation,
 * and sends results back via CMD_PALETTE.RESULT.
 */

import { getCommands, findCommand, executeCommand } from './command-palette-registry';

interface CommandPaletteRequest {
  callId: string;
  operation: string;
  args: Record<string, unknown>;
}

interface CommandPaletteResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

function sendResult(callId: string, result: CommandPaletteResult): void {
  window.clubhouse.commandPalette?.sendResult?.(callId, result);
}

const handlers: Record<string, (args: Record<string, unknown>) => CommandPaletteResult> = {
  list_commands(args) {
    const commands = getCommands();
    const category = args.category as string | undefined;

    let filtered = commands;
    if (category) {
      filtered = commands.filter((c) => c.category.toLowerCase() === category.toLowerCase());
    }

    const items = filtered.map((c) => ({
      id: c.id,
      label: c.label,
      category: c.category,
      keywords: c.keywords,
      detail: c.detail,
    }));

    return { success: true, data: items };
  },

  run_command(args) {
    const commandId = args.command_id as string;
    if (!commandId) return { success: false, error: 'command_id is required' };

    const cmd = findCommand(commandId);
    if (!cmd) {
      const available = getCommands().map((c) => c.id).slice(0, 20);
      return {
        success: false,
        error: `Command not found: ${commandId}. Some available commands: ${available.join(', ')}`,
      };
    }

    try {
      executeCommand(commandId);
      return { success: true, data: { command_id: commandId, label: cmd.label } };
    } catch (err) {
      return { success: false, error: `Command execution failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

/**
 * Initialize the command palette IPC handler.
 * Returns a cleanup function.
 */
export function initCommandPaletteHandler(): (() => void) | undefined {
  console.log('[cmd-palette] Handler initializing');
  const cleanup = window.clubhouse.commandPalette?.onRequest?.((request: CommandPaletteRequest) => {
    console.log('[cmd-palette] Request received:', request.operation, request.callId);
    const handler = handlers[request.operation];
    if (!handler) {
      sendResult(request.callId, { success: false, error: `Unknown operation: ${request.operation}` });
      return;
    }
    try {
      const result = handler(request.args);
      sendResult(request.callId, result);
    } catch (err) {
      sendResult(request.callId, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  if (cleanup) {
    console.log('[cmd-palette] Handler ready');
  } else {
    console.warn('[cmd-palette] Handler: preload API not available');
  }
  return cleanup;
}
