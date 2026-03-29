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
import { app, BrowserWindow } from 'electron';
import { registerToolTemplate } from '../tool-registry';
import * as projectStore from '../../project-store';
import { listDurable, createDurable, updateDurable, updateDurableConfig, deleteDurable } from '../../agent-config';
import { getAvailableOrchestrators, checkAvailability, resolveOrchestrator } from '../../agent-system';
import { appLog } from '../../log-service';
import * as themeService from '../../theme-service';
import { AGENT_COLORS } from '../../../../shared/name-generator';
import { sendCanvasCommand } from '../canvas-command';
import { computeLayout } from '../canvas-layout';
import { HELP_SECTIONS } from '../../../../renderer/features/help/help-content';
import { searchHelpTopics } from '../../../../renderer/features/help/help-search';
import { getPersonaTemplate, getPersonaIds } from '../../../../renderer/features/assistant/content/personas';
import { IPC } from '../../../../shared/ipc-channels';
import { BUILTIN_THEMES } from '../../../../renderer/themes';

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
        icon: a.icon || null,
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

// Help content and search are imported from the renderer help module at the top
// of this file. The markdown files are bundled as asset/source by webpack, and
// the search function is a pure TS module with no renderer dependencies.

registerToolTemplate(
  'assistant',
  'search_help',
  {
    description:
      'Search Clubhouse help content by keyword. Returns matching topics with full content. ' +
      'Use this to retrieve detailed information about any Clubhouse feature. ' +
      'Your system prompt lists available topics — call this tool to get the full article.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g. "canvas", "durable agents", "keyboard shortcuts").',
        },
      },
      required: ['query'],
    },
  },
  async (_targetId, _agentId, args) => {
    const query = args.query as string;
    const results = searchHelpTopics(HELP_SECTIONS, query);

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No help topics matched "${query}". Available sections: ${HELP_SECTIONS.map((s) => s.title).join(', ')}.`,
        }],
      };
    }

    // Return top 3 results with full content for the best match, snippets for the rest
    const topResults = results.slice(0, 3);
    const output = topResults
      .map((r, i) => {
        const header = `## ${r.sectionTitle}: ${r.topic.title} (score: ${r.score})`;
        if (i === 0) {
          // Full content for the best match
          return `${header}\n\n${r.topic.content}`;
        }
        // Snippet + title for subsequent matches
        const snippet = r.snippet ? `\n\n> ${r.snippet}` : '';
        return `${header}${snippet}\n\n_Use search_help("${r.topic.title.toLowerCase()}") for full content._`;
      })
      .join('\n\n---\n\n');

    return {
      content: [{ type: 'text', text: output }],
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

registerToolTemplate(
  'assistant',
  'list_themes',
  {
    description:
      'List all available themes with their IDs, names, and types (dark/light). ' +
      'Use the theme ID with update_settings(key: "theme", value: "<id>") to change the theme.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async () => {
    const currentSettings = themeService.getSettings() || { themeId: 'catppuccin-mocha' };
    const themes = Object.values(BUILTIN_THEMES).map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
    }));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          currentTheme: currentSettings.themeId,
          availableThemes: themes,
        }, null, 2),
      }],
    };
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
        persona: {
          type: 'string',
          description:
            `Persona template ID. Auto-injects role-specific instructions into the agent's CLAUDE.md. ` +
            `Options: ${getPersonaIds().join(', ')}.`,
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
    const personaId = args.persona as string | undefined;

    // Validate persona ID if provided
    if (personaId && !getPersonaTemplate(personaId)) {
      return {
        content: [{
          type: 'text',
          text: `Unknown persona "${personaId}". Valid options: ${getPersonaIds().join(', ')}.`,
        }],
        isError: true,
      };
    }

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
        undefined, // structuredMode
        personaId,
      );

      // Inject persona-specific instructions into the agent's worktree
      if (personaId && agent.worktreePath) {
        try {
          const persona = getPersonaTemplate(personaId);
          if (persona) {
            const provider = await resolveOrchestrator(projectPath, orchestrator);
            // Read existing instructions (from applyAgentDefaults) and append persona content
            let existing = '';
            try {
              existing = await provider.readInstructions(agent.worktreePath);
            } catch {
              // No existing instructions — start fresh
            }
            const combined = existing
              ? `${existing}\n\n${persona.content}`
              : persona.content;
            await provider.writeInstructions(agent.worktreePath, combined);
          }
        } catch (err) {
          appLog('assistant', 'warn', 'Failed to inject persona instructions', {
            meta: { agentName: name, persona: personaId, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message: `Agent "${agent.name}" created successfully.`,
            id: agent.id,
            name: agent.name,
            color: agent.color,
            icon: agent.icon || null,
            hasWorktree: !!agent.worktreePath,
            worktreePath: agent.worktreePath,
            model: agent.model,
            orchestrator: agent.orchestrator,
            persona: agent.persona || null,
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
      'free agent mode, clubhouse mode override, name, color, and icon. ' +
      'IMPORTANT: Do NOT clear an agent\'s icon unless the user explicitly asks — custom icons are user-set.',
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
        icon: {
          type: 'string',
          description: 'Agent icon filename. Set to "" to remove a custom icon. Omit to leave unchanged.',
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
      // Update basic fields (name, color, icon) via updateDurable
      const basicUpdates: Record<string, string | null | undefined> = {};
      if (args.name !== undefined) basicUpdates.name = args.name as string;
      if (args.color !== undefined) basicUpdates.color = args.color as string;
      if (args.icon !== undefined) {
        // Explicit icon update: empty string means remove
        basicUpdates.icon = (args.icon as string) === '' ? null : (args.icon as string);
      }
      if (Object.keys(basicUpdates).length > 0) {
        await updateDurable(projectPath, agentId, basicUpdates as any);
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
      // Try to parse the value as JSON (for booleans, numbers, objects)
      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue; // Use as plain string
      }

      // Theme changes use the dedicated theme service and notify the renderer
      if (key === 'theme' || key === 'themeId') {
        const themeId = String(value);
        await themeService.saveSettings({ themeId } as any);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.APP.THEME_CHANGED);
        }
        return {
          content: [{ type: 'text', text: `Theme updated to "${themeId}". Applied immediately.` }],
        };
      }

      // All other settings go to the general settings file
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        const raw = await fsp.readFile(settingsPath, 'utf-8');
        settings = JSON.parse(raw);
      } catch {
        // File doesn't exist or is invalid — start fresh
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
  description: 'Create a new canvas tab. Provide project_id to create in a specific project, otherwise creates at app level.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', description: 'Canvas name. Auto-generated if omitted.' },
    project_id: { type: 'string', description: 'Project ID to create canvas in. Omit for app-level.' },
  } },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('add_canvas', { name: args.name, project_id: args.project_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to create canvas' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

registerToolTemplate('assistant', 'list_canvases', {
  description: 'List all canvases with their IDs, names, and card counts.',
  inputSchema: { type: 'object', properties: {
    project_id: { type: 'string', description: 'Project ID to list canvases for. Omit for app-level.' },
  } },
}, async (_t, _a, args) => {
  const result = await sendCanvasCommand('list_canvases', { project_id: args.project_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to list canvases' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

// Track card count per canvas for auto-staggering default positions.
// Note: counter only increments — does not account for card removal. This is
// acceptable because layout_canvas (which should always be called after adding
// cards) resets the counter and re-arranges all cards.
const canvasCardCounters = new Map<string, number>();

registerToolTemplate('assistant', 'add_card', {
  description:
    'Add a card to a canvas. Types: "agent" (for durable agents), "zone" (visual grouping container), "anchor" (text-only label). ' +
    'For agent cards, ALWAYS provide agent_id and project_id to bind a real agent. ' +
    'Cards are auto-staggered when no position is specified. ALWAYS call layout_canvas after adding all cards. ' +
    'Anchors are just labels — they CANNOT be wired or used for coordination. Use group project cards for coordination. ' +
    'To place a card inside a zone, set zone_id to the zone\'s view ID — the card will be auto-positioned within that zone.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      type: { type: 'string', description: 'Card type: "agent", "zone", or "anchor".' },
      display_name: { type: 'string', description: 'Display name for the card.' },
      agent_id: { type: 'string', description: 'For agent cards: the durable agent ID (from list_agents) to bind to this card.' },
      project_id: { type: 'string', description: 'For agent cards: the project ID the agent belongs to (from list_projects).' },
      position_x: { type: 'number', description: 'X position (number). Auto-staggered if omitted.' },
      position_y: { type: 'number', description: 'Y position (number). Auto-staggered if omitted.' },
      width: { type: 'number', description: 'Width in pixels as a number (default: agent=300, zone=600, anchor=200).' },
      height: { type: 'number', description: 'Height in pixels as a number (default: agent=200, zone=400, anchor=100).' },
      zone_id: { type: 'string', description: 'Zone view ID to place this card inside. Card will be auto-positioned within the zone bounds.' },
    },
    required: ['canvas_id', 'type'],
  },
}, async (_t, _a, args) => {
  const canvasId = args.canvas_id as string;
  const cmdArgs: Record<string, unknown> = {
    canvas_id: canvasId, type: args.type, display_name: args.display_name,
    agent_id: args.agent_id, project_id: args.project_id,
  };

  // Coerce width/height to numbers in case LLM passes strings
  const width = args.width !== undefined ? Number(args.width) : undefined;
  const height = args.height !== undefined ? Number(args.height) : undefined;

  if (args.zone_id) {
    // Auto-position within zone bounds
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
    const views = queryResult.success ? (queryResult.data as Array<{ id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number } }>) : [];
    const zone = views.find(v => v.id === args.zone_id);
    if (zone) {
      const ZONE_CARD_HEIGHT = 32;
      const ZONE_PADDING = 20;
      const cardsInZone = views.filter(v => v.id !== zone.id && v.type !== 'zone' &&
        v.position.x >= zone.position.x && v.position.x < zone.position.x + zone.size.width &&
        v.position.y >= zone.position.y && v.position.y < zone.position.y + zone.size.height);
      const col = cardsInZone.length % 3;
      const row = Math.floor(cardsInZone.length / 3);
      cmdArgs.position = {
        x: zone.position.x + ZONE_PADDING + col * 340,
        y: zone.position.y + ZONE_CARD_HEIGHT + ZONE_PADDING + row * 260,
      };
    } else {
      // Zone not found — fall through to auto-stagger
      const idx = canvasCardCounters.get(canvasId) || 0;
      const col = idx % 4;
      const rw = Math.floor(idx / 4);
      cmdArgs.position = { x: 100 + col * 340, y: 100 + rw * 260 };
      canvasCardCounters.set(canvasId, idx + 1);
    }
  } else if (args.position_x !== undefined || args.position_y !== undefined) {
    cmdArgs.position = { x: args.position_x ?? 100, y: args.position_y ?? 100 };
  } else {
    // Auto-stagger: each card offset 340px horizontally, wrap to next row after 4
    const idx = canvasCardCounters.get(canvasId) || 0;
    const col = idx % 4;
    const row = Math.floor(idx / 4);
    cmdArgs.position = { x: 100 + col * 340, y: 100 + row * 260 };
    canvasCardCounters.set(canvasId, idx + 1);
  }
  if (width !== undefined || height !== undefined) {
    cmdArgs.size = { w: width ?? 300, h: height ?? 200 };
  }
  // Retry with backoff if canvas not found — handles race after create_canvas
  let result: Awaited<ReturnType<typeof sendCanvasCommand>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await sendCanvasCommand('add_view', cmdArgs);
    if (result.success || !result.error?.includes('Canvas not found')) break;
    appLog('core:assistant', 'warn', `add_card retry ${attempt + 1}/3 — canvas not found yet`, { meta: { canvas_id: args.canvas_id } });
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  if (!result!.success) return { content: [{ type: 'text', text: result!.error || 'Failed to add card' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result!.data) }] };
});

registerToolTemplate('assistant', 'move_card', {
  description: 'Move a card to a new position on the canvas. Parameters are x and y (numbers). ' +
    'To place a card inside a zone, set zone_id — the card will be centered in the zone. ' +
    'Zone containment is spatial: a card is "inside" a zone when >50% of it overlaps the zone bounds.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      view_id: { type: 'string', description: 'Card view ID.' },
      x: { type: 'number', description: 'New X position (number).' },
      y: { type: 'number', description: 'New Y position (number).' },
      position_x: { type: 'number', description: 'Alias for x.' },
      position_y: { type: 'number', description: 'Alias for y.' },
      zone_id: { type: 'string', description: 'Zone view ID — auto-position card inside this zone instead of using x/y.' },
    },
    required: ['canvas_id', 'view_id'],
  },
}, async (_t, _a, args) => {
  // Accept position_x/position_y as aliases for x/y
  const targetX = args.x ?? args.position_x;
  const targetY = args.y ?? args.position_y;

  let position: { x: number; y: number };
  if (args.zone_id) {
    // Auto-position within zone bounds
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: args.canvas_id });
    const views = queryResult.success ? (queryResult.data as Array<{ id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number } }>) : [];
    const zone = views.find(v => v.id === args.zone_id);
    if (!zone) return { content: [{ type: 'text', text: `Zone ${args.zone_id} not found.` }], isError: true };
    const ZONE_CARD_HEIGHT = 32;
    const ZONE_PADDING = 20;
    position = {
      x: zone.position.x + ZONE_PADDING + (zone.size.width / 2 - 150),
      y: zone.position.y + ZONE_CARD_HEIGHT + ZONE_PADDING,
    };
  } else if (targetX !== undefined && targetY !== undefined) {
    position = { x: Number(targetX), y: Number(targetY) };
  } else {
    return { content: [{ type: 'text', text: 'Either x/y coordinates or zone_id is required.' }], isError: true };
  }

  const result = await sendCanvasCommand('move_view', { canvas_id: args.canvas_id, view_id: args.view_id, position, project_id: args.project_id });
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
  const result = await sendCanvasCommand('resize_view', { canvas_id: args.canvas_id, view_id: args.view_id, size: { w: args.width, h: args.height }, project_id: args.project_id });
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
  const result = await sendCanvasCommand('remove_view', { canvas_id: args.canvas_id, view_id: args.view_id, project_id: args.project_id });
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
  const result = await sendCanvasCommand('rename_view', { canvas_id: args.canvas_id, view_id: args.view_id, name: args.name, project_id: args.project_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to rename card' }], isError: true };
  return { content: [{ type: 'text', text: 'Card renamed.' }] };
});

registerToolTemplate('assistant', 'connect_cards', {
  description: 'Create a wire (MCP binding) between two cards. ' +
    'Parameters: canvas_id, source_view_id, target_view_id. ' +
    'Source must be an agent card with agent_id set. Target must be another agent card (NOT an anchor). ' +
    'Wire persists even if agents are sleeping. Cannot wire to anchors — they are text-only labels. ' +
    'By default, agent-to-agent wires are bidirectional (both agents can call each other). ' +
    'Set bidirectional=false for one-way communication.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      source_view_id: { type: 'string', description: 'Source card view ID (must be an agent card).' },
      target_view_id: { type: 'string', description: 'Target card view ID.' },
      from_card_id: { type: 'string', description: 'Alias for source_view_id.' },
      to_card_id: { type: 'string', description: 'Alias for target_view_id.' },
      bidirectional: { type: 'boolean', description: 'Create wires in both directions. Defaults to true for agent-to-agent, false for agent-to-group-project.' },
    },
    required: ['canvas_id'],
  },
}, async (_t, _a, args) => {
  // Accept from_card_id/to_card_id as aliases
  const sourceViewId = args.source_view_id ?? args.from_card_id;
  const targetViewId = args.target_view_id ?? args.to_card_id;
  if (!sourceViewId || !targetViewId) {
    return { content: [{ type: 'text', text: 'Missing required argument: source_view_id (or from_card_id) and target_view_id (or to_card_id)' }], isError: true };
  }
  const result = await sendCanvasCommand('connect_views', {
    canvas_id: args.canvas_id,
    source_view_id: sourceViewId,
    target_view_id: targetViewId,
    project_id: args.project_id,
    bidirectional: args.bidirectional,
  });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to connect cards' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
});

registerToolTemplate('assistant', 'layout_canvas', {
  description: 'Auto-arrange cards. Patterns: "horizontal" (row), "vertical" (column), "grid", "hub_spoke" (center + circle). ' +
    'Zone-aware: cards inside zones are grouped and arranged within their zone bounds. Zones themselves are arranged in the outer layout.',
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

  // Reset auto-stagger counter — layout_canvas re-arranges all cards
  canvasCardCounters.delete(canvasId);

  const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
  if (!queryResult.success) return { content: [{ type: 'text', text: queryResult.error || 'Failed to query views' }], isError: true };

  type CanvasView = { id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number }; containedViewIds?: string[] };
  const views = queryResult.data as CanvasView[];
  if (!views || views.length === 0) return { content: [{ type: 'text', text: 'No cards to arrange.' }] };

  // Reset auto-stagger counter for this canvas since layout will reposition everything
  canvasCardCounters.delete(canvasId);

  // Separate zones from non-zone views, identify contained cards
  const zones = views.filter(v => v.type === 'zone');
  const containedIds = new Set(zones.flatMap(z => z.containedViewIds || []));
  const outerViews = views.filter(v => v.type !== 'zone' && !containedIds.has(v.id));

  // Layout outer views (non-zone cards + zones as blocks)
  const outerCards = [...outerViews, ...zones].map(v => ({ id: v.id, width: v.size.width, height: v.size.height }));
  const outerPositions = computeLayout(pattern, outerCards);
  for (const pos of outerPositions) {
    await sendCanvasCommand('move_view', { canvas_id: canvasId, view_id: pos.id, position: { x: pos.x, y: pos.y } });
  }

  // Layout cards inside each zone using grid within zone bounds
  const ZONE_CARD_HEIGHT = 32;
  const ZONE_PADDING = 20;
  for (const zone of zones) {
    const zonePos = outerPositions.find(p => p.id === zone.id);
    if (!zonePos) continue;
    const zoneCards = views.filter(v => (zone.containedViewIds || []).includes(v.id));
    if (zoneCards.length === 0) continue;
    const innerStartX = zonePos.x + ZONE_PADDING;
    const innerStartY = zonePos.y + ZONE_CARD_HEIGHT + ZONE_PADDING;
    const innerPositions = computeLayout('grid', zoneCards.map(v => ({ id: v.id, width: v.size.width, height: v.size.height })));
    for (const ipos of innerPositions) {
      // Offset inner positions to be relative to zone
      await sendCanvasCommand('move_view', { canvas_id: canvasId, view_id: ipos.id, position: { x: innerStartX + ipos.x - 100, y: innerStartY + ipos.y - 100 } });
    }
  }

  return { content: [{ type: 'text', text: `Arranged ${views.length} cards in "${pattern}" layout (zone-aware).` }] };
});

// ── Plugin Tools ───────────────────────────────────────────────────────────
// NOTE: Plugin enable/disable lives in the renderer store (plugin-store.ts)
// and has no main-process API. These tools will be added when renderer-side
// IPC for plugin management is available.

} // end registerAssistantTools
