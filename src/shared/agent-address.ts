/**
 * Machine-qualified agent addresses (#3063, Annex Network stage 6).
 *
 * An agent reference may say which machine the agent is on: `<agentId>@<machine>`,
 * where the machine is its identity fingerprint (colon-separated hex). A
 * reference without a machine means this machine, so every existing reference
 * keeps working unchanged. Agent ids never contain `@`.
 *
 * The renderer's namespaced ids for a connected machine's agents
 * (`remote||<machine>||<agentId>`, remoteProjectStore) convert to and from this.
 */

export interface AgentAddress {
  agentId: string;
  /** Identity fingerprint of the machine it's on. Absent: this machine. */
  machine?: string;
}

/** An identity fingerprint: 16 to 32 colon-separated hex bytes. */
const MACHINE = /^[0-9a-f]{2}(:[0-9a-f]{2}){15,31}$/i;

export function isMachineFingerprint(value: string): boolean {
  return MACHINE.test(value);
}

/** The reference as text: the agent id alone for this machine, or `agentId@machine`. */
export function formatAgentAddress(address: AgentAddress): string {
  return address.machine ? `${address.agentId}@${address.machine.toLowerCase()}` : address.agentId;
}

/**
 * Reads a reference. A plain id (or anything without a well-formed machine
 * after the last `@`) is this machine's; the machine is lowercased.
 */
export function parseAgentAddress(reference: string): AgentAddress {
  const at = reference.lastIndexOf('@');
  if (at > 0) {
    const machine = reference.slice(at + 1);
    if (isMachineFingerprint(machine)) return { agentId: reference.slice(0, at), machine: machine.toLowerCase() };
  }
  return { agentId: reference };
}

/** Where a reference routes: `local` (this machine, or no machine), or the machine it names. */
export function routeOf(address: AgentAddress, selfFingerprint: string | undefined): { local: true } | { local: false; machine: string } {
  if (!address.machine) return { local: true };
  if (selfFingerprint && address.machine.toLowerCase() === selfFingerprint.toLowerCase()) return { local: true };
  return { local: false, machine: address.machine.toLowerCase() };
}

/** This machine's form of a reference: the bare id when it's local, unchanged otherwise. */
export function localizeAgentReference(reference: string, selfFingerprint: string | undefined): string {
  const address = parseAgentAddress(reference);
  return routeOf(address, selfFingerprint).local ? address.agentId : reference;
}

const NS_PREFIX = 'remote||';
const NS_SEP = '||';

/** The address of a renderer namespaced id (`remote||<machine>||<agentId>`), or null when it isn't one. */
export function addressFromNamespacedId(id: string): AgentAddress | null {
  if (!id.startsWith(NS_PREFIX)) return null;
  const rest = id.slice(NS_PREFIX.length);
  const sep = rest.indexOf(NS_SEP);
  if (sep === -1) return null;
  return { agentId: rest.slice(sep + NS_SEP.length), machine: rest.slice(0, sep).toLowerCase() };
}

/** The renderer namespaced id for an address on another machine; a local one is its bare id. */
export function namespacedIdFromAddress(address: AgentAddress): string {
  return address.machine ? `${NS_PREFIX}${address.machine.toLowerCase()}${NS_SEP}${address.agentId}` : address.agentId;
}
