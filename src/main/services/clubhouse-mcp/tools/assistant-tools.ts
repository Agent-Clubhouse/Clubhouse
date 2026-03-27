/**
 * Read-only MCP tools for the Clubhouse Assistant agent.
 *
 * These tools let the assistant understand the user's app state, filesystem,
 * and help content. They are registered as a new 'assistant' target kind and
 * scoped exclusively to the assistant agent via a binding.
 *
 * All tools are read-only — write tools are added in Phase 4.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { registerToolTemplate } from '../tool-registry';
import * as projectStore from '../../project-store';
import { listDurable } from '../../agent-config';
import { getAvailableOrchestrators, checkAvailability } from '../../agent-system';
import { appLog } from '../../log-service';

/**
 * Register all read-only assistant MCP tools.
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

} // end registerAssistantTools
