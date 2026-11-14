import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { readAgentConfig } from '../../agent-config-reader';
import { forwardAgentCall, remoteMachineOf } from '../../annex-agent-calls';

const failure = (): McpToolResult => ({ content: [{ type: 'text', text: 'The agent configuration could not be read. Check the registered target and its instruction file, or use its id if the name is ambiguous.' }], isError: true });

export function registerAgentConfigTools(): void {
  registerGlobalTool('read_agent_config', {
    description: 'Read an agent\'s instruction text and managed instruction/skill/MCP parts with content and provenance. Requires agent.read on the target (connected by default). agent is an id, unique registered name, or agentId@machine in this Annex Network; project optionally disambiguates a local name. Read-only; bounded to 256 KiB, 32 KiB per text and 100 parts, with truncation reported. Managed content describes the desired setup, never proof of provider loading. Does not read secrets, grants, sessions or global provider config. Remote reads need a connection except for a member\'s authenticated federated Dispatcher; the host still checks agent.read.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', maxLength: 400 }, project: { type: 'string', maxLength: 400 },
    }, required: ['agent'] },
  }, async (callerId, args) => {
    if (typeof args.agent !== 'string' || !args.agent.trim() || args.agent.length > 400
      || args.project !== undefined && (typeof args.project !== 'string' || args.project.length > 400)) return failure();
    if (remoteMachineOf(args.agent)) return forwardAgentCall(callerId, args.agent, 'That agent', 'read_agent_config', {});
    try { return { content: [{ type: 'text', text: JSON.stringify(await readAgentConfig(args.agent, args.project as string | undefined)) }] }; }
    catch { return failure(); /* telemetry-exempt: read failure returned without file contents or paths */ }
  }, { grant: { actions: ['agent.read'], target: 'agent_arg', allowRemote: true, strictTargets: true, from: { args: ['agent'], project: 'project', names: 'registered' } } });
}
