/**
 * The network-wide lead Dispatcher (#3351, phase 2 of #2834). One record, the
 * same on every computer member once they've heard from each other.
 *
 * A person chooses it on any member. The record spreads with each pair of
 * members' connection exchange, and the newest one wins everywhere. "Newest"
 * is a counter first: a choice always counts one past the newest record its
 * machine has seen, so a slow or fast clock can't undo a later choice. Two
 * choices made at once (same counter) settle on the later time, then on the
 * machine id, so every member picks the same one.
 */

export interface LeadRecord {
  v: 1;
  /** The lead's machine fingerprint (lowercase), or null for peers. */
  lead: string | null;
  /** One past the newest record the choosing machine had seen. 0 is "never chosen". */
  rev: number;
  /** When it was chosen, by the choosing machine's clock. Only breaks ties. */
  changedAt: string;
  /** The machine where it was chosen, or cleared. */
  by: string;
  /** Set when the lead was cleared because its machine left the network, with that machine's name. */
  clearedFor?: { machine: string; name: string };
}

export const NO_LEAD: LeadRecord = { v: 1, lead: null, rev: 0, changedAt: new Date(0).toISOString(), by: '' };

const MAX_ID = 200;
const MAX_REV = 1_000_000_000;

function machineId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && !value.includes('@');
}

/** A record from another machine, or undefined when it isn't one this machine reads. */
export function readLeadRecord(raw: unknown): LeadRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  if (r.lead !== null && !machineId(r.lead)) return undefined;
  if (typeof r.rev !== 'number' || !Number.isInteger(r.rev) || r.rev < 0 || r.rev > MAX_REV) return undefined;
  if (typeof r.changedAt !== 'string' || r.changedAt.length > 40 || Number.isNaN(Date.parse(r.changedAt))) return undefined;
  if (r.rev > 0 ? !machineId(r.by) : r.by !== '' && !machineId(r.by)) return undefined;
  const cleared = r.clearedFor as Record<string, unknown> | undefined;
  if (cleared !== undefined && (!cleared || typeof cleared !== 'object' || !machineId(cleared.machine)
    || typeof cleared.name !== 'string' || !cleared.name || cleared.name.length > MAX_ID)) return undefined;
  return {
    v: 1, lead: r.lead === null ? null : (r.lead as string).toLowerCase(), rev: r.rev, changedAt: new Date(Date.parse(r.changedAt)).toISOString(),
    by: (r.by as string).toLowerCase(),
    ...(cleared && { clearedFor: { machine: (cleared.machine as string).toLowerCase(), name: cleared.name as string } }),
  };
}

/** Above 0 when `a` wins over `b`. Every member orders any two records the same way. */
export function compareLeadRecords(a: LeadRecord, b: LeadRecord): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  const at = Date.parse(a.changedAt) - Date.parse(b.changedAt);
  if (at !== 0) return at;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  const la = a.lead ?? '';
  const lb = b.lead ?? '';
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/** Two records that say the same thing, for "confirmed by". */
export function sameLeadRecord(a: LeadRecord | undefined, b: LeadRecord | undefined): boolean {
  return !!a && !!b && compareLeadRecords(a, b) === 0;
}

/** This machine's relation to the lead. */
export type LeadRole = 'peer' | 'lead' | 'follower';

export interface LeadChoice {
  machine: string;
  name: string;
  self: boolean;
  /** Connected now. Always true for this machine. */
  online: boolean;
}

/** What Settings › Dispatcher shows for Lead. */
export interface DispatcherLeadState {
  /** False when this computer isn't in an Annex Network with another computer. */
  available: boolean;
  role: LeadRole;
  /** The chosen lead, by name, or null for peers. */
  lead: LeadChoice | null;
  /** This machine and every other computer member, this machine first. */
  choices: LeadChoice[];
  /** Members whose last word matches this machine's record. */
  confirmedBy: string[];
  /** Members this machine hasn't heard the record from yet. */
  waitingOn: string[];
  /** When the lead was cleared because its machine left, that machine's name. */
  clearedFor: string | null;
  /** The machine where the current choice was made, by name, when known. */
  changedByName: string | null;
  changedAt: string | null;
  /** A follower that hasn't taken back (#3352): its Dispatcher pane is the lead's chat. */
  following: boolean;
  /** A follower that took back (#3353): it uses its own chat until it follows again. */
  tookBack: boolean;
  /** When this computer last heard from the lead's computer. */
  leadLastSeen: string | null;
  /** Messages typed while the lead was offline (#3353). */
  outbox: LeadOutboxState;
}

export interface LeadOutboxState {
  /** Messages waiting for the lead's computer to come back. */
  waiting: number;
  oldestAt: string | null;
  /** Messages dropped because the lead stayed offline too long, since last dismissed. */
  expired: number;
  /** Why the last waiting message couldn't be delivered, when the lead refused it. */
  failed: string | null;
}

/** How long a message waits for an offline lead before it's dropped. */
export const LEAD_OUTBOX_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** How many messages wait at most. */
export const LEAD_OUTBOX_MAX = 20;
/** The longest message that waits (the chat command's own text limit is larger). */
export const LEAD_OUTBOX_MAX_CHARS = 32_000;
