import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { projectImportService } from '../../project-import/service';
import { ImportError } from '../../project-import/types';
import { appLog } from '../../log-service';

function json(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError: true }) };
}

function string(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new ImportError('invalid_input', `Provide ${key} as a nonempty string.`);
  return args[key];
}

function safe(allowed: readonly string[], handler: (agentId: string, args: Record<string, unknown>) => Promise<unknown>) {
  return async (agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    try {
      if (Object.keys(args).some((key) => !allowed.includes(key))) throw new ImportError('invalid_input', 'Unsupported arguments. Use only the fields in this tool schema; model-supplied approval fields are never accepted.');
      return json(await handler(agentId, args));
    } catch (error) {
      const reason = error instanceof ImportError ? error.reason : 'import_unavailable';
      // telemetry-exempt: raw Git, filesystem, credential and repository diagnostics must not be logged.
      appLog('core:mcp', 'warn', 'Repository import request refused or incomplete', { meta: { reason } });
      return json({
        status: 'refused', reason,
        message: error instanceof ImportError ? error.message : 'Import could not complete this operation. Existing files/projects were preserved. Inspect import status before retrying.',
      }, true);
    }
  };
}

export function registerProjectImportTools(): void {
  registerGlobalTool('preview_github_import', {
    description: 'Preview importing one canonical HTTPS github.com owner/repository into an explicit absolute NEW destination. Reads current authorized Git remote branch metadata and placement/project conflicts; saves a bounded app-owned preview only. Existing content is never overwritten. SSH, enterprise hosts and credential-bearing URLs are refused. Reports actual branch/commit, filesystem and registration effects, and no agent creation/start. Preview is not approval.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https://github.com/owner/repository, optionally .git. No credentials, escapes, query or fragment.' },
        destination: { type: 'string', description: 'Explicit absolute path of a new directory, with an existing parent. No inferred import root.' },
        branch: { type: 'string', description: 'Optional existing branch. Omit to use the actual advertised default branch, never an assumed main.' },
      },
      required: ['url', 'destination'],
    },
  }, safe(['url', 'destination', 'branch'], (agentId, args) => projectImportService.preview(agentId, {
    url: string(args, 'url'), destination: string(args, 'destination'),
    ...(args.branch !== undefined && { branch: string(args, 'branch') }),
  })), { group: 'dispatcher', grant: { actions: ['project.read'], target: 'all_projects' } });

  registerGlobalTool('import_github_repository', {
    description: 'Import exactly the reviewed GitHub preview into its canonical new destination after genuine fresh per-import human approval, even when project.add is Allow. Downloads only the reviewed branch/tip, checks out without hooks/filters/submodules/setup, then uses normal project registration and .gitignore rules. Returns a tracked receipt, never creates/starts an agent. Changed identity/placement/branch requires a new preview and approval. Repeated calls return the original receipt; partial files are preserved. Activation is fail-closed until the exact approval boundary is available.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'The current server-generated preview id. It is not permission.' },
        destination: { type: 'string', description: 'The exact canonical absolute destination returned by the preview.' },
      },
      required: ['planId', 'destination'],
    },
  }, safe(['planId', 'destination'], async (_agentId, args) => {
    string(args, 'planId');
    string(args, 'destination');
    // The central original-scope human-approval repair is independently reviewed before this activates.
    // No model boolean, preview token, generic Allow grant or permission callback is an approval substitute.
    throw new ImportError('approval_boundary_unavailable', 'Repository import is not activated until exact current human-approval verification is available. Preview and status are available; nothing was cloned, registered or started.');
  }), {
    group: 'dispatcher',
    grant: { actions: ['project.add'], target: 'project_arg', from: { args: ['destination'] }, askHandledByTool: true },
  });

  registerGlobalTool('get_github_import', {
    description: 'Read this caller\'s import receipt, current sanitized progress, separate checkout/project/agent outcomes and safe recovery instructions. A stopped app produces an interrupted outcome, never an automatic restart or duplicate clone.',
    inputSchema: { type: 'object', properties: { importId: { type: 'string', description: 'The import receipt id.' } }, required: ['importId'] },
  }, safe(['importId'], (agentId, args) => projectImportService.status(agentId, string(args, 'importId'))),
  { group: 'dispatcher', grant: { actions: ['project.read'], target: 'all_projects' } });

  registerGlobalTool('cancel_github_import', {
    description: 'Request cancellation of only this caller\'s tracked import process. Preserves partial downloads, checkout files and any completed project registration. Read status for the final outcome; this never deletes/reset files, stops unrelated processes or changes agent authority.',
    inputSchema: {
      type: 'object',
      properties: {
        importId: { type: 'string', description: 'The caller-owned running import id.' },
        destination: { type: 'string', description: 'The exact canonical destination in that import receipt, for the current project.add permission check.' },
      },
      required: ['importId', 'destination'],
    },
  }, safe(['importId', 'destination'], (agentId, args) => projectImportService.cancel(agentId, string(args, 'importId'), string(args, 'destination'))),
  { group: 'dispatcher', grant: { actions: ['project.add'], target: 'project_arg', from: { args: ['destination'] }, askHandledByTool: true } });
}
