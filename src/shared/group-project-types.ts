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
  /**
   * The one-time "Include every agent in scope" offer of a group project
   * migrated from canvas wires (#3357): shown while pending. Absent on a
   * record that was never migrated.
   */
  autoJoinOffer?: 'pending' | 'accepted' | 'dismissed';
  /** Per-member tool switches (#2084), keyed by address. */
  disabledTools?: Record<string, string[]>;
  /** A member's wire instructions carried over from canvas wires by migration (#3357), by address. */
  instructions?: Record<string, Record<string, string>>;
  /**
   * A member's own topic subscriptions for post notices (#3362), by address:
   * topics added to, or removed from, the default set (general, control, its inbox).
   */
  subscriptions?: Record<string, { add?: string[]; remove?: string[] }>;
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

/** A one-use deletion confirmation and the impact the person reviewed. */
export interface GroupProjectDeleteImpact {
  token: string;
  members: string[];
  exclusions: string[];
  canvases: string[];
  actions: string[];
  grants: string[];
  messages: number;
  topics: number;
  machines: string[];
  incompleteWindows: boolean;
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
export type GroupProjectMemberKind = GroupProjectExplicitMember['kind'];

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

/** One agent's lead and admin grants on a group project (#3360): Allow, Ask first or Off. */
export interface GroupProjectRoleHolderView {
  agentId: string;
  lead: 'allow' | 'ask' | 'off';
  admin: 'allow' | 'ask' | 'off';
}

/** A group project's own grants and who leads and administers it (#3360). */
export interface GroupProjectRolesView {
  groupProjectId: string;
  /** What it does by itself: post notices to members, and wake a member with a lead's shoulder tap. */
  own: { deliver: 'allow' | 'off'; wake: 'allow' | 'off' };
  holders: GroupProjectRoleHolderView[];
}

/** Who would auto-join a group project with a given scope, shown before creating it (#3357). */
export interface AutoJoinPreview {
  wouldJoin: ResolvedGroupProjectMember[];
  /** Projects in scope whose agents couldn't be read: their agents would join too once readable. */
  unreadableProjects: Array<{ projectId: string; name: string }>;
}

/** What the directory shows about one group project's membership. */
export interface GroupProjectMembershipView {
  groupProjectId: string;
  /** False for a group project still held by canvas wires (not migrated yet). */
  managed: boolean;
  /** Why it isn't migrated yet, when a Canvas store couldn't be read. */
  deferred?: string;
  autoJoin: boolean;
  members: ResolvedGroupProjectMember[];
  excluded: Array<{ agentId: string; name: string; excludedAt: string }>;
  /** Pending only on a migrated group project; `wouldJoin` lists who accepting adds. */
  autoJoinOffer?: { state: 'pending' | 'accepted' | 'dismissed'; wouldJoin: ResolvedGroupProjectMember[] };
}
