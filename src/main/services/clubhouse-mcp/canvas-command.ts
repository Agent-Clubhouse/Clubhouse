/**
 * Canvas Command Dispatcher — bridges main-process MCP tool calls to
 * renderer-side canvas operations.
 *
 * Uses ProcessBridge for IPC and registers all canvas commands in the
 * shared CommandRegistry so they're discoverable by MCP tools and the
 * command palette.
 *
 * Follows the same request/response pattern as plugin-tool-registry.ts:
 * 1. Main sends CANVAS_CMD.REQUEST to renderer with a unique callId
 * 2. Renderer executes the canvas operation on canvas-store
 * 3. Renderer sends CANVAS_CMD.RESULT back with callId + result
 * 4. Main resolves the pending promise
 */

import { IPC } from '../../../shared/ipc-channels';
import { ProcessBridge } from './process-bridge';
import { commandRegistry } from '../../../shared/command-registry';
import type { CommandResult, ExecutionContext } from '../../../shared/command-registry';

export interface CanvasCommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const bridge = new ProcessBridge({
  requestChannel: IPC.CANVAS_CMD.REQUEST,
  resultChannel: IPC.CANVAS_CMD.RESULT,
  callIdPrefix: 'cc',
  timeoutMs: 15_000,
  logTag: 'canvas-cmd',
});

/**
 * Send a canvas command to the renderer and wait for the result.
 *
 * This is the primary entry point used by MCP tools in assistant-tools.ts.
 * It routes through the CommandRegistry when the command is registered there,
 * falling back to a direct bridge call for backward compatibility.
 */
export async function sendCanvasCommand(
  command: string,
  args: Record<string, unknown>,
): Promise<CanvasCommandResult> {
  const commandId = `canvas.${command}`;
  const def = commandRegistry.get(commandId);
  if (def) {
    return commandRegistry.execute(commandId, { source: 'mcp' }, args);
  }
  // Fallback: direct bridge call for any unregistered commands
  return bridge.send({ command, args });
}

/**
 * Register the IPC handler that receives results from the renderer,
 * and register all canvas commands in the CommandRegistry.
 * Call once during MCP initialization.
 */
export function registerCanvasCommandHandler(): void {
  bridge.registerHandler();
  registerCanvasCommands();
}

/** For testing: clear pending calls and allow re-registration. */
export function _resetForTesting(): void {
  bridge._resetForTesting();
  commandsRegistered = false;
}

/* ------------------------------------------------------------------ */
/*  Canvas command definitions                                         */
/* ------------------------------------------------------------------ */

/** Metadata for canvas commands registered in the CommandRegistry. */
interface CanvasCommandMeta {
  label: string;
  description: string;
  palette?: { keywords?: string[]; hidden?: boolean };
}

const CANVAS_COMMANDS: Record<string, CanvasCommandMeta> = {
  find_canvas_for_view: {
    label: 'Find Canvas for View',
    description: 'Search all canvases for a view by ID',
    palette: { hidden: true },
  },
  add_canvas: {
    label: 'Create Canvas',
    description: 'Create a new canvas and auto-navigate to it',
    palette: { keywords: ['new', 'canvas', 'create'] },
  },
  list_canvases: {
    label: 'List Canvases',
    description: 'List all canvases for a project',
    palette: { keywords: ['canvases', 'list'] },
  },
  add_view: {
    label: 'Add View',
    description: 'Add a card, zone, anchor, or sticky note to a canvas',
    palette: { keywords: ['card', 'zone', 'add', 'sticky'] },
  },
  move_view: {
    label: 'Move View',
    description: 'Reposition a view on the canvas',
    palette: { hidden: true },
  },
  resize_view: {
    label: 'Resize View',
    description: 'Change the dimensions of a canvas view',
    palette: { hidden: true },
  },
  remove_view: {
    label: 'Remove View',
    description: 'Delete a view from the canvas',
    palette: { keywords: ['delete', 'remove', 'card'] },
  },
  rename_view: {
    label: 'Rename View',
    description: 'Update the display name of a canvas view',
    palette: { hidden: true },
  },
  query_views: {
    label: 'Query Views',
    description: 'Get all views in a canvas',
    palette: { hidden: true },
  },
  query_wires: {
    label: 'Query Wires',
    description: 'Get all wire connections in a canvas',
    palette: { hidden: true },
  },
  connect_views: {
    label: 'Connect Views',
    description: 'Create a wire connection between two canvas views',
    palette: { keywords: ['wire', 'connect', 'bind'] },
  },
  disconnect_views: {
    label: 'Disconnect Views',
    description: 'Remove a wire connection between two canvas views',
    palette: { keywords: ['unwire', 'disconnect', 'unbind'] },
  },
  navigate_to_canvas: {
    label: 'Navigate to Canvas',
    description: 'Switch the UI to show a specific canvas',
    palette: { keywords: ['open', 'goto', 'canvas', 'navigate'] },
  },
  create_from_blueprint: {
    label: 'Create from Blueprint',
    description: 'Create a canvas from a blueprint specification',
    palette: { keywords: ['blueprint', 'template'] },
  },
  export_blueprint: {
    label: 'Export Blueprint',
    description: 'Export a canvas as a JSON blueprint',
    palette: { keywords: ['export', 'blueprint', 'save'] },
  },
  import_blueprint: {
    label: 'Import Blueprint',
    description: 'Import a blueprint and create a canvas from it',
    palette: { keywords: ['import', 'blueprint', 'load'] },
  },
};

let commandsRegistered = false;

function registerCanvasCommands(): void {
  if (commandsRegistered) return;
  commandsRegistered = true;

  for (const [command, meta] of Object.entries(CANVAS_COMMANDS)) {
    commandRegistry.register({
      id: `canvas.${command}`,
      category: 'canvas',
      label: meta.label,
      description: meta.description,
      process: 'renderer',
      palette: meta.palette,
      mcp: { scoping: 'binding' },
      handler: (_context: ExecutionContext, args: Record<string, unknown>): Promise<CommandResult> => {
        return bridge.send({ command, args });
      },
    });
  }
}
