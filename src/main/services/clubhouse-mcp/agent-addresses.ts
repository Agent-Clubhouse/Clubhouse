/**
 * Machine-qualified agent references in tool calls (#3063, Annex Network stage 6).
 *
 * An argument that names an agent may say which machine it's on
 * (`<agentId>@<machine>`, src/shared/agent-address.ts). Before a call is
 * checked and run, every such argument naming this machine becomes the bare
 * id, so tools and grant checks see what they always have. One naming another
 * machine is refused with a clear message: reaching agents on other machines
 * is stage 7 (#3064), which will route it there instead.
 */
import { parseAgentAddress, routeOf } from '../../../shared/agent-address';
import * as annexIdentity from '../annex-identity';
import * as annexPeers from '../annex-peers';
import { toolGrantDeclarations, type ToolGrant } from './tool-grants';

export type LocalizedArgs = { args: Record<string, unknown> } | { otherMachine: string; message: string };

/** The arguments a tool's grant says name agents. */
function agentArgNames(grant: ToolGrant | undefined): string[] {
  if (!grant) return [];
  const names = new Set<string>();
  for (const d of toolGrantDeclarations(grant)) {
    if (d.target === 'agent_arg' && d.from) for (const arg of d.from.args) names.add(arg);
  }
  return [...names];
}

/** `args` with this machine's agent references made local, or why the call can't run here. */
export function localizeAgentArgs(grant: ToolGrant | undefined, args: Record<string, unknown>): LocalizedArgs {
  const names = agentArgNames(grant);
  if (names.length === 0) return { args };
  const self = annexIdentity.getIdentity()?.fingerprint;
  const out: Record<string, unknown> = { ...args };
  for (const name of names) {
    const value = args[name];
    const localize = (ref: string): string | { machine: string } => {
      const address = parseAgentAddress(ref);
      const route = routeOf(address, self);
      return 'machine' in route ? { machine: route.machine } : address.agentId;
    };
    if (typeof value === 'string') {
      const local = localize(value);
      if (typeof local !== 'string') return refusal(local.machine);
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

function refusal(machine: string): LocalizedArgs {
  const name = annexPeers.getPeer(machine)?.alias;
  return {
    otherMachine: machine,
    message: `That agent is on another machine${name ? ` (${name})` : ''}. Agents on other machines can't be reached from here yet.`,
  };
}
