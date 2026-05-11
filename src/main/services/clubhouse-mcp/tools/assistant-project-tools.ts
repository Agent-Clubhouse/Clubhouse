import * as fsp from 'fs/promises';
import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import * as projectStore from '../../project-store';
import { requireString } from './validation';

/** Register project write tools (add, remove, update). */
export function registerProjectTools(): void {

// ── Project Write Tools ────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'add_project'),
  category: 'assistant',
  label: 'Add Project',
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
  targetKind: 'assistant',
  nameSuffix: 'add_project',
  handler: async (_targetId, _agentId, args) => {
    const dirPath = requireString(args, 'path').replace(/^~/, process.env.HOME || '/tmp');
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'remove_project'),
  category: 'assistant',
  label: 'Remove Project',
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
  targetKind: 'assistant',
  nameSuffix: 'remove_project',
  handler: async (_targetId, _agentId, args) => {
    const projectId = requireString(args, 'project_id');
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
});

registerMcpCommand({
  id: toCommandId('assistant', 'update_project'),
  category: 'assistant',
  label: 'Update Project',
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
  targetKind: 'assistant',
  nameSuffix: 'update_project',
  handler: async (_targetId, _agentId, args) => {
    const projectId = requireString(args, 'project_id');
    const updates: Record<string, string> = {};
    if (args.display_name) updates.displayName = requireString(args, 'display_name');
    if (args.color) updates.color = requireString(args, 'color');
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
});

}
