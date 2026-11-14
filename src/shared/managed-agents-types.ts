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
  /**
   * A helper only: the parts start_helper added to or left out of its
   * template, for Details ("Helper template, plus Playwright, minus
   * code-review"). Dropped once the setup's parts change (D91).
   */
  helperChanges?: ManagedHelperChanges;
  /** Who last changed the setup, when not the person: for example "Dispatcher" (D90). */
  updatedBy?: string;
  /** When the setup was last saved (ISO time). */
  updatedAt?: string;
}

/** What start_helper changed from a helper's template, by part id. */
export interface ManagedHelperChanges {
  added: string[];
  removed: string[];
}

/**
 * The built-in Clubhouse MCP part. It is in every managed setup and template
 * and can't be removed: the Clubhouse MCP always runs, for every agent.
 */
export const CLUBHOUSE_MCP_PART_ID = 'builtin-mcp-clubhouse';

/**
 * The built-in prepare-handoff skill (#3344). Never chosen in a setup: an agent
 * gets it while it holds handoff.offer, and never without it.
 */
export const PREPARE_HANDOFF_SKILL_ID = 'builtin-skill-prepare-handoff';

/** The built-in Identity block a durable agent gets, and the working one a helper or quick agent gets in its place (#2902). */
export const IDENTITY_BLOCK_ID = 'builtin-block-identity';
export const WORKING_IDENTITY_BLOCK_ID = 'builtin-block-identity-helper';

/** Blocks as a helper or quick agent gets them: the working Identity in place of the durable one, once, where it came first. */
export function workingIdentityBlocks(blocks: string[]): string[] {
  if (!blocks.includes(IDENTITY_BLOCK_ID)) return blocks;
  const mapped = blocks.map((id) => (id === IDENTITY_BLOCK_ID ? WORKING_IDENTITY_BLOCK_ID : id));
  return mapped.filter((id, i) => id !== WORKING_IDENTITY_BLOCK_ID || mapped.indexOf(id) === i);
}

/**
 * Whether a part or template is offered for new choices: everything but
 * retired built-ins and prepare-handoff, which follows the agent's
 * handoff.offer permission and is never chosen (#3344).
 */
export function isListed(item: { retired?: boolean; id?: string }): boolean {
  return !item.retired && item.id !== PREPARE_HANDOFF_SKILL_ID;
}

/** What the builder's MCP page says beside the Clubhouse part's disabled switch. */
export const CLUBHOUSE_PART_NOTE = 'Always on. Clubhouse uses it for status, helpers, messages and the Dispatcher.';

/** Why a request to remove or copy the Clubhouse part changes nothing. */
export const CLUBHOUSE_PART_ALWAYS_ON = 'The Clubhouse MCP part is always on, so it stays in every setup.';

export interface ManagedPartSummary {
  id: string;
  kind: ManagedPartKind;
  name: string;
  description: string;
  builtin: boolean;
  /**
   * A retired built-in (#2902) that couldn't become a copy yet, because some
   * project's agents couldn't be read (D99): still installed and delivered,
   * hidden from the library and from new choices.
   */
  retired?: true;
  /** The person's copy of a built-in an app update retired (D99): visible and editable like any custom part. */
  fromRetiredBuiltin?: true;
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
  /** Skills only: the folder it installs to (its SKILL.md front matter name). */
  skillName?: string;
  /**
   * MCP only: env names that were stored with literal values. Clubhouse no
   * longer uses the values, so each must be set in the person's environment (D46).
   */
  droppedEnvValues?: string[];
  /**
   * Added from a project's repository (`.clubhouse/parts/`): which project, and
   * its name while it's registered. The repository's copy never updates it by itself.
   */
  project?: { projectId: string; projectName?: string };
}

/** Why two skills can't share a setup: they install to one folder. Builder, setup checks and templates all say this. */
export function skillFolderClashMessage(a: string, b: string, folder: string): string {
  return `${a} and ${b} both install to ${folder}/. Pick one.`;
}

/** The first pair of skills that install to the same folder (compared without case), or null. */
export function findSkillFolderClash(skills: ReadonlyArray<{ name: string; skillName: string }>): { a: string; b: string; folder: string } | null {
  const seen = new Map<string, string>();
  for (const s of skills) {
    const key = s.skillName.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) return { a: other, b: s.name, folder: s.skillName };
    seen.set(key, s.name);
  }
  return null;
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

/**
 * Settings a template carries besides its parts. Unset means "leave as the
 * person chose". Each is an ordinary agent setting, stored where it always is.
 * `null` is only for applying: it puts that setting back to its default
 * (the CLI's effort, the app's auto-sleep, the app's default helper template).
 * Saved templates never keep a `null`.
 */
export interface ManagedTemplateSettings {
  orchestrator?: OrchestratorId;
  model?: string;
  /** The reasoning effort level, for the model these settings run (the agent's `effort`). */
  effort?: string | null;
  /** Access (#2761): the level agents made from it start at. */
  access?: import('./agent-access').AccessLevel;
  /** Legacy Free Agent Mode, derived from `access` and still written for a rollback. Read only when `access` is missing. */
  freeAgentMode?: boolean;
  orchestration?: OrchestrationPolicyConfig;
  /** Auto-sleep: minutes idle before a chat session sleeps, or `never` (the agent's `idleSleep`). */
  idleSleep?: 'never' | number | null;
  /** The template this agent's helpers start from when start_helper names none (the agent's `helperTemplateId`). */
  helperTemplateId?: string | null;
  /**
   * Clubhouse permissions agents made from it get over the defaults (#2971),
   * each Off, Ask first or Allow. Only the user sets them: the Clubhouse MCP
   * refuses them. A null mode (in a push only) takes one away.
   */
  grants?: import('./agent-grant-changes').TemplateGrant[];
}

/** One line of Preview's settings summary, e.g. `{ key: 'model', label: 'Model', value: 'opus' }`. */
export interface ManagedSettingsRow {
  key: string;
  label: string;
  value: string;
}

/**
 * What a running managed agent's current session started with (D9), kept in
 * memory from its delivery so Preview can show "Running now" beside the next start.
 */
export interface ManagedRunningSnapshot {
  deliveredAt: string;
  instructions: string;
  /** The same text with wildcards as written. */
  rawInstructions: string;
  skills: string[];
  mcps: string[];
  settings: ManagedSettingsRow[];
  /** What differs from the next start, in words, as the setup-changed bar says it. */
  changes: string[];
}

export interface ManagedTemplate {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /**
   * A retired built-in template (#2902). Since D99 it is never listed or
   * read: whatever used it switches to a custom copy.
   */
  retired?: true;
  /** A custom copy of a built-in template an app update retired: the built-in's id (D99). */
  fromRetiredBuiltin?: string;
  setup: Omit<ManagedAgentSetup, 'version' | 'templateId'>;
  settings: ManagedTemplateSettings;
  updatedAt?: string;
  /** Who last changed it, when not the person: for example "Dispatcher" (D90). */
  updatedBy?: string;
  /**
   * Added from a project's repository (`.clubhouse/parts/templates/`, D255):
   * the project and the template's own `id` there. Set only when a person adds
   * one; an edit or a push keeps it.
   */
  source?: { kind: 'project'; projectId: string; key: string };
  /** The repository copy's hash when it was added or last updated from it. */
  projectHash?: string;
  /** A repository copy the person chose not to take (Keep mine). */
  projectKeptHash?: string;
  /** For a project template in a list: its project's name while it's registered. */
  projectName?: string;
}

/** One difference between a template's saved version and an edit, for the push dialog. */
export type ManagedTemplateChange =
  | { kind: 'add'; part: ManagedPartKind; id: string; name: string }
  | { kind: 'remove'; part: ManagedPartKind; id: string; name: string }
  | { kind: 'order' }
  /**
   * `followsModel`: not an edit of the effort, but what a pushed model or CLI
   * change does to it (D81): the template's effort goes with the new model,
   * or the effort goes back to the CLI default.
   */
  | { kind: 'setting'; key: string; from: string; to: string; followsModel?: true; label?: string };

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
  /**
   * A running agent's MCP servers that can't start because variables they
   * need aren't set in the environment its session started with. Names only,
   * never values (D95).
   */
  mcpProblems?: ManagedMcpProblem[];
}

/** An MCP server of this session that can't start, and why, in names only. */
export interface ManagedMcpProblem {
  /** The server key, as the CLI and the MCP servers card name it. */
  server: string;
  /** Variable names it needs that the session's environment doesn't have. */
  missingEnv: string[];
}

/** The exact result an agent gets at its next start. */
export interface ManagedPreview {
  instructions: string;
  /** The same text with wildcards as written, for "Show wildcards". */
  rawInstructions?: string;
  /** CLI, model, effort, Access, orchestration and helpers. */
  settings?: ManagedSettingsRow[];
  /** Set while the agent runs and its next start differs from what its session started with. */
  running?: ManagedRunningSnapshot;
  blocks: Array<{ id: string; name: string; builtin: boolean; usedBy: number; startLine: number; endLine: number }>;
  /**
   * `projectOwn`: a built-in skill whose folder git tracks in the agent's
   * folder isn't delivered; the CLI loads the project's copy, and this says
   * so (D74).
   */
  skills: Array<{ id: string; name: string; skillName: string; files: number; folder: string; projectOwn?: string }>;
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
  /**
   * Grant-gated built-ins (prepare-handoff, #3344) not delivered because a
   * skill the person chose installs to the same folder; theirs wins. One line each.
   */
  grantedSkipped?: string[];
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

/**
 * Switch to plain (#2927): what stays in the agent's folder, and what can come
 * back from before it was managed. Read before anything is written.
 */
export interface ManagedPlainPreview {
  instructions: {
    /** Relative to the agent's folder, with forward slashes. */
    file: string;
    exists: boolean;
    /** It differs from what Clubhouse wrote: edited since, by the person or an agent. */
    changedSince: boolean;
    /** Lines in it Clubhouse didn't write. They are kept when the earlier file comes back. */
    addedLines: number;
    /** The copy kept at the switch to managed, and exactly what would be written from it. */
    before: { copy: string; result: string } | null;
    /** Why the earlier file can't come back, when Clubhouse kept one. */
    note?: string;
  };
  /** Null for a CLI with no MCP file (Codex gets its servers as launch flags). */
  mcp: {
    file: string;
    exists: boolean;
    /** Servers in the file now, without the Clubhouse bridge, which every start writes. */
    servers: string[];
    /** Servers added since Clubhouse wrote the file. They are kept when the earlier file comes back. */
    added: string[];
    before: { copy: string; servers: string[]; result: string[] } | null;
    /** Why the earlier file can't come back, when Clubhouse kept one. */
    note?: string;
  } | null;
  /** Skill folders Clubhouse delivered, which stay as the person's. */
  skills: string[];
  /** CLAUDE.md excludes Clubhouse added to the local settings, which come out. */
  excludesAdded: number;
  /** The files as read. Switching refuses when they changed since. */
  token: string;
}

export interface ManagedPlainChoice {
  restoreInstructions?: boolean;
  restoreMcp?: boolean;
  /** From the preview the person saw. Required: a switch without one is refused. */
  token: string;
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

// ── Project parts: checked into a repository under .clubhouse/parts/ ─────

/** Where a project's repository keeps parts it offers, relative to the project root. */
export const PROJECT_PARTS_FOLDER = '.clubhouse/parts';

/**
 * One part a project's repository offers, as of the last read.
 * - `available`: not in the library yet.
 * - `added`: in the library as a project part, and the repository's copy hasn't changed since.
 * - `changed`: the repository's copy changed since it was added or last updated. Nothing changes until the person picks.
 * - `kept`: changed, and the person chose to keep the library's version of this exact repository copy.
 * - `refused`: it can't be read safely (a link, credentials, too large, invalid). `problem` says why.
 */
export interface ProjectPartItem {
  /** `skill:<folder>`, `block:<file name>` or `mcp:<serverKey>`. */
  key: string;
  kind: ManagedPartKind;
  /** The skill folder, the file name without `.md`, or the server key. */
  name: string;
  state: 'available' | 'added' | 'changed' | 'kept' | 'refused';
  /** The repository copy's content hash, when it could be read. */
  hash?: string;
  /** The library part it was added as. */
  partId?: string;
  partName?: string;
  problem?: string;
}

export interface ProjectPartsInventory {
  projectId: string;
  projectName: string;
  items: ProjectPartItem[];
  /** Parts added from this project that its repository no longer has. They stay in the library, and agents keep them. */
  gone: Array<{ key: string; partId: string; partName: string }>;
  notes: string[];
}

/** What adding or updating a repository part would bring in, for the person to review first. */
export interface ProjectPartReview {
  item: ProjectPartItem;
  projectName: string;
  /** The repository's copy, as it would be stored: env values are names only. */
  content: ManagedPartContent;
  droppedEnvValues: string[];
  /** Declared dependencies (names only). Nothing is installed or checked. */
  dependencies: string[];
  /** Library parts of the same kind with the same name or the same content. Never chosen automatically. */
  /** `reusable`: same content, and it can follow this repository part (not built-in, not following another one). */
  matches: Array<{ id: string; name: string; sameContent: boolean; builtin: boolean; reusable: boolean }>;
  /** A free library name to add it under. */
  suggestedName: string;
  /** For `changed` and `kept`: the library part as it is now. */
  current?: { id: string; name: string; revision: number; content: ManagedPartContent; usedBy: number };
}

/** How the person chose to add a repository part: as a new library part, or by using a library part with the same content. */
export type ProjectPartChoice = { mode: 'copy'; name: string } | { mode: 'reuse'; partId: string };

// ── Project templates: checked in as .clubhouse/parts/templates/<file>.json ─

/**
 * A template file's shape. `id` is its identity, so renaming the file keeps it.
 * Parts are named by repository key (`skill:<folder>`, `block:<name>`,
 * `mcp:<serverKey>`, from the same `.clubhouse/parts`) or by built-in id.
 */
export interface ProjectTemplateFile {
  id: string;
  name: string;
  description?: string;
  setup: { blocks: string[]; skills: string[]; mcps: string[] };
  settings?: ManagedTemplateSettings;
}

/** One part reference in a repository template, as it resolves now. */
export interface ProjectTemplateRef {
  ref: string;
  kind: ManagedPartKind;
  /** The library part it is, when it resolves. */
  partId?: string;
  partName?: string;
  /** Why it doesn't: a repository part not added yet (`not_added`, add it first), or nothing by that name (`missing`). */
  unresolved?: 'not_added' | 'missing';
}

/** One template a project's repository offers. States as for parts. */
export interface ProjectTemplateItem {
  /** The template's `id` in the repository. */
  key: string;
  name: string;
  state: 'available' | 'added' | 'changed' | 'kept' | 'refused';
  hash?: string;
  templateId?: string;
  templateName?: string;
  problem?: string;
}

export interface ProjectTemplatesInventory {
  projectPath: string;
  projectId: string;
  projectName: string;
  items: ProjectTemplateItem[];
  /**
   * Templates added from this project that its repository no longer has. They
   * stay, and so do agents made from them. `unsure`: a file there can't be
   * read well enough to tell its id, so the template may be in it.
   */
  gone: Array<{ key: string; templateId: string; templateName: string; unsure?: true }>;
  notes: string[];
}

/** What adding or updating a repository template would do, for the person to review first. */
export interface ProjectTemplateReview {
  item: ProjectTemplateItem;
  projectName: string;
  description: string;
  refs: ProjectTemplateRef[];
  /** Setting changes that carry no authority (CLI, model, effort, auto-sleep), against unset for a new one or the current template for an update. */
  settings: ManagedTemplateChange[];
  /**
   * Grants, access, orchestration and helper template that differ, compared
   * the same way. Left out unless the person approves them.
   */
  permissions: ManagedTemplateChange[];
  /** Names the repository copy gives that the resolver dropped, and why. */
  notes: string[];
  suggestedName: string;
  /** For `changed` and `kept`: the template now, and how many agents were made from it. */
  current?: { id: string; name: string; consumers: number };
  /** For `changed` and `kept`: the push the update would make, as the template push dialog shows it. */
  push?: { changes: ManagedTemplateChange[]; targets: ManagedTemplatePushTarget[] };
}
