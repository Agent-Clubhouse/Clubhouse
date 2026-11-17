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
  membership?: GroupProjectMembershipOptions;
}

/** A computer a group project can be created on (#3547). `this` is this computer. */
export interface GroupProjectCreateHost {
  machine: string | null;
  name: string;
  /** `online`: choosable. Anything else says why not. */
  state: 'online' | 'offline' | 'needs_update' | 'unavailable';
  reason?: string;
}

/**
 * What became of a create sent to another computer (#3547). Nothing is made
 * or queued unless it says `created`; every retry of `requestId` is safe.
 */
export type RemoteCreateOutcome = { requestId: string; host: string; hostName: string } & (
  | { status: 'created'; groupProjectId: string; project: GroupProject | null }
  | { status: 'waiting'; expiresAt: string }
  /** `unreachable`: not answered, nothing queued. `unsupported`: that computer needs an update. */
  | { status: 'refused' | 'declined' | 'expired' | 'busy' | 'unreachable' | 'unsupported'; reason: string }
);

/** Ongoing membership for new project groups. Exclusions are host-relative addresses. */
export interface GroupProjectMembershipOptions {
  autoJoin: boolean;
  includeLinkedComputers: boolean;
  excluded?: string[];
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
  /** Who holds it, for people (#3363): "This computer" or the host's device name, never a fingerprint. */
  hostName?: string;
  /** Network reach only: how this computer stands with the host (#3363). */
  network?: GroupProjectNetworkState;
  /**
   * Network project scope: the repository key of the host's project, so other
   * computers can tell which of their projects it covers (#3363).
   */
  scopeProjectKey?: string;
  metadata: Record<string, unknown>;
}

/** A write the host refused, kept for its author to see (#3363). */
export interface GroupProjectNetworkRefusal {
  id: string;
  groupProjectId: string;
  op: string;
  reason: string;
  at: string;
  author: { agentId?: string; label: string };
}

export interface GroupProjectNetworkState {
  /** This computer holds the truth, or a copy of it. */
  role: 'host' | 'replica';
  /** A copy's host connected now, offline (reads from the copy, writes wait), or gone from the network (read-only). */
  state: 'online' | 'cached' | 'host-removed';
  /** Writes made here waiting for the host. */
  waitingWrites: number;
  syncedAt?: string;
  refusals: GroupProjectNetworkRefusal[];
}

/**
 * What became of a change made on a copy of a network group project (#3550).
 * Applied: its host has it. Queued: saved here, waiting for its host, which
 * answers it later. Refused: not applied, with the reason shown to the person.
 */
export type GroupWriteOutcome =
  | { status: 'applied' }
  | { status: 'queued'; waitingFor: string; since: string }
  | { status: 'refused'; reason: string };

/** The part of the group project's page a change shows its status in. */
export type GroupOperationSection = 'members' | 'details' | 'cleanup' | 'posts';

/**
 * One forwarded change and its outcome. `id` is the write's own id, the one the
 * host recognizes a replay by and a refusal is kept under: no other id is made.
 */
export interface GroupProjectOperation {
  id: string;
  groupProjectId: string;
  op: string;
  section: GroupOperationSection;
  author: { agentId?: string; label: string };
  /** When the change was made here. */
  since: string;
  /** When it was applied or refused. */
  settledAt?: string;
  outcome: GroupWriteOutcome;
}

/** A bounded read of a group project's changes waiting for, or recently answered by, its host. */
export interface GroupProjectOperations {
  operations: GroupProjectOperation[];
  /** Waiting changes beyond those listed. */
  omittedQueued: number;
}

/** One member recorded explicitly (helpers, quick agents, or a person's addition). */
export interface GroupProjectExplicitMember {
  /** Host-relative agent address: a bare id on the host machine, `id@<fingerprint>` elsewhere. */
  address: string;
  kind: 'durable' | 'helper' | 'quick';
  /** Host-maintained automatic membership from an explicitly linked project copy. */
  autoProject?: { machine: string; projectId: string };
  projectId?: string;
  projectName?: string;
  addedAt: string;
  runId?: string;
  /** Display only, never identity. */
  name?: string;
  [extra: string]: unknown;
}

export interface GroupProjectExclusion {
  address: string;
  name?: string;
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
  /** Absent on existing groups: preserves their previous policy and migration. */
  membershipPolicy?: 'project-3546';
  includeLinkedComputers?: boolean;
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
  /** A post made on a copy while its host is away: not on the board yet (#3363). */
  pending?: { waitingFor: string };
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
  own: { deliver: 'allow' | 'off'; wake: 'allow' | 'off'; actions: 'allow' | 'off' };
  holders: GroupProjectRoleHolderView[];
}

/** Who would auto-join a group project with a given scope, shown before creating it (#3357). */
export interface AutoJoinPreview {
  /** Which project copies the group would cover: the same read the directory shows (#3549). */
  coverage: GroupProjectCoverage;
  wouldJoin: ResolvedGroupProjectMember[];
  /** Projects in scope whose agents couldn't be read: their agents would join too once readable. */
  unreadableProjects: Array<{ projectId: string; name: string; reason?: string }>;
  /** Saved inventory only; excluded from wouldJoin until verified again. */
  lastSeen?: Array<ResolvedGroupProjectMember & { machineName: string }>;
}

/** One project copy a group project covers through an explicit project link (or the group's own project). */
export interface CoverageCopy {
  machine: string;
  projectId: string;
  /** "Atlas", or "Atlas on Laptop" for a copy on another computer. */
  name: string;
  thisComputer: boolean;
  /** Unknown when this computer can't verify the copy now (offline, snapshot incomplete): never "not covered". */
  state: 'verified' | 'unknown';
}

/**
 * Which project copies a group project covers, from explicit project links only.
 * A repository match never adds a copy: it is listed under `repositoryMatches`
 * so the person can be offered a link, and nothing else.
 */
export interface GroupProjectCoverage {
  groupProjectId: string;
  /** Only a project-scoped group covers project copies. */
  scoped: boolean;
  copies: CoverageCopy[];
  /** A copy of another computer's group: this computer's projects can't be ruled in or out right now. */
  localUnknown: boolean;
  /** True when every copy is verified and nothing about this computer's projects is unknown. */
  complete: boolean;
  /** This computer's projects with the group project's repository but no link. Offered a link, never covered. */
  repositoryMatches: Array<{ projectId: string; name: string }>;
}

/** What the directory shows about one group project's membership. */
export interface GroupProjectMembershipView {
  groupProjectId: string;
  /** False for a group project still held by canvas wires (not migrated yet). */
  managed: boolean;
  /** Why it isn't migrated yet, when a Canvas store couldn't be read. */
  deferred?: string;
  autoJoin: boolean;
  includeLinkedComputers?: boolean;
  /** Controls are host-only and available for project groups. */
  automaticMembership?: { scope: GroupProjectScope; projectName: string; editable: boolean };
  /** Lost links keep their auto members until this exact list is reviewed and confirmed. */
  coverageLeaving?: ResolvedGroupProjectMember[];
  members: ResolvedGroupProjectMember[];
  excluded: Array<{ agentId: string; name: string; excludedAt: string }>;
  /** Pending only on a migrated group project; `wouldJoin` lists who accepting adds. */
  autoJoinOffer?: { state: 'pending' | 'accepted' | 'dismissed'; wouldJoin: ResolvedGroupProjectMember[] };
}
