/**
 * The authoritative roster of a network group project (#3548): who its host
 * says the members are, on every computer, with the roles the host enforces.
 *
 * A copy of a group project only knows its own computer's agents well. The
 * host serves this read-only view over the Annex Network, on the same pinned
 * mTLS route family as sync:
 * - `POST /api/v1/network/group-projects/roster`: one page of the roster. An
 *   older host answers 404, and the copy keeps showing its own members.
 *
 * Every member is named by agent id and machine fingerprint, so two agents
 * with one name on two computers stay apart. Completeness says which
 * computers' inventories the host could check. Nothing here carries a path,
 * instructions, tool switches or a secret, and every list is capped.
 */
import { isMachineFingerprint } from './agent-address';
import { GroupProjectNetworkError } from './group-project-network';

export const GROUP_PROJECT_ROSTER_PATH = '/api/v1/network/group-projects/roster';
/** The roster version a host serves. Additive: a later host keeps answering version 1. */
export const GROUP_PROJECT_ROSTER_VERSION = 1;
export const ROSTER_PAGE_DEFAULT = 100;
export const ROSTER_PAGE_MAX = 200;
/** The most members a copy reads; past this the roster is shown as incomplete. */
export const ROSTER_MEMBERS_MAX = 1000;
export const ROSTER_COPIES_MAX = 32;
export const ROSTER_LABEL_MAX = 100;
/** The most a copy reads of one page's answer. A page at its caps is far smaller. */
export const ROSTER_RESPONSE_MAX_BYTES = 512 * 1024;

export type RosterRoleMode = 'allow' | 'ask' | 'off';
/** How a member joined: in scope on the host, added by someone, or by being in a linked project copy. */
export type RosterProvenance = 'auto' | 'explicit' | 'linked';
/** What the host could check of a computer's inventory. */
export type RosterCopyState = 'verified' | 'unknown' | 'offline' | 'truncated';

export type RosterStatus = 'awake' | 'busy' | 'asleep' | 'unknown';

export interface RosterMember {
  /** Additive observations; absent on older hosts. */
  status?: RosterStatus;
  lastSeen?: string;
  inbox?: string;
  agentId: string;
  /** The computer the agent is on: its identity fingerprint. */
  machine: string;
  label: string;
  kind: 'durable' | 'helper' | 'quick';
  provenance: RosterProvenance;
  projectLabel?: string;
  /** Whether the host could see this agent in an inventory just now. An unverified member is still listed. */
  inventory: 'verified' | 'unknown';
  lead: RosterRoleMode;
  admin: RosterRoleMode;
}

export interface RosterCopy {
  machine: string;
  label: string;
  state: RosterCopyState;
}

export interface RosterRequest {
  v: 1;
  groupProjectId: string;
  offset: number;
  limit: number;
}

export interface RosterPage {
  v: 1;
  roster: number;
  status: 'ok';
  groupProjectId: string;
  host: { machine: string };
  /** The host's sequence number for the group when this page was read. */
  seq: number;
  generatedAt: string;
  members: RosterMember[];
  /** Linked project copies whose agents may be members. */
  copies: RosterCopy[];
  /** More linked copies than a page carries: the roster can't be complete. */
  copiesCut?: boolean;
  /** A digest of the whole roster: pages with different digests are from different rosters. */
  etag: string;
  /** Whether the host could read every one of its own projects in scope. */
  hostInventory: 'complete' | 'partial';
  /** Names the host knows computers by, as a fallback for computers this one doesn't know. */
  machines: Array<{ machine: string; label: string }>;
  page: { offset: number; total: number };
}

/** The same answer for a group that isn't here, isn't shared, or isn't the asker's to see. */
export interface RosterNotFound { v: 1; status: 'not_found' }
/** Too many asks from one computer: try again later. */
export interface RosterBusy { v: 1; status: 'busy' }

export type RosterAnswer = RosterPage | RosterNotFound | RosterBusy;

// ── The view the renderer gets ──────────────────────────────────────────────

export interface GroupProjectRosterMember extends RosterMember {
  /** `agentId@machine`: unique across computers. */
  key: string;
  /** What this computer calls the member's computer. */
  machineLabel: string;
  thisComputer: boolean;
}

export interface GroupProjectRosterCopy extends RosterCopy {
  thisComputer: boolean;
}

/** Why a copy is showing only its own members, or an old roster. */
export type RosterStaleReason = 'offline' | 'changed' | 'failed';
export type RosterUnavailableReason = 'unsupported' | 'offline' | 'failed' | 'not_found' | 'host_removed' | 'not_network' | 'busy';

export type GroupProjectRosterView =
  | {
    groupProjectId: string;
    status: 'available';
    /** `host`: read on the host itself. `live`: fetched just now. `cache`: saved earlier. */
    source: 'host' | 'live' | 'cache';
    hostName: string;
    fetchedAt: string;
    stale?: RosterStaleReason;
    members: GroupProjectRosterMember[];
    copies: GroupProjectRosterCopy[];
    hostInventory: 'complete' | 'partial';
    /** More members than a copy reads. */
    truncated: boolean;
    /** More linked copies than a roster lists. */
    copiesCut: boolean;
    /** True only when every inventory was checked, nothing was cut, and the roster isn't stale. */
    complete: boolean;
  }
  | { groupProjectId: string; status: 'unavailable'; reason: RosterUnavailableReason; hostName: string };

// ── Validation (everything here crossed a machine boundary) ────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ETAG = /^[0-9a-f]{64}$/;
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
// inboxChannelName can expand a 256-character name to 511 sanitized characters
// (U+0130 lowercases to i + combining dot). Allow the six-digit collision hash
// and an optional numeric attempt up to Number.MAX_SAFE_INTEGER: 511 + 7 + 17.
const INBOX = /^inbox-[a-z0-9-]{1,535}$/;
const MODES = new Set<RosterRoleMode>(['allow', 'ask', 'off']);
const KINDS = new Set(['durable', 'helper', 'quick']);
const PROVENANCE = new Set<RosterProvenance>(['auto', 'explicit', 'linked']);
const COPY_STATES = new Set<RosterCopyState>(['verified', 'unknown', 'offline', 'truncated']);

function fail(what: string): never {
  throw new GroupProjectNetworkError(`Invalid group project roster ${what}.`);
}

/** A display label: control characters gone, trimmed and clipped. */
export function clipLabel(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > ROSTER_LABEL_MAX ? `${clean.slice(0, ROSTER_LABEL_MAX - 1)}…` : clean;
}

const label = (v: unknown, what: string): string => {
  if (typeof v !== 'string') fail(what);
  return clipLabel(v);
};
const machineOf = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !isMachineFingerprint(v)) fail(what);
  return v.toLowerCase();
};

export function readRosterRequest(raw: unknown): RosterRequest {
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.groupProjectId !== 'string' || !SAFE_ID.test(raw.groupProjectId)) fail('request');
  const offset = raw.offset ?? 0;
  const limit = raw.limit ?? ROSTER_PAGE_DEFAULT;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > ROSTER_MEMBERS_MAX) fail('request');
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) fail('request');
  return { v: 1, groupProjectId: raw.groupProjectId, offset: offset as number, limit: Math.min(limit as number, ROSTER_PAGE_MAX) };
}

function readMember(raw: unknown): RosterMember {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || !AGENT_ID.test(raw.agentId)) fail('member');
  if (!KINDS.has(raw.kind as string) || !PROVENANCE.has(raw.provenance as RosterProvenance)) fail('member');
  if (!MODES.has(raw.lead as RosterRoleMode) || !MODES.has(raw.admin as RosterRoleMode)) fail('member');
  if (raw.inventory !== 'verified' && raw.inventory !== 'unknown') fail('member');
  if (raw.status !== undefined && !['awake', 'busy', 'asleep', 'unknown'].includes(raw.status as string)) fail('member status');
  if (raw.lastSeen !== undefined && (typeof raw.lastSeen !== 'string' || raw.lastSeen.length > 40 || Number.isNaN(Date.parse(raw.lastSeen)))) fail('member last seen');
  return {
    ...(raw.status !== undefined && { status: raw.status as RosterStatus }),
    ...(typeof raw.lastSeen === 'string' && { lastSeen: raw.lastSeen }),
    ...(typeof raw.inbox === 'string' && INBOX.test(raw.inbox) && { inbox: raw.inbox }),
    agentId: raw.agentId,
    machine: machineOf(raw.machine, 'member'),
    label: label(raw.label, 'member') || raw.agentId,
    kind: raw.kind as RosterMember['kind'],
    provenance: raw.provenance as RosterProvenance,
    ...(typeof raw.projectLabel === 'string' && clipLabel(raw.projectLabel) && { projectLabel: clipLabel(raw.projectLabel) }),
    inventory: raw.inventory,
    lead: raw.lead as RosterRoleMode,
    admin: raw.admin as RosterRoleMode,
  };
}

function readCopy(raw: unknown): RosterCopy {
  if (!isRecord(raw) || !COPY_STATES.has(raw.state as RosterCopyState)) fail('copy');
  return { machine: machineOf(raw.machine, 'copy'), label: label(raw.label, 'copy'), state: raw.state as RosterCopyState };
}

/**
 * A host's answer. `host` is the authenticated computer that answered: a
 * computer speaks only for what it hosts. `request` is what was asked.
 */
export function readRosterAnswer(raw: unknown, host: string, request: RosterRequest): RosterAnswer {
  if (!isRecord(raw) || raw.v !== 1) fail('answer');
  if (raw.status === 'not_found') return { v: 1, status: 'not_found' };
  if (raw.status === 'busy') return { v: 1, status: 'busy' };
  if (raw.status !== 'ok' || !Number.isSafeInteger(raw.roster) || (raw.roster as number) < 1) fail('answer');
  if (raw.groupProjectId !== request.groupProjectId) fail('answer');
  if (!isRecord(raw.host) || typeof raw.host.machine !== 'string' || raw.host.machine.toLowerCase() !== host.toLowerCase()) fail('host');
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0) fail('answer');
  if (typeof raw.generatedAt !== 'string' || raw.generatedAt.length > 40 || Number.isNaN(Date.parse(raw.generatedAt))) fail('answer');
  if (typeof raw.etag !== 'string' || !ETAG.test(raw.etag)) fail('answer');
  if (raw.copiesCut !== undefined && typeof raw.copiesCut !== 'boolean') fail('answer');
  if (!Array.isArray(raw.members) || raw.members.length > request.limit) fail('members');
  if (!Array.isArray(raw.copies) || raw.copies.length > ROSTER_COPIES_MAX) fail('copies');
  if (!Array.isArray(raw.machines) || raw.machines.length > ROSTER_COPIES_MAX + 1) fail('machines');
  if (raw.hostInventory !== 'complete' && raw.hostInventory !== 'partial') fail('answer');
  const page = raw.page;
  if (!isRecord(page) || page.offset !== request.offset || !Number.isSafeInteger(page.total) || (page.total as number) < 0) fail('page');
  return {
    v: 1, roster: raw.roster as number, status: 'ok', groupProjectId: request.groupProjectId,
    host: { machine: host.toLowerCase() }, seq: raw.seq as number, generatedAt: new Date(raw.generatedAt).toISOString(), etag: raw.etag,
    members: raw.members.map(readMember),
    copies: raw.copies.map(readCopy),
    ...(raw.copiesCut === true && { copiesCut: true }),
    hostInventory: raw.hostInventory,
    machines: raw.machines.map((m) => {
      if (!isRecord(m)) fail('machines');
      return { machine: machineOf(m.machine, 'machines'), label: label(m.label, 'machines') };
    }),
    page: { offset: request.offset, total: page.total as number },
  };
}
