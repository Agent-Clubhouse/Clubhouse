import { getDispatcherPresence } from '../../dispatcher-presence';
import { callTool, registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';

export const REMOTE_DISPATCHER_GRANT = { actions: ['agent.message'], target: 'remote_dispatcher' } as const;
const text = (value: string, isError = true): McpToolResult => ({ content: [{ type: 'text', text: value }], ...(isError && { isError }) });

/** Names are a convenience; ambiguity never picks an arbitrary member. */
export function resolveRemoteDispatcher(machine: unknown) {
  if (typeof machine !== 'string' || !machine.trim()) throw new Error('Name a computer from list_other_dispatchers.');
  const name = machine.trim().toLowerCase();
  const matches = getDispatcherPresence().remotes.filter((r) => r.machineName.toLowerCase() === name || r.machineId === name);
  if (matches.length !== 1) throw new Error(matches.length ? 'That computer name is ambiguous. Use its full fingerprint from list_other_dispatchers.' : 'That computer is not a member of this Annex Network.');
  const peer = matches[0];
  if (!peer.address || peer.state === 'unknown' || peer.state === 'off') throw new Error(`${peer.label} is not available.`);
  return peer;
}

export function registerRemoteDispatcherTools(): void {
  for (const [name, field, tool] of [
    ['message_remote_dispatcher', 'message', 'send_message'],
    ['send_file_to_remote_dispatcher', 'content', 'send_file'],
  ] as const) {
    registerGlobalTool(name, {
      description: `Send ${field === 'message' ? 'news' : 'file contents'} directly to another computer's Dispatcher, under your permission here and its controller link there. Name the computer from list_other_dispatchers. This is news, not a work request or Handoff agreement. Offline delivery waits durably.`,
      inputSchema: { type: 'object', properties: {
        machine: { type: 'string' }, [field]: { type: 'string' }, task_id: { type: 'string' }, idempotency_key: { type: 'string' },
        ...(field === 'content' && { filename: { type: 'string' } }),
      }, required: ['machine', field] },
    }, async (agentId, args) => {
      if (typeof args[field] !== 'string' || !args[field].trim()) return text(`Give ${field} to send.`);
      try {
        const peer = resolveRemoteDispatcher(args.machine);
        const { sendRemoteDispatcherNews } = await import('../../dispatcher-remote-messaging');
        return await sendRemoteDispatcherNews(agentId, name, args, peer, tool, field);
      } catch (err) { return text(err instanceof Error ? err.message : 'Remote Dispatcher delivery failed.'); }
    }, { grant: REMOTE_DISPATCHER_GRANT });
  }
  registerGlobalTool('offer_handoff_to_remote_dispatcher', {
    description: 'Offer a Handoff agreement to the Dispatcher on a named computer. Uses offer_handoff with its normal permissions and Ask first approval. Never auto-accepts or creates a federated work request. Read get_handoff for its own agreement lifecycle.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string' }, task: { type: 'string' }, brief: { type: 'string' }, mode: { type: 'string', enum: ['branch', 'worktree'] }, manifest: { type: 'object' } }, required: ['machine', 'task', 'brief', 'mode'] },
  }, async (agentId, args) => {
    try {
      const peer = resolveRemoteDispatcher(args.machine);
      // The inner call owns and consumes its exact Ask approval scope. Do not call the host directly.
      return await callTool(agentId, 'offer_handoff', { to: `machine:${peer.machineId}`, task: args.task, brief: args.brief, mode: args.mode, ...(args.manifest !== undefined && { manifest: args.manifest }) });
    } catch (err) { return text(err instanceof Error ? err.message : 'The Handoff target is unavailable.'); }
  }, { group: 'handoffs', grant: 'called_tool' });
}
