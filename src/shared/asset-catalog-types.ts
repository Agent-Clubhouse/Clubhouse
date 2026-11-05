/**
 * The managed-composition asset catalog (#2737): reusable MCP definitions, skill
 * bundles, instruction documents and Agent Presets, kept once per installation,
 * and each agent's desired composition of them.
 *
 * Stable ids and immutable revisions. A reference names an asset id and follows
 * its latest approved revision; a recorded run names exact revisions. Everything
 * here is provider-neutral: projected destinations are logical keys, and turning
 * them into files or transport config belongs to activation (#2739).
 *
 * No user-facing strings. Issues and errors carry codes and structured details,
 * never payload values, so they can't echo what a validator rejected.
 */

import type { AgentAccessLevel, OrchestrationPolicyConfig } from './orchestration-policy';

export type AssetKind = 'mcp' | 'skill' | 'instruction' | 'preset';
export type ComposableAssetKind = Exclude<AssetKind, 'preset'>;

/** The kinds a user may copy into a document owned by one agent (#2819). */
export type CopyableAssetKind = 'skill' | 'instruction';

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

export interface InstructionAssetPayload {
  content: string;
}

/**
 * Agent access, helper policy and limits, cross-project helpers, Dispatcher
 * connection. Provider, model, effort, context window and routing stay in the
 * agent's launch settings and are rejected here.
 */
export interface PresetOperationalDefaults extends OrchestrationPolicyConfig {
  agentAccess?: AgentAccessLevel;
}

export interface AgentPresetPayload {
  /** Exactly one complete instruction document. */
  instruction: string;
  skills: string[];
  mcps: string[];
  operationalDefaults?: PresetOperationalDefaults;
}

export interface AssetPayloadByKind {
  mcp: McpAssetPayload;
  skill: SkillAssetPayload;
  instruction: InstructionAssetPayload;
  preset: AgentPresetPayload;
}

export type AssetPayload = AssetPayloadByKind[AssetKind];

// ── Catalog records ──────────────────────────────────────────────────────

export type AssetOwner = { kind: 'library' } | { kind: 'agent'; agentId: string };

export type AssetSource =
  | { kind: 'user' }
  | { kind: 'builtin'; builtinId: string }
  /** Ids and names, never a path. */
  | { kind: 'import'; from: 'native-mcp' | 'project-skill' | 'persona'; projectId?: string; nativeName?: string }
  /** A user's copy: the origin revision it started from. Never merged, rebased or synced. */
  | { kind: 'copy'; originAssetId: string; originRevision: number };

/** What the planner needs from a revision, without reading its payload. Holds no file content or env values. */
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
  | { kind: 'instruction' }
  | {
    kind: 'preset';
    instruction: string;
    skills: string[];
    mcps: string[];
    operationalDefaults?: PresetOperationalDefaults;
  };

export interface AssetRevisionRecord {
  revision: number;
  savedAt: string;
  contentHash: string;
  projection: AssetProjection;
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
  /** Set when deleted but kept for a recorded run or a copy's origin. */
  deletedAt?: string;
}

/**
 * An agent's desired composition. The agent id is the anchor: nothing here names
 * a session, wire, worktree or helper, and an asset never names any of them.
 */
export interface CompositionInput {
  basePresetId: string | null;
  /** Skills and MCP definitions added explicitly. */
  additions: string[];
  /** Skills and MCP definitions the base carries that this agent excludes. */
  removals: string[];
  /** Replaces the base's instruction document whole. */
  instructionAssetId: string | null;
}

export interface AgentComposition extends CompositionInput {
  agentId: string;
  revision: number;
  updatedAt: string;
}

/** The exact revisions a run started with. Their payloads stay readable until the record is released. */
export interface RunRecord {
  runId: string;
  agentId: string;
  recordedAt: string;
  planFingerprint: string;
  revisions: Array<{ assetId: string; kind: AssetKind; revision: number }>;
}

export const ASSET_CATALOG_VERSION = 1;

export interface CatalogIndex {
  version: typeof ASSET_CATALOG_VERSION;
  assets: Record<string, CatalogEntry>;
  compositions: Record<string, AgentComposition>;
  runs: Record<string, RunRecord>;
}

// ── Planner ──────────────────────────────────────────────────────────────

/**
 * How a linked agent's base resolves. Required on every plan, with no default:
 * when linked agents adopt a new base revision is undecided (#2819), so the
 * caller says which of these it wants.
 *
 * - `latest`: the base's latest approved content.
 * - `hold`: exactly these revisions of the preset and what it refers to, such as
 *   those of the agent's last run. What's newer is reported and not applied.
 */
export type BaseAdoption =
  | { mode: 'latest' }
  | { mode: 'hold'; revisions: Readonly<Record<string, number>> };

export interface ProjectedDestination {
  kind: 'mcp-server' | 'skill-directory' | 'instruction-document';
  /** A logical key such as `mcp/workiq` or `skills/code-review`, not a path. */
  key: string;
}

/** Something that already owns a destination and isn't this catalog: a native file's entry, a plugin, Clubhouse. */
export interface ForeignDestination {
  key: string;
  owner: 'native' | 'plugin' | 'clubhouse';
}

export type PlannedSource =
  | { via: 'base'; presetId: string; presetRevision: number }
  | { via: 'addition' }
  | { via: 'instruction-replacement' };

export interface OriginStatus {
  originAssetId: string;
  originRevision: number;
  /** Null when the origin has been deleted. */
  originHeadRevision: number | null;
  newerRevisionAvailable: boolean;
  originDeleted: boolean;
}

export interface PlannedAsset {
  assetId: string;
  kind: ComposableAssetKind;
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

export type PlanIssueCode =
  | 'asset_missing'
  | 'asset_deleted'
  | 'wrong_kind'
  | 'owner_mismatch'
  | 'revision_unavailable'
  | 'hold_incomplete'
  | 'conflicting_revisions'
  | 'invalid_addition_kind'
  | 'invalid_removal_kind'
  | 'contradictory_override'
  | 'destination_collision'
  | 'foreign_destination_collision';

export type PlanNoticeCode =
  | 'inert_removal'
  | 'base_revision_available'
  | 'origin_newer_revision'
  | 'origin_deleted';

export interface PlanIssue<Code extends string = PlanIssueCode> {
  code: Code;
  assetIds: string[];
  destination?: string;
  foreignOwner?: ForeignDestination['owner'];
}

export interface BaseRevisionUpdate {
  assetId: string;
  kind: AssetKind;
  resolvedRevision: number;
  headRevision: number;
}

export interface PlannedBase {
  presetId: string;
  name: string;
  revision: number;
  headRevision: number;
  /** What's newer than what this plan resolved. Reported, never applied. */
  updates: BaseRevisionUpdate[];
}

export interface PlannedOperationalDefault {
  key: keyof PresetOperationalDefaults;
  value: boolean | number | string;
  presetId: string;
  presetRevision: number;
}

export interface ActivationAsset {
  assetId: string;
  kind: ComposableAssetKind;
  revision: number;
  contentHash: string;
  destination: ProjectedDestination;
  /** MCP only: env names the runtime has to forward, and whether it signs in externally. */
  requires?: { envVars: string[]; auth?: 'external' };
}

/** What activation should deliver, independent of provider and transport. All of it or none: never partial. */
export interface ActivationPlan {
  agentId: string;
  compositionRevision: number;
  fingerprint: string;
  base: { presetId: string; revision: number } | null;
  assets: ActivationAsset[];
  operationalDefaults: PlannedOperationalDefault[];
}

export interface CompositionPlan {
  agentId: string;
  compositionRevision: number;
  adoptionMode: BaseAdoption['mode'];
  base: PlannedBase | null;
  /** Null when no instruction surface is adopted: the agent keeps what it has. */
  instruction: PlannedAsset | null;
  /** The base's instruction when this agent deliberately replaced it. */
  replacedInstruction: { assetId: string; revision: number } | null;
  skills: PlannedAsset[];
  mcpServers: PlannedAsset[];
  /** Assets the base carries that this agent excludes. */
  excluded: Array<{ assetId: string; kind: ComposableAssetKind; presetId: string }>;
  operationalDefaults: PlannedOperationalDefault[];
  blockers: PlanIssue[];
  notices: PlanIssue<PlanNoticeCode>[];
  /** Null while anything blocks. */
  activation: ActivationPlan | null;
  /** Changes when anything this plan resolved changes. Checked at commit: a preview that's gone stale fails. */
  fingerprint: string;
}

// ── Consumers and impact ─────────────────────────────────────────────────

export type ConsumerRelation =
  /** Through the agent's base, in effect. */
  | 'via-base'
  /** The agent's base itself. */
  | 'base-preset'
  | 'addition'
  | 'instruction-replacement'
  /** The base carries it and this agent removed it. */
  | 'excluded'
  /** The base's instruction, replaced by this agent with another. */
  | 'overridden';

export interface PresetConsumer {
  presetId: string;
  role: 'instruction' | 'skill' | 'mcp';
}

export interface AgentConsumer {
  agentId: string;
  relations: ConsumerRelation[];
  /** False when every relation is an exclusion or override: an edit doesn't reach this agent. */
  effective: boolean;
}

export interface CopyConsumer {
  assetId: string;
  agentId: string;
  originRevision: number;
}

export interface AssetConsumers {
  assetId: string;
  presets: PresetConsumer[];
  agents: AgentConsumer[];
  /** Agent-owned copies made from it. They don't change when it does. */
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
  presets: PresetConsumer[];
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
  | 'forbidden_preset_field'
  | 'invalid_instruction_cardinality'
  | 'nested_preset'
  | 'duplicate_reference'
  | 'invalid_operational_default'
  | 'invalid_name'
  | 'invalid_identifier'
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
  | 'unsupported_native_field';

export interface ValidationIssue {
  code: ValidationCode;
  /** Where it is, such as `env.GITHUB_TOKEN` or `files[2].path`. Never the value. */
  path: string;
}

export type AssetCatalogErrorCode =
  | 'invalid_payload'
  | 'invalid_composition'
  | 'invalid_reference'
  | 'asset_missing'
  | 'asset_deleted'
  | 'asset_in_use'
  | 'not_copyable'
  | 'stale_revision'
  | 'stale_name'
  | 'stale_preview'
  | 'impact_confirmation_required'
  | 'consumer_conflict'
  | 'composition_blocked'
  | 'revision_unavailable'
  | 'payload_corrupt'
  | 'catalog_corrupt'
  | 'catalog_version_unsupported'
  | 'run_exists'
  | 'run_missing'
  | 'plan_blocked'
  | 'adoption_policy_required'
  | 'agent_not_permitted';

/** A redacted, safe-to-show description of a revision. */
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
  | { kind: 'instruction'; text: string }
  | ({ kind: 'preset' } & AgentPresetPayload);

/** What an agent may be told about an asset. */
export interface AssetAgentMetadata {
  id: string;
  kind: AssetKind;
  name: string;
  headRevision: number;
  ownerKind: AssetOwner['kind'];
  sourceKind: AssetSource['kind'];
}
