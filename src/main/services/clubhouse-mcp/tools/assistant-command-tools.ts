import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import { requireString } from './validation';

/** Register command palette access tools (list_commands, run_command). */
export function registerCommandTools(): void {

// ── Command Palette Access ────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'list_commands'),
  category: 'assistant',
  label: 'List Commands',
  targetKind: 'assistant',
  nameSuffix: 'list_commands',
  description:
    'List all available command palette commands. Returns an array of { id, label, category, keywords, detail }. ' +
    'Use this to discover what navigation and action commands are available, then use run_command to execute them. ' +
    'Commands include: navigating to projects, agents, canvases, hubs, settings pages, and app actions. ' +
    'Optionally filter by category: "Projects", "Agents", "Spaces", "Navigation", "Settings", "Actions".',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional category filter (e.g. "Spaces", "Navigation", "Actions").',
      },
    },
  },
  handler: async (_t, _a, args) => {
  const { sendCommandPaletteRequest } = await import('../command-palette-bridge');
  const { commandRegistry } = await import('../../../../shared/command-registry');

  // Merge: palette commands from renderer + registry commands from main
  const paletteResult = await sendCommandPaletteRequest('list_commands', { category: args.category });
  const paletteFailed = !paletteResult.success;
  const paletteItems: Array<{ id: string; label: string; category: string; keywords?: string[]; detail?: string }> =
    paletteResult.success ? (paletteResult.data as any[]) || [] : [];

  // Add registry-only commands (not already in palette) for discoverability
  const paletteIds = new Set(paletteItems.map((c) => c.id));
  const registryCommands = commandRegistry.list(
    args.category ? { category: requireString(args, 'category') } : undefined,
  );
  const registryItems = registryCommands
    .filter((c) => !c.palette?.hidden && !paletteIds.has(c.id))
    .map((c) => ({
      id: c.id,
      label: c.label,
      category: c.category,
      keywords: c.palette?.keywords || [],
      detail: c.description,
    }));

  const allItems = [...paletteItems, ...registryItems];

  // If palette failed and registry is also empty, propagate the error
  if (paletteFailed && allItems.length === 0) {
    return { content: [{ type: 'text', text: paletteResult.error || 'Failed to list commands' }], isError: true };
  }

  // Include partial indicator when palette failed but registry had results
  const result: Record<string, unknown> = { commands: allItems };
  if (paletteFailed) {
    result.partial = true;
    result.warning = 'Command palette unavailable — showing registry commands only';
  }
  return { content: [{ type: 'text', text: JSON.stringify(paletteFailed ? result : allItems) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'run_command'),
  category: 'assistant',
  label: 'Run Command',
  targetKind: 'assistant',
  nameSuffix: 'run_command',
  description:
    'Execute a command palette command by its ID. Use list_commands first to discover available commands. ' +
    'This gives you full app navigation and control: open projects, switch to canvases/hubs, ' +
    'toggle settings, open the assistant panel, and more. ' +
    'Example IDs: "canvas:project:CANVAS_ID", "project:PROJECT_ID", "agent:AGENT_ID", ' +
    '"nav:agents", "nav:home", "action:toggle-settings".',
  inputSchema: {
    type: 'object',
    properties: {
      command_id: {
        type: 'string',
        description: 'The command ID to execute (from list_commands output).',
      },
    },
    required: ['command_id'],
  },
  handler: async (_t, _a, args) => {
  const { commandRegistry } = await import('../../../../shared/command-registry');

  // Try CommandRegistry first (handles canvas.* and future commands)
  const commandId = requireString(args, 'command_id');
  const registryDef = commandRegistry.get(commandId);
  if (registryDef) {
    const { command_id: _, ...commandArgs } = args;
    const result = await commandRegistry.execute(commandId, { source: 'mcp' }, commandArgs);
    if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to run command' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  }

  // Fall back to command palette bridge for palette-only commands
  const { sendCommandPaletteRequest } = await import('../command-palette-bridge');
  const result = await sendCommandPaletteRequest('run_command', { command_id: commandId });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to run command' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});

}
