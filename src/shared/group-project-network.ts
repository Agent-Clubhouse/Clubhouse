/**
 * Network group projects over Annex (#3363): what member computers send each
 * other. The host keeps the truth; other computers keep a cached copy that
 * follows the host's sequence numbers, and send writes to the host, queued
 * while it is away.
 *
 * Routes, on the main TLS port over pinned mTLS, between computers in the
 * network only:
 * - `POST /api/v1/network/group-projects/sync`: catch up from the host.
 * - `POST /api/v1/network/group-projects/write`: writes for the host to apply or refuse, in order.
 * - `POST /api/v1/network/group-projects/changed`: the host's notice that something changed.
 */
import type {
  BulletinMessage, GroupProject, GroupProjectMembership, GroupProjectTombstone,
} from './group-project-types';

export const GROUP_PROJECT_NETWORK_VERSION = 1;
export const GROUP_PROJECT_SYNC_PATH = '/api/v1/network/group-projects/sync';
export const GROUP_PROJECT_WRITE_PATH = '/api/v1/network/group-projects/write';
export const GROUP_PROJECT_CHANGED_PATH = '/api/v1/network/group-projects/changed';

/** The board as the host has it, from a sequence number on. */
export interface ReplicaBoard {
  /** Messages with a sequence number after the one the caller has (all of them on a first sync). */
  messages: BulletinMessage[];
  /** Every message id the board still holds, by topic, so the copy drops what the host removed. */
  ids: Record<string, string[]>;
  protectedTopics: string[];
  inboxOwners: Record<string, string>;
}

/** One group project as its host has it now. */
export interface ReplicaSnapshot {
  record: GroupProject;
  seq: number;
  membership: GroupProjectMembership;
  board: ReplicaBoard;
}

export interface SyncRequest {
  v: 1;
  /** The sequence number this computer has for each group project it holds a copy of. */
  known: Record<string, number>;
}

export interface SyncResponse {
  v: 1;
  /** Network group projects the host holds that changed since `known`. */
  projects: ReplicaSnapshot[];
  /** Ids the host still holds unchanged. A copy the host neither lists nor tombstones is no longer shared. */
  unchanged: string[];
  tombstones: GroupProjectTombstone[];
}

/** A change to membership, applied by the host onto its own current record. */
export interface MembershipPatch {
  addExplicit: GroupProjectMembership['explicit'];
  removeExplicit: string[];
  addExcluded: GroupProjectMembership['excluded'];
  removeExcluded: string[];
  /** Other fields set to these values (`autoJoin`, policy fields). */
  set: Record<string, unknown>;
}

export type WriteOp =
  | { op: 'post'; sender: string; topic: string; body: string }
  | { op: 'deleteMessage'; topic: string; messageId: string }
  | { op: 'deleteTopic'; topic: string }
  | { op: 'setTopicProtected'; topic: string; isProtected: boolean }
  | { op: 'update'; fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> } }
  | { op: 'membership'; patch: MembershipPatch }
  | { op: 'ensureChannels' }
  | { op: 'ensureInbox'; agentName: string; address: string };

export type WriteOpName = WriteOp['op'];

/** Who asked for a write: an agent on the sending computer, or the person. */
export interface WriteAuthor {
  agentId?: string;
  label: string;
}

export interface QueuedWrite {
  id: string;
  groupProjectId: string;
  author: WriteAuthor;
  queuedAt: string;
  write: WriteOp;
}

export interface WriteRequest {
  v: 1;
  writes: QueuedWrite[];
}

export type WriteResult =
  | { id: string; status: 'applied'; seq: number; result?: unknown }
  | { id: string; status: 'refused'; reason: string };

export interface WriteResponse {
  v: 1;
  results: WriteResult[];
}

export interface ChangedNotice {
  v: 1;
  ids: string[];
}

// ── Validation (everything here crossed a machine boundary) ────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_WRITES = 100;

export class GroupProjectNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupProjectNetworkError';
  }
}

function fail(what: string): never {
  throw new GroupProjectNetworkError(`Invalid group project network ${what}.`);
}

export function readSyncRequest(raw: unknown): SyncRequest {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.known)) fail('sync request');
  const known: Record<string, number> = {};
  for (const [id, seq] of Object.entries(raw.known)) {
    if (!SAFE_ID.test(id) || !Number.isSafeInteger(seq) || (seq as number) < 0) fail('sync request');
    known[id] = seq as number;
  }
  return { v: 1, known };
}

function readMessage(m: unknown): BulletinMessage {
  if (!isRecord(m) || !isString(m.id) || !isString(m.sender) || !isString(m.topic) || !isString(m.body) || !isString(m.timestamp)
    || (m.seq !== undefined && !Number.isSafeInteger(m.seq))) fail('message');
  return { id: m.id, sender: m.sender, topic: m.topic, body: m.body, timestamp: m.timestamp, ...(m.seq !== undefined && { seq: m.seq as number }) };
}

function readSnapshot(raw: unknown, host: string): ReplicaSnapshot {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.seq) || !isRecord(raw.record) || !isRecord(raw.membership) || !isRecord(raw.board)) fail('snapshot');
  const record = raw.record as unknown as GroupProject;
  if (!isString(record.id) || !SAFE_ID.test(record.id) || !isString(record.name) || !isRecord(record.metadata)
    || !isRecord(record.scope) || record.scope.reach !== 'network') fail('snapshot record');
  // A computer speaks only for what it hosts.
  if (!isRecord(record.host) || record.host.machine !== host) fail('snapshot host');
  const board = raw.board;
  if (!Array.isArray(board.messages) || !isRecord(board.ids) || !Array.isArray(board.protectedTopics) || !isRecord(board.inboxOwners)) fail('snapshot board');
  const ids: Record<string, string[]> = {};
  for (const [topic, list] of Object.entries(board.ids)) {
    if (!Array.isArray(list) || !list.every(isString)) fail('snapshot board');
    ids[topic] = list as string[];
  }
  const inboxOwners: Record<string, string> = {};
  for (const [channel, owner] of Object.entries(board.inboxOwners)) {
    if (!isString(owner)) fail('snapshot board');
    inboxOwners[channel] = owner;
  }
  return {
    record: { ...record, host: { machine: host } },
    seq: raw.seq as number,
    membership: raw.membership as unknown as GroupProjectMembership,
    board: {
      messages: board.messages.map(readMessage),
      ids,
      protectedTopics: board.protectedTopics.filter(isString),
      inboxOwners,
    },
  };
}

/** `host` is the authenticated computer that answered. */
export function readSyncResponse(raw: unknown, host: string): SyncResponse {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.projects) || !Array.isArray(raw.unchanged) || !Array.isArray(raw.tombstones)) fail('sync response');
  return {
    v: 1,
    projects: raw.projects.map((p) => readSnapshot(p, host)),
    unchanged: raw.unchanged.filter((id): id is string => isString(id) && SAFE_ID.test(id)),
    tombstones: raw.tombstones.flatMap((t): GroupProjectTombstone[] => {
      if (!isRecord(t) || !isString(t.groupProjectId) || !SAFE_ID.test(t.groupProjectId) || !Number.isSafeInteger(t.seq) || !isString(t.deletedAt)) return [];
      // Only the host's own deletes count.
      return [{ groupProjectId: t.groupProjectId, host: { machine: host }, seq: t.seq as number, deletedAt: t.deletedAt, state: t.state === 'deleting' ? 'deleting' : 'deleted' }];
    }),
  };
}

/** Membership fields a patch may set; anything else is refused. */
const PATCH_FIELDS = new Set(['autoJoin', 'autoJoinOffer', 'subscriptions', 'disabledTools', 'scopeMembersRecorded']);
const MEMBER_KINDS = new Set(['durable', 'helper', 'quick']);

function readEntry(raw: unknown, dated: 'addedAt' | 'excludedAt'): Record<string, unknown> & { address: string } {
  if (!isRecord(raw) || !isString(raw.address) || !raw.address || !isString(raw[dated])) fail('membership patch');
  if (dated === 'addedAt' && !MEMBER_KINDS.has(raw.kind as string)) fail('membership patch');
  return raw as Record<string, unknown> & { address: string };
}

function readPatch(raw: unknown): MembershipPatch {
  if (!isRecord(raw) || !Array.isArray(raw.addExplicit) || !Array.isArray(raw.removeExplicit) || !Array.isArray(raw.addExcluded)
    || !Array.isArray(raw.removeExcluded) || !isRecord(raw.set)) fail('membership patch');
  if (!raw.removeExplicit.every(isString) || !raw.removeExcluded.every(isString)) fail('membership patch');
  for (const [key, value] of Object.entries(raw.set)) {
    if (!PATCH_FIELDS.has(key)) fail('membership patch');
    if (key === 'autoJoin' && typeof value !== 'boolean') fail('membership patch');
    if ((key === 'subscriptions' || key === 'disabledTools') && value !== null && !isRecord(value)) fail('membership patch');
  }
  return {
    addExplicit: raw.addExplicit.map((e) => readEntry(e, 'addedAt')) as MembershipPatch['addExplicit'],
    removeExplicit: raw.removeExplicit as string[],
    addExcluded: raw.addExcluded.map((e) => readEntry(e, 'excludedAt')) as MembershipPatch['addExcluded'],
    removeExcluded: raw.removeExcluded as string[],
    set: raw.set,
  };
}

function readOp(raw: unknown): WriteOp {
  if (!isRecord(raw) || !isString(raw.op)) fail('write');
  switch (raw.op) {
    case 'post':
      if (!isString(raw.sender) || !isString(raw.topic) || !isString(raw.body)) fail('write');
      return { op: 'post', sender: raw.sender, topic: raw.topic, body: raw.body };
    case 'deleteMessage':
      if (!isString(raw.topic) || !isString(raw.messageId)) fail('write');
      return { op: 'deleteMessage', topic: raw.topic, messageId: raw.messageId };
    case 'deleteTopic':
      if (!isString(raw.topic)) fail('write');
      return { op: 'deleteTopic', topic: raw.topic };
    case 'setTopicProtected':
      if (!isString(raw.topic) || typeof raw.isProtected !== 'boolean') fail('write');
      return { op: 'setTopicProtected', topic: raw.topic, isProtected: raw.isProtected };
    case 'update': {
      const f = raw.fields;
      if (!isRecord(f) || (f.name !== undefined && !isString(f.name)) || (f.description !== undefined && !isString(f.description))
        || (f.instructions !== undefined && !isString(f.instructions)) || (f.metadata !== undefined && !isRecord(f.metadata))) fail('write');
      return { op: 'update', fields: f as Extract<WriteOp, { op: 'update' }>['fields'] };
    }
    case 'membership':
      return { op: 'membership', patch: readPatch(raw.patch) };
    case 'ensureChannels':
      return { op: 'ensureChannels' };
    case 'ensureInbox':
      if (!isString(raw.agentName) || !isString(raw.address)) fail('write');
      return { op: 'ensureInbox', agentName: raw.agentName, address: raw.address };
    default:
      fail('write');
  }
}

export function readWriteRequest(raw: unknown): WriteRequest {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.writes) || raw.writes.length > MAX_WRITES) fail('write request');
  return {
    v: 1,
    writes: raw.writes.map((w): QueuedWrite => {
      if (!isRecord(w) || !isString(w.id) || !isString(w.groupProjectId) || !SAFE_ID.test(w.groupProjectId) || !isString(w.queuedAt)
        || !isRecord(w.author) || !isString(w.author.label) || (w.author.agentId !== undefined && !isString(w.author.agentId))) fail('write request');
      return {
        id: w.id, groupProjectId: w.groupProjectId, queuedAt: w.queuedAt,
        author: { label: w.author.label, ...(w.author.agentId !== undefined && { agentId: w.author.agentId as string }) },
        write: readOp(w.write),
      };
    }),
  };
}

export function readWriteResponse(raw: unknown): WriteResponse {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.results)) fail('write response');
  return {
    v: 1,
    results: raw.results.map((r): WriteResult => {
      if (!isRecord(r) || !isString(r.id)) fail('write response');
      if (r.status === 'applied' && Number.isSafeInteger(r.seq)) return { id: r.id, status: 'applied', seq: r.seq as number, ...(r.result !== undefined && { result: r.result }) };
      if (r.status === 'refused' && isString(r.reason)) return { id: r.id, status: 'refused', reason: r.reason };
      fail('write response');
    }),
  };
}

export function readChangedNotice(raw: unknown): ChangedNotice {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.ids)) fail('changed notice');
  return { v: 1, ids: raw.ids.filter((id): id is string => isString(id) && SAFE_ID.test(id)).slice(0, 1000) };
}

/** The patch that turns `from` into `to`, field by field. */
export function membershipPatch(from: GroupProjectMembership, to: GroupProjectMembership): MembershipPatch {
  const key = (e: { address: string }) => e.address;
  const fromExplicit = new Map(from.explicit.map((e) => [key(e), JSON.stringify(e)]));
  const toExplicit = new Map(to.explicit.map((e) => [key(e), JSON.stringify(e)]));
  const fromExcluded = new Map(from.excluded.map((e) => [key(e), JSON.stringify(e)]));
  const toExcluded = new Map(to.excluded.map((e) => [key(e), JSON.stringify(e)]));
  const set: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (k === 'version' || k === 'explicit' || k === 'excluded') continue;
    if (JSON.stringify(from[k]) !== JSON.stringify(to[k])) set[k] = to[k] === undefined ? null : to[k];
  }
  return {
    addExplicit: to.explicit.filter((e) => fromExplicit.get(key(e)) !== JSON.stringify(e)),
    removeExplicit: from.explicit.filter((e) => !toExplicit.has(key(e)) || toExplicit.get(key(e)) !== JSON.stringify(e)).map(key),
    addExcluded: to.excluded.filter((e) => fromExcluded.get(key(e)) !== JSON.stringify(e)),
    removeExcluded: from.excluded.filter((e) => !toExcluded.has(key(e)) || toExcluded.get(key(e)) !== JSON.stringify(e)).map(key),
    set,
  };
}

export function isEmptyPatch(patch: MembershipPatch): boolean {
  return patch.addExplicit.length === 0 && patch.removeExplicit.length === 0 && patch.addExcluded.length === 0
    && patch.removeExcluded.length === 0 && Object.keys(patch.set).length === 0;
}

/** Apply a patch onto the host's current membership. Removals first, so a changed entry is replaced. */
export function applyMembershipPatch(current: GroupProjectMembership, patch: MembershipPatch): GroupProjectMembership {
  const removeExplicit = new Set(patch.removeExplicit);
  const removeExcluded = new Set(patch.removeExcluded);
  const explicit = current.explicit.filter((e) => !removeExplicit.has(e.address));
  const excluded = current.excluded.filter((e) => !removeExcluded.has(e.address));
  for (const e of patch.addExplicit) if (!explicit.some((x) => x.address === e.address)) explicit.push(e);
  for (const e of patch.addExcluded) if (!excluded.some((x) => x.address === e.address)) excluded.push(e);
  const next: GroupProjectMembership = { ...current, explicit, excluded };
  for (const [k, v] of Object.entries(patch.set)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}
