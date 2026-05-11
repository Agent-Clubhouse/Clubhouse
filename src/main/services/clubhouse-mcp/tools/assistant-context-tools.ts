import * as fsp from 'fs/promises';
import * as path from 'path';
import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import * as projectStore from '../../project-store';
import { listDurable } from '../../agent-config';
import { getAvailableOrchestrators, checkAvailability } from '../../agent-system';
import { HELP_SECTIONS } from '../../../../renderer/features/help/help-content';
import { searchHelpTopics } from '../../../../renderer/features/help/help-search';
import { requireString, numberWithDefault } from './validation';

/** Register filesystem, app-state, and help-content read tools. */
export function registerContextTools(): void {

// ── Filesystem Tools ───────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'find_git_repos'),
  category: 'assistant',
  label: 'Find Git Repos',
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
  targetKind: 'assistant',
  nameSuffix: 'find_git_repos',
  handler: async (_targetId, _agentId, args) => {
    const dir = requireString(args, 'directory');
    const maxDepth = Math.min(numberWithDefault(args, 'depth', 2), 2);
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'check_path'),
  category: 'assistant',
  label: 'Check Path',
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
  targetKind: 'assistant',
  nameSuffix: 'check_path',
  handler: async (_targetId, _agentId, args) => {
    const targetPath = requireString(args, 'path').replace(/^~/, process.env.HOME || '/tmp');
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'list_directory'),
  category: 'assistant',
  label: 'List Directory',
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
  targetKind: 'assistant',
  nameSuffix: 'list_directory',
  handler: async (_targetId, _agentId, args) => {
    const targetPath = requireString(args, 'path').replace(/^~/, process.env.HOME || '/tmp');
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
});

// ── App State Tools ────────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'list_projects'),
  category: 'assistant',
  label: 'List Projects',
  description: 'List all projects configured in Clubhouse with their paths and git status.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  targetKind: 'assistant',
  nameSuffix: 'list_projects',
  handler: async (_targetId, _agentId, _args) => {
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'list_agents'),
  category: 'assistant',
  label: 'List Agents',
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
  targetKind: 'assistant',
  nameSuffix: 'list_agents',
  handler: async (_targetId, _agentId, args) => {
    const projectPath = requireString(args, 'project_path');
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'get_app_state'),
  category: 'assistant',
  label: 'Get App State',
  description:
    'Get a summary of the current Clubhouse app state including project count and orchestrator info.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  targetKind: 'assistant',
  nameSuffix: 'get_app_state',
  handler: async (_targetId, _agentId, _args) => {
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'get_orchestrators'),
  category: 'assistant',
  label: 'Get Orchestrators',
  description: 'List available orchestrators and their status.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  targetKind: 'assistant',
  nameSuffix: 'get_orchestrators',
  handler: async (_targetId, _agentId, _args) => {
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
});

// ── Help Content Tools ─────────────────────────────────────────────────────

// Help content and search are imported from the renderer help module at the top
// of this file. The markdown files are bundled as asset/source by webpack, and
// the search function is a pure TS module with no renderer dependencies.

registerMcpCommand({
  id: toCommandId('assistant', 'search_help'),
  category: 'assistant',
  label: 'Search Help',
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
  targetKind: 'assistant',
  nameSuffix: 'search_help',
  handler: async (_targetId, _agentId, args) => {
    const query = requireString(args, 'query');
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
});

}
