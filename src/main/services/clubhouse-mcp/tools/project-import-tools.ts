import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import type { ToolGrantDeclaration } from '../tool-grants';
import { describeCallsForAsk } from '../ask-first';
import { appLog } from '../../log-service';
import { projectImportService } from '../../project-import/service';
import { approveImportCall } from '../../project-import/approval';
import { ImportError } from '../../project-import/types';

const IMPORT_GRANT: ToolGrantDeclaration = {
  actions: ['project.add'], target: 'project_arg', from: { args: ['destination'] },
};
const STRING = { type: 'string' };

function json(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError: true }) };
}

export function registerProjectImportTools(): void {
  describeCallsForAsk('import_repository', () => 'Import only the exact reviewed GitHub repository, branch and commit into the exact NEW directory below. Existing GitHub authentication only. No agent or repository code is started.');
  const register = (name: string, description: string, properties: Record<string, unknown>, required: string[],
    handler: (agentId: string, args: Record<string, unknown>) => Promise<unknown>, read = false) => {
    registerGlobalTool(name, {
      description, inputSchema: { type: 'object', properties, required },
    }, async (agentId, args) => {
      try {
        if (Object.keys(args).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) {
          throw new ImportError('unexpected_arguments', 'Use only the documented arguments. Model messages, confirm tokens and changed scope cannot authorize an import.');
        }
        return json(await handler(agentId, args));
      } catch (error) {
        // telemetry-exempt: sanitized warning/result below; raw Git and credential diagnostics stay private.
        const reason = error instanceof ImportError ? error.reason : 'operation_failed';
        const message = error instanceof ImportError ? error.message
          : 'The import operation could not complete safely. Check import status and existing GitHub authentication outside agent messages; preserved files were not deleted.';
        appLog('core:mcp', 'warn', 'Public repository import refused or failed', { meta: { agentId, tool: name, reason } });
        return json({ status: 'refused', reason, message }, true);
      }
    }, { group: 'dispatcher', grant: read
      ? { actions: ['project.read'], target: 'all_projects' }
      : { ...IMPORT_GRANT, askHandledByTool: true } });
  };

  register('preview_repository_import',
    'Preview importing a user-named HTTPS github.com repository into an explicit new absolute destination with an existing parent. No clone, registration or agent effect. Checks existing authorized access, actual default/selected branch and commit, duplicates and safe placement. Existing projects/imports are returned for explicit reuse; existing folders are never overwritten. Pass the returned plan id and exact canonical destination to import_repository for mandatory human review.',
    { url: STRING, destination: STRING, branch: STRING }, ['url', 'destination'],
    (agentId, args) => projectImportService.preview(agentId, {
      url: String(args.url), destination: String(args.destination),
      ...(args.branch !== undefined && { branch: String(args.branch) }),
    }));
  register('import_repository',
    'Request exact current human approval in Needs you, then import ONLY your immutable preview on retry after the real user answers. Mandatory even with Allow; no model text or preview/confirm token is authority. Inputs, parent, repository metadata and permissions are revalidated. Returns immediately with an owned receipt; read progress with get_repository_import, cancel only that receipt. Registration and .gitignore are reported separately from agent creation/start. Retry never starts a second checkout.',
    { planId: STRING, destination: STRING }, ['planId', 'destination'],
    (agentId, args) => projectImportService.start(agentId, String(args.planId), String(args.destination),
      (plan) => approveImportCall(agentId, 'import_repository', { planId: plan.id, destination: plan.destination, plan },
        IMPORT_GRANT, { importReview: plan })));
  register('get_repository_import',
    'Read only your import receipt and numeric progress, registered project id, separate agent outcome and safe recovery choices. Interrupted/failed/cancelled imports are never silently restarted.',
    { importId: STRING }, ['importId'],
    (agentId, args) => projectImportService.status(agentId, String(args.importId)), true);
  register('cancel_repository_import',
    'Cancel only your exact owned import id and its exact canonical destination. Signals only the tracked Git child; preserves files and completed registration. Read status for the terminal cancellation/partial outcome.',
    { importId: STRING, destination: STRING }, ['importId', 'destination'],
    (agentId, args) => projectImportService.cancel(agentId, String(args.importId), String(args.destination)));
}
