import { callGrantIsApproved, grantApprovalContext, registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { readResolvedAgentConfig, resolveAgentConfigTarget } from '../../agent-config-reader';
import { resolvedAgentGrantTarget, type ArgTargets } from '../arg-targets';
import { checkToolGrant } from '../grant-check';
import type { ToolGrantDeclaration } from '../tool-grants';
import { forwardAgentCall, remoteMachineOf } from '../../annex-agent-calls';

const failure = (): McpToolResult => ({ content: [{ type: 'text', text: 'The agent configuration could not be read. Check the registered target and its instruction file, or use its id if the name is ambiguous.' }], isError: true });

const READ_GRANT: ToolGrantDeclaration = { actions: ['agent.read'], target: 'agent_arg', allowRemote: true, strictTargets: true, from: { args: ['agent'], project: 'project', names: 'registered' } };

export function registerAgentConfigTools(): void {
  registerGlobalTool('read_agent_config', {
    description: 'Read an agent\'s instruction text and managed instruction/skill/MCP parts with content and provenance. Requires agent.read on the target (connected by default). agent is an id, unique registered name, or agentId@machine in this Annex Network; project optionally disambiguates a local name. Read-only; bounded to 256 KiB, 32 KiB per text and 100 parts, with truncation reported. Managed content describes the desired setup, never proof of provider loading. Does not read secrets, grants, sessions or global provider config. Remote reads need a connection except for a member\'s authenticated federated Dispatcher; the host still checks agent.read.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', maxLength: 400 }, project: { type: 'string', maxLength: 400 },
    }, required: ['agent'] },
  }, async (callerId, args) => {
    if (typeof args.agent !== 'string' || !args.agent.trim() || args.agent.length > 400
      || args.project !== undefined && (typeof args.project !== 'string' || args.project.length > 400)) return failure();
    if (remoteMachineOf(args.agent)) {
      // project only disambiguates local names. It must never suppress the
      // sender's remote target grant by selecting an unknown local project.
      if (args.project !== undefined) return failure();
      return forwardAgentCall(callerId, args.agent, 'That agent', 'read_agent_config', {});
    }
    try {
      const target = await resolveAgentConfigTarget(args.agent, args.project as string | undefined);
      const allowed = async () => {
        // Keep the resolved identity pinned, but refresh relations: a connection
        // may be revoked while the instruction files are being read.
        const concrete = await resolvedAgentGrantTarget(callerId, target.agent, target.project.path);
        const targets: ArgTargets = new Map([[READ_GRANT, [concrete]]]);
        return callGrantIsApproved(callerId, 'read_agent_config', args,
          checkToolGrant(callerId, READ_GRANT, args, undefined, targets),
          grantApprovalContext(callerId, 'read_agent_config', args, READ_GRANT, targets));
      };
      if (!await allowed()) return failure();
      const result = await readResolvedAgentConfig(target);
      return await allowed() ? { content: [{ type: 'text', text: JSON.stringify(result) }] } : failure();
    }
    catch { return failure(); /* telemetry-exempt: read failure returned without file contents or paths */ }
  }, { grant: READ_GRANT });
}
