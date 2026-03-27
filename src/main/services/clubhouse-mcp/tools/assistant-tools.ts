/**
 * MCP tools for the Clubhouse Assistant agent.
 *
 * Read-only tools (Phase 3) let the assistant understand app state.
 * Write tools (Phase 4) let the assistant configure projects, agents, and settings.
 * Canvas tools (Phase 5) let the assistant build visual workflows.
 *
 * All tools are registered as 'assistant' target kind and scoped exclusively
 * to the assistant agent via a binding.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { registerToolTemplate } from '../tool-registry';
import * as projectStore from '../../project-store';
import { listDurable, createDurable, updateDurable, updateDurableConfig, deleteDurable } from '../../agent-config';
import { getAvailableOrchestrators, checkAvailability, resolveOrchestrator } from '../../agent-system';
import { appLog } from '../../log-service';
import { AGENT_COLORS } from '../../../../shared/name-generator';
import { sendCanvasCommand } from '../canvas-command';
import { computeLayout } from '../canvas-layout';

/**
 * Register all assistant MCP tools (read + write).
 * Call once at MCP system initialization.
 */
export function registerAssistantTools(): void {
  appLog('core:mcp', 'info', 'Registering assistant MCP tools');

// ── Filesystem Tools ───────────────────────────────────────────────────────

registerToolTemplate(
  'assistant',
  'find_git_repos',
  {
    description:
      'Scan a directory for git repositories. Returns paths where a .git directory exists. ' +
      'Useful for helping users find their projects on disk. Max depth 2 for safety.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'The directory to scan (e.g. ~/code, ~/projects).',
        },
        depth: {
          type: 'number',
          description: 'Max depth to search. Defaults to 2, max 2.',
        },
      },
      required: ['directory'],
    },
  },
  async (_targetId, _agentId, args) => {
    const dir = args.directory as string;
    const maxDepth = Math.min((args.depth as number) || 2, 2);
    const repos: string[] = [];

    async function scan(currentDir: string, depth: number): Promise<void> {
      if (depth > maxDepth) return;
      try {
        const entries = await fsp.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') && entry.name !== '.git') continue;
          const fullPath = path.join(currentDir, entry.name);
          if (entry.name === '.git') {
            repos.push(currentDir);
            return; // Don't recurse into .git
          }
          await scan(fullPath, depth + 1);
        }
      } catch {
        // Permission denied or not a directory — skip
      }
    }

    const resolvedDir = dir.replace(/^~/, process.env.HOME || '/tmp');
    await scan(resolvedDir, 0);

    return {
      content: [{
        type: 'text',
        text: repos.length > 0
          ? `Found ${repos.length} git repo(s):\n${repos.map(r => `  - ${r}`).join('\n')}`
          : `No git repositories found in ${dir} (searched ${maxDepth} levels deep).`,
      }],
    };
  },
);

registerToolTemplate(
  'assistant',
  'check_path',
  {
    description: 'Check if a path exists and whether it is a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to check.',
        },
      },
      required: ['path'],
    },
  },
  async (_targetId, _agentId, args) => {
    const targetPath = (args.path as string).replace(/^~/, process.env.HOME || '/tmp');
    try {
      const stat = await fsp.stat(targetPath);
      const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unknown';
      return {
        content: [{ type: 'text', text: JSON.stringify({ exists: true, type, size: stat.size }) }],
      };
    } catch {
      return {
        content: [{ type: 'text', text: JSON.stringify({ exists: false, type: 'unknown' }) }],
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'list_directory',
  {
    description: 'List the contents of a directory with file types.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to list.',
        },
      },
      required: ['path'],
    },
  },
  async (_targetId, _agentId, args) => {
    const targetPath = (args.path as string).replace(/^~/, process.env.HOME || '/tmp');
    try {
      const entries = await fsp.readdir(targetPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .slice(0, 100) // Cap at 100 entries
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
      return {
        content: [{ type: 'text', text: JSON.stringify(items) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── App State Tools ────────────────────────────────────────────────────────

registerToolTemplate(
  'assistant',
  'list_projects',
  {
    description: 'List all projects configured in Clubhouse with their paths and git status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async (_targetId, _agentId, _args) => {
    try {
      const projects = await projectStore.list();
      const result = projects.map(p => ({
        id: p.id,
        name: p.displayName || p.name,
        path: p.path,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to list projects: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'list_agents',
  {
    description: 'List durable agents configured in a specific project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'The project directory path.',
        },
      },
      required: ['project_path'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectPath = args.project_path as string;
    try {
      const agents = await listDurable(projectPath);
      const result = agents.map(a => ({
        id: a.id,
        name: a.name,
        color: a.color,
        model: a.model,
        hasWorktree: !!a.worktreePath,
        orchestrator: a.orchestrator,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to list agents: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'get_app_state',
  {
    description:
      'Get a summary of the current Clubhouse app state including project count and orchestrator info.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async (_targetId, _agentId, _args) => {
    try {
      const projects = await projectStore.list();
      const orchestrators = getAvailableOrchestrators();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projectCount: projects.length,
            projects: projects.map(p => ({ id: p.id, name: p.displayName || p.name })),
            orchestrators: orchestrators.map(o => ({
              id: o.id,
              displayName: o.displayName,
            })),
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to get app state: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'get_orchestrators',
  {
    description: 'List available orchestrators and their status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async (_targetId, _agentId, _args) => {
    try {
      const orchestrators = getAvailableOrchestrators();
      const results = [];
      for (const o of orchestrators) {
        const availability = await checkAvailability(undefined, o.id);
        results.push({
          id: o.id,
          displayName: o.displayName,
          available: availability.available,
          error: availability.error,
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(results) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to get orchestrators: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Help Content Tools ─────────────────────────────────────────────────────

// Help content is compiled into the main process bundle via raw imports.
// We use dynamic requires here since help content lives in the renderer bundle.
// Instead, the assistant's system prompt already contains all help content.
// These tools provide search capability for targeted lookups.

registerToolTemplate(
  'assistant',
  'search_help',
  {
    description:
      'Search Clubhouse help content by keyword. Returns matching topics with snippets. ' +
      'Use this when the user asks about a specific feature and you need more detail ' +
      'than what is in your system prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
  async (_targetId, _agentId, args) => {
    const query = args.query as string;
    // Help search runs in the renderer. For the main process, we return a hint
    // that the system prompt already contains the help content.
    return {
      content: [{
        type: 'text',
        text: `Your system prompt contains all Clubhouse help documentation. ` +
          `Search your instructions for "${query}" to find relevant information. ` +
          `The help content covers: Getting Started, Dashboard, Command Palette, ` +
          `Hub & Workspaces, Navigation, Keyboard Shortcuts, Projects, Git Integration, ` +
          `Agents (Durable, Quick, Clubhouse Mode), Orchestrators, Plugins, Settings, ` +
          `and Troubleshooting.`,
      }],
    };
  },
);

// ── Plugin & Settings Tools ────────────────────────────────────────────────

registerToolTemplate(
  'assistant',
  'get_settings',
  {
    description: 'Get current Clubhouse app settings (theme, notifications, etc.).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async (_targetId, _agentId, _args) => {
    // Settings are managed via renderer stores. For the main process,
    // read the settings file from the standard location.
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      const raw = await fsp.readFile(settingsPath, 'utf-8');
      return {
        content: [{ type: 'text', text: raw }],
      };
    } catch {
      return {
        content: [{ type: 'text', text: '{}' }],
      };
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// WRITE TOOLS (Phase 4)
// ══════════════════════════════════════════════════════════════════════════

// ── Project Write Tools ────────────────────────────────────────────────────

registerToolTemplate(
  'assistant',
  'add_project',
  {
    description:
      'Add a directory as a Clubhouse project. The directory should exist on disk. ' +
      'After adding, the project appears in the sidebar and agents can be created for it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project directory.',
        },
      },
      required: ['path'],
    },
  },
  async (_targetId, _agentId, args) => {
    const dirPath = (args.path as string).replace(/^~/, process.env.HOME || '/tmp');
    try {
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) {
        return { content: [{ type: 'text', text: `Path is not a directory: ${dirPath}` }], isError: true };
      }
      const project = await projectStore.add(dirPath);
      return {
        content: [{ type: 'text', text: `Project "${project.name}" added successfully (id: ${project.id}, path: ${project.path}).` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to add project: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'remove_project',
  {
    description:
      'Remove a project from Clubhouse. This does NOT delete any files on disk — ' +
      'it only removes the project from Clubhouse\'s tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID (from list_projects).',
        },
      },
      required: ['project_id'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectId = args.project_id as string;
    try {
      await projectStore.remove(projectId);
      return {
        content: [{ type: 'text', text: `Project ${projectId} removed from Clubhouse.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to remove project: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'update_project',
  {
    description: 'Update a project\'s display name or color.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'The project ID.',
        },
        display_name: {
          type: 'string',
          description: 'New display name for the project.',
        },
        color: {
          type: 'string',
          description: 'New color for the project.',
        },
      },
      required: ['project_id'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectId = args.project_id as string;
    const updates: Record<string, string> = {};
    if (args.display_name) updates.displayName = args.display_name as string;
    if (args.color) updates.color = args.color as string;
    try {
      await projectStore.update(projectId, updates);
      return {
        content: [{ type: 'text', text: `Project ${projectId} updated.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to update project: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Agent Write Tools ──────────────────────────────────────────────────────

registerToolTemplate(
  'assistant',
  'create_agent',
  {
    description:
      'Create a new durable agent in a project. Has full parity with the Create Agent dialog. ' +
      'Returns the created agent\'s ID and configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'The project directory path.',
        },
        name: {
          type: 'string',
          description: 'Agent name. Auto-generated if omitted.',
        },
        color: {
          type: 'string',
          description: `Agent color ID. Options: ${AGENT_COLORS.map(c => c.id).join(', ')}. Defaults to "${AGENT_COLORS[0]?.id || 'emerald'}".`,
        },
        model: {
          type: 'string',
          description: 'Model identifier (e.g. "claude-opus", "claude-sonnet"). Falls back to orchestrator default if omitted.',
        },
        orchestrator: {
          type: 'string',
          description: 'Orchestrator ID (e.g. "claude-code", "copilot-cli", "codex-cli"). Falls back to project/app default if omitted.',
        },
        use_worktree: {
          type: 'boolean',
          description: 'Whether to create an isolated git worktree. Defaults to true.',
        },
        free_agent_mode: {
          type: 'boolean',
          description: 'Whether to enable free agent mode (skip all permission prompts). Defaults to project default.',
        },
        mcp_ids: {
          type: 'string',
          description: 'Comma-separated list of MCP server IDs to attach to this agent.',
        },
      },
      required: ['project_path'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectPath = args.project_path as string;
    const name = (args.name as string) || `agent-${Date.now().toString(36).slice(-4)}`;
    const color = (args.color as string) || AGENT_COLORS[0]?.id || 'emerald';
    const model = args.model as string | undefined;
    const useWorktree = args.use_worktree !== false; // default true
    const orchestrator = args.orchestrator as string | undefined;
    const freeAgentMode = args.free_agent_mode as boolean | undefined;
    const mcpIds = args.mcp_ids ? (args.mcp_ids as string).split(',').map(s => s.trim()).filter(Boolean) : undefined;

    try {
      const agent = await createDurable(
        projectPath,
        name,
        color,
        model,
        useWorktree,
        orchestrator,
        freeAgentMode,
        mcpIds,
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message: `Agent "${agent.name}" created successfully.`,
            id: agent.id,
            name: agent.name,
            color: agent.color,
            hasWorktree: !!agent.worktreePath,
            worktreePath: agent.worktreePath,
            model: agent.model,
            orchestrator: agent.orchestrator,
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to create agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'update_agent',
  {
    description:
      'Update a durable agent\'s configuration. Can change model, orchestrator, ' +
      'free agent mode, clubhouse mode override, name, and color.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'The project directory path.',
        },
        agent_id: {
          type: 'string',
          description: 'The agent ID.',
        },
        name: {
          type: 'string',
          description: 'New agent name.',
        },
        color: {
          type: 'string',
          description: 'New agent color.',
        },
        model: {
          type: 'string',
          description: 'New model identifier.',
        },
        orchestrator: {
          type: 'string',
          description: 'New orchestrator ID.',
        },
        free_agent_mode: {
          type: 'boolean',
          description: 'Enable or disable free agent mode.',
        },
        clubhouse_mode_override: {
          type: 'boolean',
          description: 'Override for Clubhouse mode behavior.',
        },
      },
      required: ['project_path', 'agent_id'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectPath = args.project_path as string;
    const agentId = args.agent_id as string;
    try {
      // Update basic fields (name, color) via updateDurable
      const basicUpdates: Record<string, string | undefined> = {};
      if (args.name !== undefined) basicUpdates.name = args.name as string;
      if (args.color !== undefined) basicUpdates.color = args.color as string;
      if (Object.keys(basicUpdates).length > 0) {
        await updateDurable(projectPath, agentId, basicUpdates);
      }

      // Update config fields (model, orchestrator, freeAgentMode, etc.) via updateDurableConfig
      const configUpdates: Record<string, unknown> = {};
      if (args.model !== undefined) configUpdates.model = args.model as string;
      if (args.orchestrator !== undefined) configUpdates.orchestrator = args.orchestrator as string;
      if (args.free_agent_mode !== undefined) configUpdates.freeAgentMode = args.free_agent_mode as boolean;
      if (args.clubhouse_mode_override !== undefined) configUpdates.clubhouseModeOverride = args.clubhouse_mode_override as boolean;
      if (Object.keys(configUpdates).length > 0) {
        await updateDurableConfig(projectPath, agentId, configUpdates as any);
      }

      return {
        content: [{ type: 'text', text: `Agent ${agentId} updated successfully.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to update agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'delete_agent',
  {
    description:
      'Delete a durable agent from a project. This removes the agent\'s configuration ' +
      'and worktree (if any). This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'The project directory path.',
        },
        agent_id: {
          type: 'string',
          description: 'The agent ID to delete.',
        },
      },
      required: ['project_path', 'agent_id'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectPath = args.project_path as string;
    const agentId = args.agent_id as string;
    try {
      await deleteDurable(projectPath, agentId);
      return {
        content: [{ type: 'text', text: `Agent ${agentId} deleted.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to delete agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

registerToolTemplate(
  'assistant',
  'write_agent_instructions',
  {
    description:
      'Write or update the CLAUDE.md (or equivalent) instructions file for an agent. ' +
      'Uses the correct file path for the agent\'s orchestrator.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'The project directory path (or agent worktree path).',
        },
        content: {
          type: 'string',
          description: 'The full markdown content to write as the agent\'s instructions.',
        },
        orchestrator: {
          type: 'string',
          description: 'Orchestrator ID to determine file path. Defaults to project default.',
        },
      },
      required: ['project_path', 'content'],
    },
  },
  async (_targetId, _agentId, args) => {
    const projectPath = args.project_path as string;
    const content = args.content as string;
    const orchestratorId = args.orchestrator as string | undefined;
    try {
      const provider = await resolveOrchestrator(projectPath, orchestratorId);
      await provider.writeInstructions(projectPath, content);
      return {
        content: [{ type: 'text', text: `Instructions written for ${provider.displayName} at ${projectPath}.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to write instructions: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Settings Write Tool ────────────────────────────────────────────────────

registerToolTemplate(
  'assistant',
  'update_settings',
  {
    description:
      'Update a Clubhouse app setting. Reads the current settings, merges the update, and writes back.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The settings key to update (e.g. "theme", "soundEnabled").',
        },
        value: {
          type: 'string',
          description: 'The new value (as a JSON string for non-string values, e.g. "true", "42", or \'"dark"\').',
        },
      },
      required: ['key', 'value'],
    },
  },
  async (_targetId, _agentId, args) => {
    const key = args.key as string;
    const rawValue = args.value as string;
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        const raw = await fsp.readFile(settingsPath, 'utf-8');
        settings = JSON.parse(raw);
      } catch {
        // File doesn't exist or is invalid — start fresh
      }

      // Try to parse the value as JSON (for booleans, numbers, objects)
      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue; // Use as plain string
      }

      settings[key] = value;
      await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return {
        content: [{ type: 'text', text: `Setting "${key}" updated to ${JSON.stringify(value)}.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to update settings: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// CANVAS TOOLS (Phase 5)
// ══════════════════════════════════════════════════════════════════════════

registerToolTemplate('assistant', 'create_canvas', {
  description: 'Create a new canvas tab. Returns the canvas ID.',
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Canvas name. Auto-generated if omitted.' } } },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('add_canvas', { name: args.name });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to create canvas' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

registerToolTemplate('assistant', 'list_canvases', {
  description: 'List all canvases with their IDs, names, and card counts.',
  inputSchema: { type: 'object', properties: {} },
}, async (_t, _a, _args) => {
  const result = await sendCanvasCommand('list_canvases', {});
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to list canvases' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

registerToolTemplate('assistant', 'add_card', {
  description:
    'Add a card to a canvas. Types: "agent" (for durable agents), "zone" (grouping container), "anchor" (text note). ' +
    'For agent cards, provide agent_id and project_id to bind a real agent — otherwise the card is a placeholder that must be assigned in the UI.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      type: { type: 'string', description: 'Card type: "agent", "zone", or "anchor".' },
      display_name: { type: 'string', description: 'Display name for the card.' },
      agent_id: { type: 'string', description: 'For agent cards: the durable agent ID (from list_agents) to bind to this card.' },
      project_id: { type: 'string', description: 'For agent cards: the project ID the agent belongs to (from list_projects).' },
      position_x: { type: 'number', description: 'X position (default 100).' },
      position_y: { type: 'number', description: 'Y position (default 100).' },
      width: { type: 'number', description: 'Width in pixels (default 300).' },
      height: { type: 'number', description: 'Height in pixels (default 200).' },
    },
    required: ['canvas_id', 'type'],
  },
}, async (_t, _a, args) => {
  const cmdArgs: Record<string, unknown> = {
    canvas_id: args.canvas_id, type: args.type, display_name: args.display_name,
    agent_id: args.agent_id, project_id: args.project_id,
  };
  if (args.position_x !== undefined || args.position_y !== undefined) {
    cmdArgs.position = { x: args.position_x || 100, y: args.position_y || 100 };
  }
  if (args.width !== undefined || args.height !== undefined) {
    cmdArgs.size = { w: args.width || 300, h: args.height || 200 };
  }
  const result = await sendCanvasCommand('add_view', cmdArgs);
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to add card' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

registerToolTemplate('assistant', 'move_card', {
  description: 'Move a card to a new position on the canvas.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      view_id: { type: 'string', description: 'Card view ID.' },
      x: { type: 'number', description: 'New X position.' },
      y: { type: 'number', description: 'New Y position.' },
    },
    required: ['canvas_id', 'view_id', 'x', 'y'],
  },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('move_view', { canvas_id: args.canvas_id, view_id: args.view_id, position: { x: args.x, y: args.y } });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to move card' }], isError: true };
  return { content: [{ type: 'text', text: 'Card moved.' }] };
});

registerToolTemplate('assistant', 'resize_card', {
  description: 'Resize a card on the canvas.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      view_id: { type: 'string', description: 'Card view ID.' },
      width: { type: 'number', description: 'New width.' },
      height: { type: 'number', description: 'New height.' },
    },
    required: ['canvas_id', 'view_id', 'width', 'height'],
  },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('resize_view', { canvas_id: args.canvas_id, view_id: args.view_id, size: { w: args.width, h: args.height } });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to resize card' }], isError: true };
  return { content: [{ type: 'text', text: 'Card resized.' }] };
});

registerToolTemplate('assistant', 'remove_card', {
  description: 'Remove a card from the canvas.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      view_id: { type: 'string', description: 'Card view ID to remove.' },
    },
    required: ['canvas_id', 'view_id'],
  },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('remove_view', { canvas_id: args.canvas_id, view_id: args.view_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to remove card' }], isError: true };
  return { content: [{ type: 'text', text: 'Card removed.' }] };
});

registerToolTemplate('assistant', 'rename_card', {
  description: 'Rename a card on the canvas.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      view_id: { type: 'string', description: 'Card view ID.' },
      name: { type: 'string', description: 'New display name.' },
    },
    required: ['canvas_id', 'view_id', 'name'],
  },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('rename_view', { canvas_id: args.canvas_id, view_id: args.view_id, name: args.name });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to rename card' }], isError: true };
  return { content: [{ type: 'text', text: 'Card renamed.' }] };
});

registerToolTemplate('assistant', 'connect_cards', {
  description: 'Create a wire (MCP binding) between two cards. Source must be an agent card.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      source_view_id: { type: 'string', description: 'Source card view ID (must be an agent card).' },
      target_view_id: { type: 'string', description: 'Target card view ID.' },
    },
    required: ['canvas_id', 'source_view_id', 'target_view_id'],
  },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('connect_views', { canvas_id: args.canvas_id, source_view_id: args.source_view_id, target_view_id: args.target_view_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to connect cards' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

registerToolTemplate('assistant', 'layout_canvas', {
  description: 'Auto-arrange cards. Patterns: "horizontal" (row), "vertical" (column), "grid", "hub_spoke" (center + circle).',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      pattern: { type: 'string', description: 'Layout: "horizontal", "vertical", "grid", or "hub_spoke".' },
    },
    required: ['canvas_id', 'pattern'],
  },
}, async (_t, _a, args) => {
  const canvasId = args.canvas_id as string;
  const pattern = args.pattern as 'horizontal' | 'vertical' | 'grid' | 'hub_spoke';

  const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
  if (!queryResult.success) return { content: [{ type: 'text', text: queryResult.error || 'Failed to query views' }], isError: true };

  const views = queryResult.data as Array<{ id: string; size: { width: number; height: number } }>;
  if (!views || views.length === 0) return { content: [{ type: 'text', text: 'No cards to arrange.' }] };

  const positions = computeLayout(pattern, views.map(v => ({ id: v.id, width: v.size.width, height: v.size.height })));
  for (const pos of positions) {
    await sendCanvasCommand('move_view', { canvas_id: canvasId, view_id: pos.id, position: { x: pos.x, y: pos.y } });
  }
  return { content: [{ type: 'text', text: `Arranged ${views.length} cards in "${pattern}" layout.` }] };
});

// ── Plugin Tools ───────────────────────────────────────────────────────────
// NOTE: Plugin enable/disable lives in the renderer store (plugin-store.ts)
// and has no main-process API. These tools will be added when renderer-side
// IPC for plugin management is available.

} // end registerAssistantTools
