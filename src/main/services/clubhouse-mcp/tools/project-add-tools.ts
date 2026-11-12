/**
 * add_project (#3239): the Dispatcher registers a folder that's already on
 * disk as a Clubhouse project, under its `project.add` grant (Ask first by
 * default; Allow or Off in its permissions). It shares the app's Add project
 * path, so a folder that's already a project comes back as `already_registered`
 * and is never added twice (#3236). Agents never reach the renderer's IPC.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { describeCallsForAsk } from '../ask-first';
import * as projectStore from '../../project-store';
import { checkProjectFolder, describeFolderGit, registerProjectFolder } from '../../project-add';
import { appLog } from '../../log-service';
import { registerProjectImportTools } from './project-import-tools';

const DISPLAY_NAME_MAX = 200;

function json(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError: true }) };
}

function refused(reason: string, message: string): McpToolResult {
  return json({ status: 'refused', reason, message }, true);
}

async function addProject(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const input = typeof args.path === 'string' ? args.path.trim() : '';
  if (!input) return refused('not_absolute', 'Give the folder\'s absolute path.');
  const displayName = typeof args.displayName === 'string' ? args.displayName.trim() : undefined;
  if (displayName !== undefined && displayName.length > DISPLAY_NAME_MAX) {
    return refused('invalid_display_name', `Keep displayName to ${DISPLAY_NAME_MAX} characters.`);
  }
  const dryRun = args.dryRun === true;

  const folder = await checkProjectFolder(input);
  if ('reason' in folder) return refused(folder.reason, folder.message);

  const existing = await projectStore.findByPath(folder.path);
  const target = existing?.path ?? folder.path;
  const git = await describeFolderGit(target);
  if (existing) {
    return json({
      status: 'already_registered',
      projectId: existing.id,
      name: existing.displayName || existing.name,
      path: existing.path,
      canonicalPath: await projectStore.canonicalProjectPath(existing.path),
      ...git,
      ...(displayName && { note: 'The project keeps its name. update_project renames it.' }),
    });
  }
  if (dryRun) {
    return json({ status: 'would_add', path: folder.path, canonicalPath: folder.canonicalPath, ...git, gitignore: 'would_update_if_needed' });
  }

  const result = await registerProjectFolder(folder.path);
  let project = result.project;
  let warning: string | undefined;
  let displayNameError: string | undefined;
  if (result.created && displayName) {
    try {
      const updated = await projectStore.update(project.id, { displayName });
      project = updated.find((p) => p.id === project.id) ?? project;
    } catch (err) {
      // telemetry-exempt: registration succeeded; report the remaining naming step separately.
      displayNameError = err instanceof Error ? err.message : String(err);
      appLog('core:mcp', 'warn', 'add_project display name failed', {
        meta: { agentId, projectId: project.id, error: displayNameError },
      });
      warning = 'The project was added, but its display name could not be saved. Use update_project to rename it.';
    }
  }
  appLog('core:mcp', 'info', 'An agent added a project', { meta: { agentId, projectId: project.id, created: result.created } });
  return json({
    status: result.created ? 'added' : 'already_registered',
    projectId: project.id,
    name: project.displayName || project.name,
    path: project.path,
    canonicalPath: folder.canonicalPath,
    ...git,
    ...(result.gitignore && { gitignore: result.gitignore }),
    ...((warning || result.gitignore === 'failed') && { partial: true }),
    ...(warning && { warning, displayNameError }),
  });
}

export function registerProjectAddTools(): void {
  registerProjectImportTools();
  describeCallsForAsk('add_project', (args) => {
    const where = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : 'a folder';
    if (args.dryRun === true) return `Check whether ${where} can be added as a project. Nothing changes.`;
    return `Add ${where} as a Clubhouse project. If the folder isn't one yet, Clubhouse adds its own lines to the folder's .gitignore, as Add project does.`;
  });

  registerGlobalTool(
    'add_project',
    {
      description:
        'Add a folder that already exists on this computer as a Clubhouse project, as Add project does in the app. ' +
        'A folder that is already a project (by its real path, through links or another spelling) returns "already_registered" and adds nothing. ' +
        'Returns the project id, path, canonical path, whether it is a git repository, its default branch and origin. ' +
        'A new project gets Clubhouse\'s lines in its .gitignore, reported as "gitignore". ' +
        'If naming or .gitignore updates fail after registration, partial: true keeps the registered project id and reports the unfinished step; reuse that project rather than cloning again. ' +
        'Agent worktrees and Clubhouse\'s own folders are refused. dryRun checks without changing anything.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The folder\'s absolute path.' },
          displayName: { type: 'string', description: 'Optional name to show for a new project, up to 200 characters.' },
          dryRun: { type: 'boolean', description: 'Check the folder and say what would happen, without adding it. Default false.' },
        },
        required: ['path'],
      },
    },
    async (agentId, args) => {
      try {
        return await addProject(agentId, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // telemetry-exempt: logged; the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'add_project failed', { meta: { agentId, error: message } });
        return json({ status: 'failed', message }, true);
      }
    },
    { group: 'dispatcher', grant: { actions: ['project.add'], target: 'project_arg', from: { args: ['path'] } } },
  );
}
