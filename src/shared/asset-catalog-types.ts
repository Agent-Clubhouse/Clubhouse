/**
 * The managed-composition asset catalog (#2737, with the composition model on
 * #2819): reusable MCP definitions, skill bundles, instruction blocks, native
 * subagent definitions and templates, kept once per installation, and each
 * agent's desired composition of them.
 *
 * Stable ids and immutable revisions. Revision history is linear. A template
 * revision is one published unit, and block revisions published with it carry
 * `bundledBy`. A recorded run names exact revisions. Everything here is
 * provider-neutral: projected destinations are logical keys, and turning them
 * into files or transport config belongs to activation (#2739).
 *
 * No user-facing strings, and "template" is only the working term. Issues and
 * errors carry codes and structured details, never payload values, so they can't
 * echo what a validator rejected. Instruction text never appears in a plan.
 */

import type { AgentAccessLevel, OrchestrationPolicyConfig } from './orchestration-policy';

export type AssetKind = 'mcp' | 'skill' | 'block' | 'subagent' | 'template';
/** What an instance adds or removes by id, following the latest approved revision. */
export type AddableAssetKind = 'mcp' | 'skill';
/** What a user may copy into something owned by one agent (#2819). */
export type CopyableAssetKind = 'skill' | 'block' | 'subagent';
/** What a publication may bundle with a template revision. */
export type BundledAssetKind = 'block' | 'subagent';

// ── Payloads: what a revision holds ──────────────────────────────────────

/** A package's own version. Separate from catalog revisions: a floating spec stays floating. */
export interface UpstreamPackage {
  package: string;
  version?: string;
}

export interface McpAssetPayload {
  /** The server key it projects to. Changing it takes a new revision; renaming the asset doesn't touch it. */
  serverKey: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  /** Literal, non-secret values only. */
  env?: Record<string, string>;
  /** Names the CLI forwards from its own environment: the runtime-owned reference for a secret (`McpServerDef.env_vars`). */
  envVars?: string[];
  /** Signs in through something outside the catalog. Says nothing about whether that sign-in works. */
  auth?: 'external';
  upstream?: UpstreamPackage;
}

export interface SkillFile {
  /** Relative to the bundle, with `/` separators. */
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  executable?: boolean;
}

export interface SkillAssetPayload {
  skillName: string;
  /** The complete bundle: `SKILL.md` and its supporting files. */
  files: SkillFile[];
}

/** Text only. A block's name or text grants no role, tool or access. A whole document is one block. */
export interface BlockAssetPayload {
  content: string;
}

/**
 * Agent access, helper policy and limits, cross-project helpers, Dispatcher
 * connection. Provider, model, effort, context window and routing stay in the
 * agent's launch settings and are rejected on a template.
 */
export interface TemplateOperationalDefaults extends OrchestrationPolicyConfig {
  agentAccess?: AgentAccessLevel;
}

/** One slot in a template's or subagent's ordered instructions: a stable id, and the block revision it refers to. */
export interface BlockRef {
  entryId: string;
  blockId: string;
  blockRevision: number;
}

/** One member of a template's native subagent set, which has no order. */
export interface SubagentRef {
  entryId: string;
  subagentId: string;
  subagentRevision: number;
}

export interface TemplateAssetPayload {
  /** The base order. Each entry id stays the same slot across revisions. */
  entries: BlockRef[];
  subagents: SubagentRef[];
  skills: string[];
  mcps: string[];
  operationalDefaults?: TemplateOperationalDefaults;
}

/**
 * A native subagent definition. It has no Clubhouse identity: no agent id, wires
 * or helper limit. `provider` is stored as given, by provider id, because which
 * fields a delivery path supports is activation's question and isn't verified
 * yet. A subagent's own `model` belongs there, a deliberate narrow exception to
 * what a template excludes. Secrets are refused, and fields that can raise
 * authority block for a person when planned.
 */
export interface SubagentAssetPayload {
  agentName: string;
  description: string;
  blocks: BlockRef[];
  skills: string[];
  mcps: string[];
  provider?: Record<string, Record<string, unknown>>;
}

export interface AssetPayloadByKind {
  mcp: McpAssetPayload;
  skill: SkillAssetPayload;
  block: BlockAssetPayload;
  subagent: SubagentAssetPayload;
  template: TemplateAssetPayload;
}

export type AssetPayload = AssetPayloadByKind[AssetKind];

// ── Catalog records ──────────────────────────────────────────────────────

/**
 * Who an asset belongs to. `project` is representable and not decided: which
 * project an agent is planned under is a parameter, and nothing here assigns a
 * project's blocks to its agents.
 */
export type AssetOwner = { kind: 'library' } | { kind: 'agent'; agentId: string } | { kind: 'project'; projectId: string };

export type AssetSource =
  | { kind: 'user' }
  | { kind: 'builtin'; builtinId: string }
  /** Ids and names, never a path. */
  | { kind: 'import'; from: 'native-mcp' | 'project-skill' | 'persona' | 'native-subagent'; projectId?: string; nativeName?: string }
  /** A user's copy: the origin revision it started from. Never merged, rebased or synced. */
  | { kind: 'copy'; originAssetId: string; originRevision: number };

/** What the planner needs from a revision, without reading its payload. Holds no file content, instruction text or env values. */
export type AssetProjection =
  | {
    kind: 'mcp';
    serverKey: string;
    transport: McpAssetPayload['transport'];
    envVars: string[];
    auth?: 'external';
    upstream?: UpstreamPackage & { floating: boolean };
  }
  | { kind: 'skill'; skillName: string; filePaths: string[] }
  | { kind: 'block'; bytes: number }
  | {
    kind: 'subagent';
    agentName: string;
    blocks: BlockRef[];
    skills: string[];
    mcps: string[];
    /** Provider ids it has a section for. */
    providers: string[];
    reviewFields: SubagentReviewField[];
    toolFields: SubagentToolField[];
  }
  | {
    kind: 'template';
    entries: BlockRef[];
    subagents: SubagentRef[];
    skills: string[];
    mcps: string[];
    operationalDefaults?: TemplateOperationalDefaults;
  };

/**
 * A tool list on a native subagent definition, for a person to see before it's
 * delivered. It doesn't block. It's only what the provider section declares, and
 * says nothing about what the definition can really reach. No list means none
 * declared, not none available.
 */
export interface SubagentToolField {
  /** Where it sits, such as `claude.tools`. */
  path: string;
  list: 'allow' | 'deny';
  names: string[];
  /** Of those, the ones that delegate further: `Agent`, with or without a scope, and `Task`. */
  delegation: string[];
  /** Of those, the ones naming Clubhouse's own MCP tools. */
  clubhouseMcp: string[];
  /** It held something that isn't a tool name, which is stored and not listed here. */
  hasUnlisted: boolean;
}

/**
 * A provider-section field a person has to look at before it's delivered:
 * `authority` can raise what the definition may do, and `unknown` isn't on the
 * short list of fields believed harmless. Blocks either way, until resolved.
 */
export interface SubagentReviewField {
  /** Where it sits, such as `claude.permissionMode`. Never its value. */
  path: string;
  reason: 'authority' | 'unknown';
}

/** Set once, at publication. Republishing a reference to an existing revision adds no tag. */
export interface BundledBy {
  templateId: string;
  templateRevision: number;
}

export interface AssetRevisionRecord {
  revision: number;
  savedAt: string;
  contentHash: string;
  projection: AssetProjection;
  bundledBy?: BundledBy;
}

export interface CatalogEntry {
  id: string;
  kind: AssetKind;
  name: string;
  owner: AssetOwner;
  source: AssetSource;
  createdAt: string;
  headRevision: number;
  /** Ascending. After a deletion, only the revisions something still refers to. */
  revisions: AssetRevisionRecord[];
  /** Set when deleted but kept for a receipt, a copy's origin or an instance. */
  deletedAt?: string;
}

// ── Instances ────────────────────────────────────────────────────────────

/** Binds to a revision that exists and to its content, so it can't be given ahead of time or outlive an edit. */
export interface AuthorityApproval {
  revision: number;
  contentHash: string;
}

export type InstanceEntrySource =
  /** A base entry takes its block from the template. A local entry following a shared block names it. */
  | { kind: 'follow'; blockId?: string }
  /** A copy this agent owns. A fork of a base entry keeps its slot and its `baseEntryId`. */
  | { kind: 'fork'; blockId: string; forkedFrom: { assetId: string; revision: number } }
  | { kind: 'local'; blockId: string };

/** Exactly one of `baseEntryId` and `localId`. */
export interface InstanceEntry {
  baseEntryId?: string;
  localId?: string;
  source: InstanceEntrySource;
}

export type InstanceSubagentSource =
  | { kind: 'follow'; subagentId?: string }
  | { kind: 'fork'; subagentId: string; forkedFrom: { assetId: string; revision: number } }
  | { kind: 'local'; subagentId: string };

/** Exactly one of `baseEntryId` and `localId`. A set: position means nothing. */
export interface InstanceSubagent {
  baseEntryId?: string;
  localId?: string;
  source: InstanceSubagentSource;
}

/**
 * An agent's desired composition. The agent id is the anchor: nothing here names
 * a session, wire, worktree or helper, and an asset never names any of them.
 * Custom order isn't stored: {@link PlannedStructure.customOrder} derives it.
 */
export interface CompositionInput {
  /** The template and the last revision of it this instance accepted. */
  template: { templateId: string; acceptedRevision: number } | null;
  /** The full order, base and local together. */
  entries: InstanceEntry[];
  /** A removal stays when the base later re-adds that id. */
  excludedEntryIds: string[];
  subagents: InstanceSubagent[];
  excludedSubagentEntryIds: string[];
  /** Skills and MCP definitions added explicitly. */
  additions: string[];
  /** Skills and MCP definitions the base carries that this agent excludes. */
  removals: string[];
  /** Explicit Apply, by asset id: the revision this instance chose. Raises a floor, never lowers one. */
  floors: Record<string, number>;
  /** Keep, by asset id: quiet about anything up to this revision. Changes nothing else. */
  keepMarkers: Record<string, number>;
  /** A person's resolution of a definition's review fields, by subagent asset id. */
  authorityApprovals: Record<string, AuthorityApproval>;
}

export interface AgentComposition extends CompositionInput {
  agentId: string;
  revision: number;
  updatedAt: string;
}

/** What one start used, and what was waiting. Its payloads stay readable until the record is released. */
export interface RunRecord {
  runId: string;
  agentId: string;
  recordedAt: string;
  planFingerprint: string;
  structure: ActivationPlan['structure'];
  /** The template first, then blocks in rendered order, then everything else. */
  revisions: Array<{ assetId: string; kind: AssetKind; revision: number }>;
}

export const ASSET_CATALOG_VERSION = 2;

export interface CatalogIndex {
  version: typeof ASSET_CATALOG_VERSION;
  assets: Record<string, CatalogEntry>;
  compositions: Record<string, AgentComposition>;
  runs: Record<string, RunRecord>;
}

// ── Structure checks ─────────────────────────────────────────────────────

export interface StructureBaseEntry {
  entryId: string;
  blockId: string;
  name: string;
}

export interface StructureInstanceEntry {
  /** `base:<id>` or `local:<id>`. */
  key: string;
  baseEntryId: string | null;
  /** Its block, and what it was forked from. */
  sources: string[];
  name: string;
  forked: boolean;
}

export interface StructureInput {
  /** A: the last accepted base order. */
  accepted: StructureBaseEntry[];
  /** B: the new base order. */
  target: StructureBaseEntry[];
  /** I: the instance's order. */
  instance: StructureInstanceEntry[];
  excluded: readonly string[];
}

export type StructureReasonCode =
  /** A pair changed between A and B and is also moved here, or something placed sits between. */
  | 'reorder_conflict'
  /** A new run's base neighbors aren't adjacent here. */
  | 'add_position'
  | 'removed_forked'
  | 'removed_moved'
  | 'removed_beside_local'
  /** A new entry shares a source or name with something already here. */
  | 'identity_conflict'
  /** Correction 1: a local or moved entry wouldn't keep its immediate neighbors. */
  | 'neighbors_changed'
  /** The merged result can't be shown to match the new base. */
  | 'order_unverified';

export interface StructureReason {
  code: StructureReasonCode;
  /** Entry keys. Consecutive new entries are one run, so one reason. */
  entries: string[];
}

export interface StructureCheck {
  clean: boolean;
  reasons: StructureReason[];
  /** The merged order if clean. Otherwise a suggestion for the preview, never applied without a choice. */
  order: string[];
  /** Excluded ids the new base re-adds. They stay excluded, with a notice. */
  reAddedExcluded: string[];
}

export interface SubagentSetEntry {
  entryId: string;
  name: string;
}

export interface InstanceSubagentSetEntry {
  key: string;
  baseEntryId: string | null;
  name: string;
  forked: boolean;
}

export interface SubagentSetInput {
  accepted: SubagentSetEntry[];
  target: SubagentSetEntry[];
  instance: InstanceSubagentSetEntry[];
  excluded: readonly string[];
  /** Names held by definitions outside the catalog. */
  foreignNames?: readonly string[];
  /** New or changed entries with review fields no person has resolved. */
  reviewEntries?: readonly string[];
}

export type SubagentSetReasonCode = 'name_collision' | 'foreign_name_collision' | 'removed_forked' | 'renamed_onto_existing' | 'review_fields';

export interface SubagentSetReason {
  code: SubagentSetReasonCode;
  entries: string[];
}

export interface SubagentSetCheck {
  clean: boolean;
  reasons: SubagentSetReason[];
  added: string[];
  removed: string[];
  reAddedExcluded: string[];
}

/**
 * A person's answer to a revision that needs a choice. The whole revision or
 * nothing: every entry has to be accounted for.
 */
export interface StructureChoice {
  /** Every entry that stays, in the order wanted, by key. */
  order: string[];
  /** New or existing base entries to exclude. */
  excludeBaseEntries?: string[];
  /** Entries the new base removed that stay. A followed one keeps following its block as a direct consumer. */
  keepRemoved?: string[];
  /** Forks the new base removed that go. A fork has to be kept or dropped by name, never by being left out. */
  dropRemoved?: string[];
  /** Local entries to drop. */
  dropLocal?: string[];
  subagents?: {
    excludeBaseEntries?: string[];
    keepRemoved?: string[];
    dropRemoved?: string[];
    dropLocal?: string[];
  };
  /** A person's resolution of what the new revision's subagents bring. */
  authorityApprovals?: Record<string, AuthorityApproval>;
}

/** Accepting a revision binds what the person was shown. If any of these moved, it's stale. */
export interface StructureBinding {
  fromFingerprint: string;
  toFingerprint: string;
  instanceFingerprint: string;
}

/**
 * Template switch is a replace: only what's selected carries over, and it carries
 * over as local. A person can also say now what they'd otherwise be blocked on.
 */
export interface TemplateSwitchSelection {
  entries?: string[];
  subagents?: string[];
  additions?: string[];
  removals?: string[];
  /** Entries of the new template to leave out, by id. */
  excludeEntries?: string[];
  /** Native subagents of the new template to leave out, by id. */
  excludeSubagents?: string[];
  /** Skills and MCP definitions of the new template to leave out, by asset id. */
  removeBaseAssets?: string[];
  authorityApprovals?: Record<string, AuthorityApproval>;
}

// ── Planner ──────────────────────────────────────────────────────────────

export type ContentAdoption =
  /** The highest revision each consumer can take. */
  | { mode: 'takeable' }
  /** Exactly these revisions of everything planned, such as a last run's. Refused if one's left out, below a floor or past a bundle. */
  | { mode: 'hold'; revisions: Readonly<Record<string, number>> };

export type StructureAdoption =
  /** The revision the instance accepted. */
  | { mode: 'accepted' }
  /** The latest revision if it's clean, otherwise the one accepted. Nothing is stored by planning. */
  | { mode: 'latest-if-clean' };

/**
 * How a linked instance's template resolves. Required on every plan, with no
 * default: when linked agents adopt a new revision is undecided (#2819). Content
 * and structure are separate tracks, so the caller says which it wants of each.
 */
export interface BaseAdoption {
  content: ContentAdoption;
  structure: StructureAdoption;
}

export interface ProjectedDestination {
  kind: 'mcp-server' | 'skill-directory' | 'instruction-document' | 'native-subagent';
  /** A logical key such as `mcp/workiq` or `skills/code-review`, not a path. */
  key: string;
}

/** Something that already owns a destination and isn't this catalog: a native file's entry, a plugin, Clubhouse. */
export interface ForeignDestination {
  key: string;
  owner: 'native' | 'plugin' | 'clubhouse';
}

export type PlannedSource =
  | { via: 'base'; templateId: string; templateRevision: number }
  | { via: 'addition' };

export interface OriginStatus {
  originAssetId: string;
  originRevision: number;
  /** Null when the origin has been deleted. */
  originHeadRevision: number | null;
  newerRevisionAvailable: boolean;
  originDeleted: boolean;
}

/** A skill or MCP definition, one destination each. */
export interface PlannedAsset {
  assetId: string;
  kind: AddableAssetKind;
  name: string;
  revision: number;
  headRevision: number;
  contentHash: string;
  owner: AssetOwner;
  source: AssetSource;
  /** Every reason it's here; references to one asset deduplicate and all stay listed. */
  provenance: PlannedSource[];
  destination: ProjectedDestination;
  projection: AssetProjection;
  origin?: OriginStatus;
}

/** Newer revisions a consumer hasn't got, and what it can do about them. */
export interface PlannedContentUpdate {
  /** The floor to the head: what a range diff would cover. */
  range: { from: number; to: number };
  /** The first bundle in the way. Null when nothing newer is held by one. */
  heldBy: BundledBy | null;
  /**
   * `accept-template`: arrives with accepting this instance's own template.
   * `explicit`: bundled for another template, or none: Apply, Fork or Keep.
   */
  resolution: 'accept-template' | 'explicit' | null;
  /** Assets published in that bundle which this consumer doesn't have. */
  missingCompanions: string[];
  /** Keep covers everything newer, so stay quiet. */
  kept: boolean;
}

export type PlannedEntrySource = 'follow' | 'fork' | 'local';

export interface PlannedBlock {
  /** `base:<id>` or `local:<id>`. */
  entryKey: string;
  source: PlannedEntrySource;
  assetId: string;
  name: string;
  revision: number;
  /** Follow only: the revision this consumer can't go below. */
  floor: number | null;
  takeableRevision: number;
  headRevision: number;
  contentHash: string;
  bytes: number;
  owner: AssetOwner;
  forkedFrom?: { assetId: string; revision: number };
  origin?: OriginStatus;
  /** Null when nothing newer exists than what this plan resolved. */
  update: PlannedContentUpdate | null;
}

/** Every block projects onto one instruction destination, in this order, and that's not a collision. */
export interface PlannedInstructions {
  destination: ProjectedDestination;
  blocks: PlannedBlock[];
  bytes: number;
}

export interface PlannedSubagent {
  entryKey: string;
  source: PlannedEntrySource;
  assetId: string;
  name: string;
  agentName: string;
  revision: number;
  floor: number | null;
  takeableRevision: number;
  headRevision: number;
  contentHash: string;
  owner: AssetOwner;
  destination: ProjectedDestination;
  blocks: Array<{ entryId: string; assetId: string; revision: number; contentHash: string; update: PlannedContentUpdate | null }>;
  skills: Array<{ assetId: string; revision: number; contentHash: string }>;
  mcps: Array<{ assetId: string; revision: number; contentHash: string }>;
  providers: string[];
  reviewFields: SubagentReviewField[];
  toolFields: SubagentToolField[];
  origin?: OriginStatus;
  update: PlannedContentUpdate | null;
}

export type PlanIssueCode =
  | 'asset_missing'
  | 'asset_deleted'
  | 'wrong_kind'
  | 'owner_mismatch'
  | 'revision_unavailable'
  | 'hold_incomplete'
  | 'hold_below_floor'
  | 'hold_past_bundle'
  | 'conflicting_revisions'
  | 'invalid_addition_kind'
  | 'invalid_removal_kind'
  | 'contradictory_override'
  | 'destination_collision'
  | 'foreign_destination_collision'
  | 'duplicate_source'
  | 'entry_missing_from_order'
  | 'entry_not_in_template'
  | 'excluded_entry_present'
  | 'fork_origin_mismatch'
  | 'missing_floor'
  | 'floor_bypasses_template'
  | 'instructions_too_large'
  | 'subagent_review_fields'
  | 'approval_unbound';

export type PlanNoticeCode =
  | 'inert_removal'
  | 'content_update_waiting'
  | 'structure_update_waiting'
  | 'origin_newer_revision'
  | 'origin_deleted'
  | 'excluded_entry_readded'
  | 'identical_text';

export interface PlanIssue<Code extends string = PlanIssueCode> {
  code: Code;
  assetIds: string[];
  entries?: string[];
  destination?: string;
  foreignOwner?: ForeignDestination['owner'];
  /** Where a field sits, such as `claude.hooks`. Never its value. */
  fields?: string[];
}

export interface PlannedStructureUpdate {
  /**
   * Relative to what's accepted. `clean` still isn't adopted until something
   * accepts it, or a `latest-if-clean` plan resolves it for this start.
   */
  status: 'current' | 'clean' | 'needs-choice';
  targetRevision: number;
  reasons: StructureReason[];
  subagentReasons: SubagentSetReason[];
  /** Blockers the new revision would bring, such as a skill colliding. */
  blockers: PlanIssue[];
}

export interface PlannedStructure {
  templateId: string;
  name: string;
  acceptedRevision: number;
  /** What this plan used. Differs from accepted only under `latest-if-clean`. */
  resolvedRevision: number;
  latestRevision: number;
  /** The order differs from the base, or it has local entries or exclusions. Derived, never stored. */
  customOrder: boolean;
  update: PlannedStructureUpdate;
}

export interface PlannedOperationalDefault {
  key: keyof TemplateOperationalDefaults;
  value: boolean | number | string;
  templateId: string;
  templateRevision: number;
}

export interface ActivationBlock {
  entryKey: string;
  source: PlannedEntrySource;
  assetId: string;
  revision: number;
  contentHash: string;
}

export interface ActivationAsset {
  assetId: string;
  kind: AddableAssetKind;
  revision: number;
  contentHash: string;
  destination: ProjectedDestination;
  /** MCP only: env names the runtime has to forward, and whether it signs in externally. */
  requires?: { envVars: string[]; auth?: 'external' };
}

export interface ActivationSubagent {
  entryKey: string;
  assetId: string;
  revision: number;
  contentHash: string;
  destination: ProjectedDestination;
  blocks: Array<{ assetId: string; revision: number; contentHash: string }>;
  skills: Array<{ assetId: string; revision: number; contentHash: string }>;
  mcps: Array<{ assetId: string; revision: number; contentHash: string }>;
}

/** What activation should deliver, independent of provider and transport. All of it or none: never partial. */
export interface ActivationPlan {
  agentId: string;
  compositionRevision: number;
  fingerprint: string;
  structure: {
    templateId: string;
    acceptedRevision: number;
    resolvedRevision: number;
    latestRevision: number;
    /** Never a claim that the whole base is adopted while this is true. */
    updateWaiting: boolean;
  } | null;
  /** Null when no instruction surface is adopted: the agent keeps what it has. */
  instructions: { destination: ProjectedDestination; blocks: ActivationBlock[] } | null;
  assets: ActivationAsset[];
  subagents: ActivationSubagent[];
  operationalDefaults: PlannedOperationalDefault[];
}

export interface CompositionPlan {
  agentId: string;
  compositionRevision: number;
  adoption: { content: ContentAdoption['mode']; structure: StructureAdoption['mode'] };
  structure: PlannedStructure | null;
  /** Null when no instruction surface is adopted. */
  instructions: PlannedInstructions | null;
  skills: PlannedAsset[];
  mcpServers: PlannedAsset[];
  subagents: PlannedSubagent[];
  /** What the base carries that this agent excludes. */
  excluded: Array<{ kind: 'block' | 'subagent' | AddableAssetKind; assetId: string; entryId?: string }>;
  operationalDefaults: PlannedOperationalDefault[];
  blockers: PlanIssue[];
  notices: PlanIssue<PlanNoticeCode>[];
  /** Null while anything blocks. */
  activation: ActivationPlan | null;
  /** Changes when anything this plan resolved changes, including order. Checked at commit. */
  fingerprint: string;
}

// ── Consumers and impact ─────────────────────────────────────────────────

export type ConsumerRelation =
  /** Through the agent's accepted template, in effect. */
  | 'via-base'
  /** The agent's template itself. */
  | 'base-template'
  | 'addition'
  /** A local entry following a shared block. */
  | 'direct'
  /** This asset is the fork or local block in one of its entries. */
  | 'own-entry'
  /** Through one of the agent's native subagents. */
  | 'via-subagent'
  /** The base carries it and this agent excluded it. */
  | 'excluded'
  /** The base's entry, forked by this agent. */
  | 'overridden';

export interface TemplateConsumer {
  templateId: string;
  role: 'block' | 'skill' | 'mcp' | 'subagent';
}

export interface AgentConsumer {
  agentId: string;
  relations: ConsumerRelation[];
  /** False when every relation is an exclusion or override: an edit doesn't reach this agent. */
  effective: boolean;
}

export interface CopyConsumer {
  assetId: string;
  owner: AssetOwner;
  originRevision: number;
}

export interface AssetConsumers {
  assetId: string;
  /** Templates at their latest revision. */
  templates: TemplateConsumer[];
  /** Subagent definitions at their latest revision. */
  subagents: string[];
  agents: AgentConsumer[];
  /** Copies made from it. They don't change when it does. */
  copies: CopyConsumer[];
}

export interface PlannedAssetChange {
  assetId: string;
  fromRevision: number | null;
  toRevision: number | null;
  destination: string;
}

export interface ImpactedAgent extends AgentConsumer {
  changes: PlannedAssetChange[];
  /** Blockers this edit would cause. */
  newBlockers: PlanIssue[];
  /** Where this agent's composition would project afterwards. */
  destinations: string[];
  /** Assets with something newer this consumer won't get without acting. */
  held: string[];
  /** Where it stands against its template's latest revision afterwards. */
  structure: PlannedStructureUpdate | null;
}

export interface SharedDestination {
  workspaceKey: string;
  destination: string;
  agents: Array<{ agentId: string; assetId: string; revision: number }>;
  /** Agents sharing this workspace would need different content at one destination. */
  divergent: boolean;
}

export interface ImpactContext {
  /**
   * Which agents share a directory, as opaque keys. A parameter because the
   * catalog never stores anything about a worktree. An agent left out is treated
   * as sharing with nobody.
   */
  workspaceByAgent?: Readonly<Record<string, string>>;
  foreignByAgent?: Readonly<Record<string, readonly ForeignDestination[]>>;
}

export interface AssetImpact {
  assetId: string;
  fromRevision: number;
  toRevision: number;
  templates: TemplateConsumer[];
  subagents: string[];
  agents: ImpactedAgent[];
  copies: CopyConsumer[];
  sharedDestinations: SharedDestination[];
  /** A consumer would newly block, or agents sharing a workspace would newly diverge. */
  blocked: boolean;
  /** Pass back with the save. A save whose consumers have since changed fails as stale. */
  fingerprint: string;
}

// ── Errors, validation ───────────────────────────────────────────────────

export type ValidationCode =
  | 'invalid_shape'
  | 'unknown_field'
  | 'forbidden_template_field'
  | 'no_instruction_entries'
  | 'nested_template'
  | 'duplicate_reference'
  | 'invalid_operational_default'
  | 'invalid_name'
  | 'invalid_identifier'
  | 'invalid_revision'
  | 'reserved_namespace'
  | 'invalid_transport_fields'
  | 'invalid_url'
  | 'invalid_skill_path'
  | 'duplicate_skill_path'
  | 'missing_skill_entrypoint'
  | 'too_large'
  | 'invalid_encoding'
  | 'secret_value'
  | 'credential_file'
  | 'launch_settings_in_instruction'
  | 'unsupported_native_field'
  | 'invalid_entry'
  | 'invalid_choice'
  | 'unreferenced_bundle_write'
  | 'duplicate_subagent_name';

export interface ValidationIssue {
  code: ValidationCode;
  /** Where it is, such as `env.GITHUB_TOKEN` or `files[2].path`. Never the value. */
  path: string;
}

export type AssetCatalogErrorCode =
  | 'invalid_payload'
  | 'invalid_composition'
  | 'invalid_reference'
  | 'invalid_publication'
  | 'invalid_choice'
  | 'asset_missing'
  | 'asset_deleted'
  | 'asset_in_use'
  | 'asset_exists'
  | 'not_copyable'
  | 'stale_revision'
  | 'stale_name'
  | 'stale_preview'
  | 'stale_choice'
  | 'impact_confirmation_required'
  | 'consumer_conflict'
  | 'composition_blocked'
  | 'structure_needs_choice'
  | 'structure_change_requires_acceptance'
  | 'revision_unavailable'
  | 'payload_corrupt'
  | 'catalog_corrupt'
  | 'catalog_version_unsupported'
  | 'run_exists'
  | 'run_missing'
  | 'plan_blocked'
  | 'builtin_read_only'
  | 'adoption_policy_required'
  | 'agent_not_permitted';

/** A redacted, safe-to-show description of a revision. For an authorized local UI, including its diffs. */
export type AssetPreview =
  | {
    kind: 'mcp';
    serverKey: string;
    transport: McpAssetPayload['transport'];
    command?: string;
    args?: string[];
    url?: string;
    /** Names only. */
    envNames: string[];
    envVars: string[];
    auth?: 'external';
    upstream?: UpstreamPackage;
  }
  | { kind: 'skill'; skillName: string; files: Array<{ path: string; bytes: number; text?: string }> }
  | { kind: 'block'; text: string }
  | {
    kind: 'subagent';
    agentName: string;
    description: string;
    blocks: BlockRef[];
    skills: string[];
    mcps: string[];
    /** Field names by provider. Tool names are the only values shown, in `toolFields`. */
    providerFields: Record<string, string[]>;
    toolFields: SubagentToolField[];
  }
  | ({ kind: 'template' } & TemplateAssetPayload);

/** What an agent may be told about an asset. */
export interface AssetAgentMetadata {
  id: string;
  kind: AssetKind;
  name: string;
  headRevision: number;
  ownerKind: AssetOwner['kind'];
  sourceKind: AssetSource['kind'];
}
