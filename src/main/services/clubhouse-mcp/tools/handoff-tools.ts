import { HANDOFF_STATES, type HandoffManifestSummary } from '../../../../shared/handoffs';
import { setHandoffGrantTargetResolver } from '../arg-targets';
import { HANDOFF_ACCEPT_GRANT, HANDOFF_OFFER_GRANT, withHandoffAgreementCall } from '../handoff-permissions';
import { describeCallsForAsk } from '../ask-first';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';

const text = (value: unknown, isError = false): McpToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError && { isError: true }) });
const id = (args: Record<string, unknown>) => typeof args.id === 'string' && /^[0-9a-f-]{36}$/.test(args.id);
const known = (args: Record<string, unknown>, keys: string[]) => Object.keys(args).every((key) => keys.includes(key));
const reason = (args: Record<string, unknown>) => args.reason === undefined || typeof args.reason === 'string' && !!args.reason.trim() && args.reason.length <= 512 && !args.reason.includes('\0');
const READ = { actions: ['agent.read'], target: 'self' } as const;

export function registerHandoffTools(): void {
  setHandoffGrantTargetResolver(async (agentId, args) => (await import('../../handoff-host')).resolveHandoffGrantTarget(agentId, args));
  describeCallsForAsk('offer_handoff', (args) => `Offer work to ${typeof args.to === 'string' ? args.to : 'the receiver'}. They must agree before transfer and automatic apply.`);
  describeCallsForAsk('respond_to_handoff', (args) => args.accept === true ? 'Accept this handoff, including automatic verified transfer and apply into a fresh worktree.' : 'Decline this handoff.');

  registerGlobalTool('offer_handoff', {
    description: 'Offer a task, brief and code to another agent or a computer’s Dispatcher. Unlike hand_off, which records how an orchestrator took a helper’s work, this starts a durable agreement with a receiver. Needs handoff.offer and an existing connection, or a receiving Dispatcher. Accepting authorizes automatic verified transfer/apply. Keep the returned id; get_handoff shows retained history.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'Agent id/name, agent@machine (fingerprint or unambiguous name), or machine:<name> for that computer’s Dispatcher.' },
      task: { type: 'string', description: 'Task title, up to 256 characters.' }, brief: { type: 'string', description: 'Goal, progress, remaining work and verification; up to 16000 characters. Never include secrets.' },
      mode: { type: 'string', enum: ['branch', 'worktree'] }, manifest: { type: 'object', description: 'Optional prepared manifest summary: fileCount, totalBytes and sha256.' },
    }, required: ['to', 'task', 'brief', 'mode'] },
  }, async (agentId, args) => {
    if (!known(args, ['to', 'task', 'brief', 'mode', 'manifest']) || typeof args.to !== 'string'
      || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 256 || typeof args.brief !== 'string' || !args.brief.trim() || args.brief.length > 16_000
      || !['branch', 'worktree'].includes(String(args.mode))) return text('Give to, task (1–256 characters), brief (1–16000), mode (branch/worktree), and an optional manifest summary.', true);
    try {
      const host = await import('../../handoff-host');
      const target = await host.resolveHandoffTarget(args.to);
      const senderName = await host.handoffSenderName(agentId);
      const record = await withHandoffAgreementCall({ agentId, name: 'offer_handoff', args }, () => host.handoffHost().coordinator.offer({
        to: target, senderName, task: { title: args.task as string, brief: args.brief as string }, mode: args.mode as 'branch' | 'worktree',
        ...(args.manifest !== undefined && { manifest: args.manifest as HandoffManifestSummary }),
      }, host.localHandoffAgent(agentId)));
      return text(record);
    } catch {
      // telemetry-exempt: never reflect task text, secret values or store paths
      return text('Handoff offer was refused or could not be persisted. Check the target, connection, permissions and secret-free metadata.', true);
    }
  }, { group: 'handoffs', grant: HANDOFF_OFFER_GRANT });

  registerGlobalTool('respond_to_handoff', {
    description: 'Accept or decline an offer addressed to you. A receiving Dispatcher can name a local target_agent, or new_helper to prepare a fresh helper asleep until apply. target_project selects its registered project (otherwise the first registered project by id). Acceptance authorizes automatic verified transfer and fresh-worktree apply without another prompt. This is distinct from the helper result tool hand_off.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, accept: { type: 'boolean' }, reason: { type: 'string' }, target_agent: { type: 'string' }, target_project: { type: 'string' } }, required: ['id', 'accept'] },
  }, async (agentId, args) => {
    if (!known(args, ['id', 'accept', 'reason', 'target_agent', 'target_project']) || !id(args) || typeof args.accept !== 'boolean' || !reason(args)
      || args.target_agent !== undefined && typeof args.target_agent !== 'string'
      || args.target_project !== undefined && (typeof args.target_project !== 'string' || !args.target_project.trim() || args.target_project.length > 4096 || args.target_agent !== 'new_helper')
      || args.accept === false && args.target_agent !== undefined) return text('Give id, accept (boolean), and optional reason or local target_agent.', true);
    try {
      const host = await import('../../handoff-host');
      return await withHandoffAgreementCall({ agentId, name: 'respond_to_handoff', args }, async () => {
        const target = args.target_agent === 'new_helper'
          ? await host.prepareNewHandoffHelper(agentId, args.id as string, args.target_project as string | undefined)
          : args.target_agent === undefined ? undefined : await host.resolveHandoffTarget(args.target_agent as string);
        if (target && 'content' in target) return target;
        if (target && (!('agentId' in target) || target.machine !== host.localHandoffAgent(agentId).machine)) return text('The accepting target must be a local agent.', true);
        return text(await host.handoffHost().coordinator.respond(args.id as string,
          host.localHandoffAgent(agentId), args.accept as boolean, target && 'agentId' in target ? target : undefined, args.reason as string | undefined));
      });
    } catch {
      // telemetry-exempt: bounded refusal only
      return text('Handoff response was refused or could not be persisted. Only its receiver or addressed Dispatcher can respond with current permissions.', true);
    }
  }, { group: 'handoffs', grant: HANDOFF_ACCEPT_GRANT });

  registerGlobalTool('get_handoff', {
    description: 'Read a handoff you sent or received: durable state, append-only history and apply result. Does not expose another agent’s handoffs.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }, async (agentId, args) => {
    if (!known(args, ['id']) || !id(args)) return text('Give a handoff id only.', true);
    try {
      const host = await import('../../handoff-host');
      return text(host.handoffHost().coordinator.service.get(args.id as string, host.localHandoffAgent(agentId)));
    } catch {
      // telemetry-exempt: no store path or task data in errors
      return text('Handoff is unavailable to this agent or its store is unreadable.', true);
    }
  }, { group: 'handoffs', grant: READ });

  registerGlobalTool('list_handoffs', {
    description: 'List only your retained sent/received handoffs, optionally filtered by direction and state. Records survive restarts.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['sent', 'received'] }, state: { type: 'string', enum: [...HANDOFF_STATES] } } },
  }, async (agentId, args) => {
    if (!known(args, ['direction', 'state']) || args.direction !== undefined && !['sent', 'received'].includes(String(args.direction))
      || args.state !== undefined && !(HANDOFF_STATES as readonly unknown[]).includes(args.state)) return text('Give optional direction (sent/received) and a valid handoff state only.', true);
    try {
      const host = await import('../../handoff-host');
      return text(host.handoffHost().coordinator.service.list(host.localHandoffAgent(agentId), args.direction as 'sent' | 'received' | undefined, args.state as typeof HANDOFF_STATES[number] | undefined));
    } catch {
      // telemetry-exempt: no raw store data in errors
      return text('The handoff store is unreadable; no state can be confirmed.', true);
    }
  }, { group: 'handoffs', grant: READ });

  registerGlobalTool('cancel_handoff', {
    description: 'Cancel a handoff you sent before applying starts. Cross-machine cancellation is durably queued for the receiving authority; an offline receiver may still show the previous state until it reconnects. Use get_handoff to confirm cancellation.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] },
  }, async (agentId, args) => {
    if (!known(args, ['id', 'reason']) || !id(args) || !reason(args)) return text('Give id and an optional reason of up to 512 characters.', true);
    try {
      const host = await import('../../handoff-host');
      const current = host.handoffHost();
      const record = await current.coordinator.cancel(args.id as string, host.localHandoffAgent(agentId), args.reason as string | undefined);
      return text({ id: record.id, state: record.state, cancellation_pending: current.commands.list().some((command) => command.id === record.id) });
    } catch {
      // telemetry-exempt: bounded refusal only
      return text('Cancellation was refused or could not be persisted. Only the sender may cancel, before applying starts.', true);
    }
  }, { group: 'handoffs', grant: READ });
}
