/**
 * Shared types for the Group Project system — a coordination space
 * where multiple agents collaborate via a shared bulletin board.
 */

export type GroupProjectScope =
  | { level: 'project'; projectId: string; reach: 'local' | 'network' }
  | { level: 'app'; reach: 'local' | 'network' };

export interface GroupProjectCreateOptions {
  /** Supplies the default scope only when scope is omitted. */
  projectId?: string;
  scope?: GroupProjectScope;
}

/**
 * The machine that holds the truth about a group project (#3356). Set at
 * creation and fixed in v1. `machine` is its Annex identity fingerprint
 * (lowercase), or null for the machine whose registry holds the record when
 * it had no Annex identity (legacy records and Annex-off creation).
 */
export interface GroupProjectHost {
  machine: string | null;
}

/** A group project entity. */
export interface GroupProject {
  id: string;            // "gp_<timestamp>_<random>"
  name: string;
  description: string;   // purpose of this group, shown to agents
  instructions: string;  // rules agents must follow
  createdAt: string;     // ISO 8601
  /** Absent only on legacy records awaiting membership-aware migration. */
  scope?: GroupProjectScope;
  /** Always present once loaded; legacy records load as this machine. */
  host?: GroupProjectHost;
  /** Latest change sequence number (#3356); 0 before the first sequenced change. */
  seq?: number;
  metadata: Record<string, unknown>;
}

/** One member recorded explicitly (helpers, quick agents, or a person's addition). */
export interface GroupProjectExplicitMember {
  /** Host-relative agent address: a bare id on the host machine, `id@<fingerprint>` elsewhere. */
  address: string;
  kind: 'durable' | 'helper' | 'quick';
  addedAt: string;
  runId?: string;
  /** Display only, never identity. */
  name?: string;
  [extra: string]: unknown;
}

export interface GroupProjectExclusion {
  address: string;
  excludedAt: string;
  [extra: string]: unknown;
}

/**
 * The membership record the host stores per group project (#3356). Policy
 * (auto-join, exclusions) is #3357's; the store persists it, keyed by address,
 * and keeps fields it does not know.
 */
export interface GroupProjectMembership {
  version: 1;
  autoJoin: boolean;
  explicit: GroupProjectExplicitMember[];
  excluded: GroupProjectExclusion[];
  autoJoinOffer?: 'pending' | 'accepted' | 'dismissed';
  /** Per-member tool switches (#2084), keyed by address. */
  disabledTools?: Record<string, string[]>;
  [extra: string]: unknown;
}

/**
 * Left behind when a group project is deleted, so other machines learn of it.
 * `deleting` while the delete's cleanup still runs (#3364), `deleted` once done.
 */
export interface GroupProjectTombstone {
  groupProjectId: string;
  host: GroupProjectHost;
  seq: number;
  deletedAt: string;
  state: 'deleting' | 'deleted';
}

/** What changed in one sequenced host write. */
export type GroupProjectChangePart = 'record' | 'membership' | 'board' | 'deleted';

export interface GroupProjectChange {
  groupProjectId: string;
  seq: number;
  part: GroupProjectChangePart;
  /** On `deleted`: the group project as it was when its delete began. */
  project?: GroupProject;
}

/** A member as other parts of the app see it (resolved by #3357's policy, or wires). */
export interface GroupProjectMemberView {
  address: string;
  name: string;
  projectId?: string;
}

/** Whether network reach can be chosen now, and why not (#3355). */
export interface GroupProjectScopeOptions {
  network: { available: boolean; reason?: string };
}

/** A message posted to the bulletin board. */
export interface BulletinMessage {
  id: string;            // "msg_<timestamp>_<random>"
  sender: string;        // "agentName@projectName" or "system"
  topic: string;         // freeform; "system" is reserved
  body: string;          // up to ~100KB
  timestamp: string;     // ISO 8601
  /** The group project's sequence number when it was posted (#3356). Absent on older messages. */
  seq?: number;
}

/** Summary of a topic in the bulletin digest. */
export interface TopicDigest {
  topic: string;
  messageCount: number;
  newMessageCount: number;   // since the `since` param
  latestTimestamp: string;
  isProtected?: boolean;
}

/** Per-project retention limits for unprotected bulletin messages only. */
export interface BulletinRetentionConfig {
  maxPerTopic: number;
  maxTotal: number;
}

/**
 * Unread cutoff for a bulletin digest: a single ISO timestamp applied to every
 * channel, or a per-channel `channel -> ISO timestamp` map. The map form is
 * what the UI passes so each channel's unread count reflects when that channel
 * was last read.
 */
export type DigestSince = string | Record<string, string>;

/** How a member came to be in a group project (#3357). */
export type GroupProjectMemberKind = 'durable' | 'helper' | 'quick';

/**
 * The membership record of one group project (#3357), kept on its host in
 * `group-projects/<id>/membership.json`. Members are keyed by address: a bare
 * agent id on the host machine. Names are display only.
 */
export interface GroupProjectMembership {
  version: 1;
  /** Every top-level durable agent in scope is a member unless excluded. */
  autoJoin: boolean;
  /** Members added by hand: helpers, quick agents for one run, and durable agents outside auto-join. */
  explicit: Array<{ address: string; kind: GroupProjectMemberKind; addedAt: string; runId?: string; name?: string }>;
  /** Agents left out. An excluded agent never joins automatically. */
  excluded: Array<{ address: string; excludedAt: string }>;
  /**
   * The one-time "Include every agent in scope" offer of a group project
   * migrated from canvas wires: shown while pending. Absent on a record that
   * was never migrated.
   */
  autoJoinOffer?: 'pending' | 'accepted' | 'dismissed';
  /** A member's own tool switches on the group project (#2084): disabled tool suffixes by address. */
  disabledTools?: Record<string, string[]>;
}

/** One member as resolved from the record, scope and the agents that exist now. */
export interface ResolvedGroupProjectMember {
  agentId: string;
  /** Display name. A quick agent's carries a run suffix, so two runs with one name stay apart (#1646). */
  name: string;
  kind: GroupProjectMemberKind;
  /** 'auto': joined by being in scope. 'explicit': added by a person or an orchestrator. */
  via: 'auto' | 'explicit';
  projectId?: string;
  projectName?: string;
}

/** What the directory shows about one group project's membership. */
export interface GroupProjectMembershipView {
  groupProjectId: string;
  /** False for a group project still held by canvas wires (not migrated yet). */
  managed: boolean;
  autoJoin: boolean;
  members: ResolvedGroupProjectMember[];
  excluded: Array<{ agentId: string; name: string; excludedAt: string }>;
  /** Pending only on a migrated group project; `wouldJoin` lists who accepting adds. */
  autoJoinOffer?: { state: 'pending' | 'accepted' | 'dismissed'; wouldJoin: ResolvedGroupProjectMember[] };
}
