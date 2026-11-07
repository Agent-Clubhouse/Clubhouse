/**
 * Clubhouse-managed agents (#2819). A managed agent is built from agent parts
 * (instruction blocks, skills, MCP servers) kept once in the agent part
 * library and used by reference, plus ordinary agent settings. Clubhouse
 * delivers the result into the agent's own folder when each session starts.
 *
 * Parts are asset catalog entries (src/main/services/asset-catalog). Templates
 * are unlinked starting points: an agent remembers which one it came from, so
 * a template edit can be pushed to the agents a person ticks.
 */
import type { OrchestratorId } from './types';
import type { OrchestrationPolicyConfig } from './orchestration-policy';

export type ManagedPartKind = 'block' | 'skill' | 'mcp';

/** What a managed agent is built from, by catalog asset id. Settings live on the agent config itself. */
export interface ManagedAgentSetup {
  version: 1;
  /** Instruction blocks in the order the agent reads them. */
  blocks: string[];
  skills: string[];
  mcps: string[];
  /** The template the agent was made from, for display and for pushing template edits. Not a live link. */
  templateId?: string;
}

/** The built-in Clubhouse MCP part. Present in a setup means the Clubhouse MCP bridge is on for the agent. */
export const CLUBHOUSE_MCP_PART_ID = 'builtin-mcp-clubhouse';

export interface ManagedPartSummary {
  id: string;
  kind: ManagedPartKind;
  name: string;
  description: string;
  builtin: boolean;
  revision: number;
  updatedAt: string;
  /** Who last changed it, when not the person: for example "Dispatcher". */
  updatedBy?: string;
  /** For a fork: the part it was copied from, when that part still exists. */
  forkedFrom?: string;
  /** Agents that use this part, across every registered project. */
  usedBy: ManagedPartConsumer[];
  /** Templates that list this part. */
  templates: Array<{ id: string; name: string }>;
  /** A short one-line preview of the content (block text, skill file list, MCP command). */
  preview: string;
  /**
   * MCP only: env names that were stored with literal values. Clubhouse no
   * longer uses the values, so each must be set in the person's environment (D46).
   */
  droppedEnvValues?: string[];
}

export interface ManagedPartConsumer {
  projectPath: string;
  projectName: string;
  agentId: string;
  agentName: string;
  color: string;
  running: boolean;
}

export interface ManagedBlockContent { kind: 'block'; content: string }
export interface ManagedSkillContent {
  kind: 'skill';
  skillName: string;
  files: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64'; executable?: boolean }>;
}
export interface ManagedMcpContent {
  kind: 'mcp';
  serverKey: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  /** Names of variables forwarded from the signed-in environment. Never values. */
  envVars?: string[];
  /** Literal, non-secret values (the catalog refuses secret-looking ones). */
  env?: Record<string, string>;
}
export type ManagedPartContent = ManagedBlockContent | ManagedSkillContent | ManagedMcpContent;

export interface ManagedPart extends ManagedPartSummary {
  content: ManagedPartContent;
}

/** Settings a template carries besides its parts. Unset means "leave as the person chose". */
export interface ManagedTemplateSettings {
  orchestrator?: OrchestratorId;
  model?: string;
  freeAgentMode?: boolean;
  orchestration?: OrchestrationPolicyConfig;
}

export interface ManagedTemplate {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  setup: Omit<ManagedAgentSetup, 'version' | 'templateId'>;
  settings: ManagedTemplateSettings;
  updatedAt?: string;
}

/** One difference between a template's saved version and an edit, for the push dialog. */
export type ManagedTemplateChange =
  | { kind: 'add'; part: ManagedPartKind; id: string; name: string }
  | { kind: 'remove'; part: ManagedPartKind; id: string; name: string }
  | { kind: 'order' }
  | { kind: 'setting'; key: string; from: string; to: string };

export interface ManagedTemplatePushTarget {
  projectPath: string;
  agentId: string;
  agentName: string;
  color: string;
  running: boolean;
  /** How many of the template's changes still apply to this agent. */
  applicable: number;
  total: number;
  /** Why some don't apply, e.g. "already has no Playwright". */
  note?: string;
}

/** What an agent used before Clubhouse switched it to managed on its own (D59). */
export type ManagedMigrationFrom = 'clubhouse-mode' | 'persona';

/**
 * Kept on the agent once Clubhouse has switched it to managed on its own
 * (D59). It stays after the notice is dismissed, so the agent is never
 * switched automatically again, for example after Stop managing.
 */
export interface ManagedMigration {
  /** When it was switched (ISO time). */
  at: string;
  from: ManagedMigrationFrom;
  /** Where its earlier instructions file is kept, shortened to start at `~` when under the home folder. */
  backup: string;
  /** The person dismissed the notice. */
  dismissed?: true;
}

/** The last automatic switch to managed failed (D59). Cleared by any switch. */
export interface ManagedMigrationFailure {
  at: string;
  /** An error code only, as the log has it. */
  code: string;
  /** The reason, in words, for the switch offer. */
  message: string;
}

/** What a running managed agent is waiting on. */
export interface ManagedAgentStatus {
  managed: boolean;
  running: boolean;
  /** True when the setup changed after the running session started. */
  waiting: boolean;
  /** Human-readable summary of what changed, e.g. "Coding standards was edited". */
  changes: string[];
  deliveredAt?: string;
  /** True when the CLI changed since the session started, so a restart can't resume it. */
  cliChanged: boolean;
  /** Set when this session's setup couldn't be written: the reason. The session runs on whatever files were there. */
  deliveryFailed?: string;
  /** A managed agent Clubhouse switched on its own, until the notice is dismissed (D59). */
  migrated?: { from: ManagedMigrationFrom; backup: string };
  /** An unmanaged agent whose automatic switch failed: the reason (D59). */
  migrationFailed?: string;
}

/** The exact result an agent gets at its next start. */
export interface ManagedPreview {
  instructions: string;
  blocks: Array<{ id: string; name: string; builtin: boolean; usedBy: number; startLine: number; endLine: number }>;
  skills: Array<{ id: string; name: string; skillName: string; files: number; folder: string }>;
  /** `droppedEnvValues`: env names stored with literal values, which must now come from the environment (D46). */
  mcps: Array<{ id: string; name: string; serverKey: string; builtin: boolean; droppedEnvValues?: string[] }>;
  missing: string[];
  /** Skill folders git tracks in the agent's folder. Clubhouse can't move them, so the CLI loads them too. */
  repoSkills?: string[];
  /**
   * Other skill folders Clubhouse left in place because moving them wasn't
   * safe: the skills folder is a link (`link`), or git couldn't say what it
   * tracks (`git`). The CLI loads them too (D48).
   */
  keptSkills?: string[];
  keptSkillsReason?: 'link' | 'git';
  /** Instruction files above the agent's folder that the CLI is told not to read. */
  notRead?: string[];
  /** Instruction files the CLI reads besides the setup, which Clubhouse can't turn off. */
  alsoRead?: string[];
  /** The CLI's name, for "Also read by …". */
  cliName?: string;
}

/**
 * What "Keep what it has now" makes of an agent's files when it switches to
 * managed (#2893), by name, before anything is written. `notes` says what
 * can't be brought over and why, so nothing is dropped silently.
 */
export interface ManagedConvertPreview {
  blocks: string[];
  skills: string[];
  mcps: string[];
  notes: string[];
}

export type ManagedErrorCode =
  | 'not_found'
  | 'stale'
  | 'invalid'
  | 'builtin_read_only'
  | 'in_use'
  | 'not_managed'
  | 'not_permitted'
  | 'name_taken'
  | 'failed';

export type ManagedResult<T> = { ok: true; value: T } | { ok: false; code: ManagedErrorCode; message?: string };
