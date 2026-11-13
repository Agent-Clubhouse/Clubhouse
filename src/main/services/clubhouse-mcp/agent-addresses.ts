/**
 * Machine-qualified agent references in tool calls (#3063, Annex Network stage 6).
 *
 * An argument that names an agent may say which machine it's on
 * (`<agentId>@<machine>`, src/shared/agent-address.ts). Before a call is
 * checked and run, every such argument naming this machine becomes the bare
 * id, so tools and grant checks see what they always have. One naming another
 * machine is refused unless the tool explicitly handles network addresses.
 */
import { parseAgentAddress, routeOf } from '../../../shared/agent-address';
import * as annexIdentity from '../annex-identity';
import { toolGrantDeclarations, type ToolGrant } from './tool-grants';

export type LocalizedArgs = { args: Record<string, unknown> } | { otherMachine: string; message: string };

/**
 * The arguments a tool's grant says name agents: an `agent_arg` declaration's
 * own list, and the fixed argument each other agent target reads.
 */
function agentArgNames(grant: ToolGrant | undefined): string[] {
  if (!grant) return [];
  // call_wire_tool: the wire's agent is `target`.
  if (grant === 'called_tool') return ['target'];
  const names = new Set<string>();
  for (const d of toolGrantDeclarations(grant)) {
    if (d.target === 'agent_arg') for (const arg of d.from?.args ?? ['from', 'to']) names.add(arg);
    else if (d.target === 'group_members') names.add('target_agent_id');
    else if (d.target === 'my_helpers') names.add('helper');
  }
  return [...names];
}

/** `args` with this machine's agent references made local, or why the call can't run here. */
export function localizeAgentArgs(grant: ToolGrant | undefined, args: Record<string, unknown>): LocalizedArgs {
  const names = agentArgNames(grant);
  const remoteNames = new Set(grant && grant !== 'called_tool' ? toolGrantDeclarations(grant).filter((d) => d.allowRemote).flatMap((d) => d.from?.args ?? []) : []);
  if (names.length === 0) return { args };
  // Read only when a reference names a machine: most calls never need it.
  let self: string | undefined | null = null;
  const selfFp = () => (self === null ? (self = annexIdentity.getIdentity()?.fingerprint) : self);
  const out: Record<string, unknown> = { ...args };
  const localize = (ref: string): string | { machine: string } => {
    const address = parseAgentAddress(ref);
    if (!address.machine) return ref;
    const route = routeOf(address, selfFp());
    return 'machine' in route ? { machine: route.machine } : address.agentId;
  };
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string') {
      const local = localize(value);
      // call_wire_tool's target is a wire, which may lead to another machine (#3064): its address stays as it is.
      if (typeof local !== 'string') {
        if (grant === 'called_tool' || remoteNames.has(name)) continue;
        return refusal(local.machine);
      }
      out[name] = local;
    } else if (Array.isArray(value)) {
      const list: unknown[] = [];
      for (const item of value) {
        if (typeof item !== 'string') { list.push(item); continue; }
        const local = localize(item);
        if (typeof local !== 'string') return refusal(local.machine);
        list.push(local);
      }
      out[name] = list;
    }
  }
  return { args: out };
}

/** Says no more than that it's another machine: a refusal never says whether a target exists. */
function refusal(machine: string): LocalizedArgs {
  return { otherMachine: machine, message: 'That agent is on another machine. An agent on another machine is reached through a connection the person made, with the tools it gives you.' };
}
