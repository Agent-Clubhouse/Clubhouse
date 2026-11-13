/**
 * Group project member addresses (#3356). Members are keyed by machine-qualified
 * agent address (#3063), relative to the group project's host: an agent on the
 * host machine is its bare id, one on another machine is `id@<fingerprint>`.
 * Names are display only, so two agents with the same name stay distinct.
 */
import { formatAgentAddress, parseAgentAddress } from './agent-address';

/** The host-relative address of an agent. `hostMachine` null means the host has no identity. */
export function memberAddress(agentId: string, machine?: string | null, hostMachine?: string | null): string {
  const m = machine?.toLowerCase();
  if (!m || (hostMachine && m === hostMachine.toLowerCase())) return agentId;
  return formatAgentAddress({ agentId, machine: m });
}

/** Normalize an address to its host-relative form. */
export function canonicalMemberAddress(reference: string, hostMachine?: string | null): string {
  const address = parseAgentAddress(reference.trim());
  return memberAddress(address.agentId, address.machine, hostMachine);
}

/** Whether two references name the same member of a group project hosted on `hostMachine`. */
export function sameMember(a: string, b: string, hostMachine?: string | null): boolean {
  return canonicalMemberAddress(a, hostMachine) === canonicalMemberAddress(b, hostMachine);
}
