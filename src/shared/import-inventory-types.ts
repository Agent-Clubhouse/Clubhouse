/**
 * What the existing-user import inventory reports (#2820). Paths, hashes and
 * names only: no file contents, and no MCP env values. The mapping onto the
 * library comes later, so nothing here refers to it.
 */

export type InventoryKind =
  | 'skill'
  | 'agent-template'
  | 'persona'
  | 'default-instructions'
  | 'default-permissions'
  | 'agent-instructions'
  | 'provider-instructions'
  | 'mcp-server';

/** `provider` and `global` are read only on request and kept apart from `project`. */
export type InventoryScope = 'project' | 'provider' | 'global';

/** What git answered for one file. `not-a-repo` and `unknown` are never guessed into the others. */
export type InventoryGitState = 'tracked' | 'untracked' | 'ignored' | 'not-a-repo' | 'unknown';

export type InventoryExclusionReason =
  | 'secret-looking'
  | 'non-definition'
  | 'too-large'
  | 'unreadable'
  | 'symlink'
  | 'over-limit';

export type InventoryExclusionCounts = Record<InventoryExclusionReason, number>;

export interface InventoryFile {
  /** Absolute, in the platform's own form. */
  path: string;
  /** Relative to the source's `root`, with `/` separators. */
  relativePath: string;
  gitState: InventoryGitState;
  /** sha256 of the bytes on disk, wildcards unexpanded. */
  contentHash: string;
  sizeBytes: number;
}

/** One place an entry was found. */
export interface InventorySource {
  /** Null for global sources, which belong to no project. */
  projectId: string | null;
  projectName: string | null;
  /** The project, worktree or home folder the source's files are relative to. */
  root: string;
  /** The skill folder, or the file the entry lives in. */
  path: string;
  /** For a value inside a file, such as `agentDefaults.instructions`. */
  pointer?: string;
  /** Set for `agent-instructions`: whose worktree this came from. */
  agent?: { id: string; name: string };
  files: InventoryFile[];
  /** Files in this source left out of `files` and of the hash. Nonzero means the entry is partial. */
  excludedFileCount: number;
}

/** An MCP server definition. Env and header values never appear, except env references. */
export interface InventoryMcpDefinition {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  /** `reference` is set only when the stored value is wholly `${VAR}`, `$VAR` or `%VAR%`. */
  env: Array<{ name: string; reference?: string }>;
  /** Variables the CLI forwards by name (Codex's `env_vars`). */
  forwardedEnv: string[];
  headerNames: string[];
  /** Keys in the stored definition that this list doesn't carry. */
  omittedKeys: string[];
}

export interface InventoryPersonaMetadata {
  /** Front-matter keys, without values. */
  frontMatterKeys: string[];
  /** `skills` declared in front matter. Nothing reads this metadata today, so it is inert. */
  inertSkillDeclarations: string[];
}

/**
 * One piece of content. Sources with the same kind, name and hash merge into
 * one entry; the same name with a different hash is another entry, and both
 * have `conflict` set.
 */
export interface InventoryEntry {
  kind: InventoryKind;
  name: string;
  scope: InventoryScope;
  contentHash: string;
  /** Wildcard tokens in the content, as written (`@@AgentName`). None are expanded. */
  wildcards: string[];
  sources: InventorySource[];
  conflict: boolean;
  /** The other hashes under this kind and name. */
  conflictingHashes: string[];
  mcp?: InventoryMcpDefinition;
  persona?: InventoryPersonaMetadata;
}

/** Content identical to something Clubhouse ships. Not offered, listed so it can be explained. */
export interface InventoryBuiltinMatch {
  kind: InventoryKind;
  name: string;
  builtinId: string;
  contentHash: string;
  sources: InventorySource[];
}

export type InventoryAgentStatus =
  /** Clubhouse Mode writes this worktree. Nothing in it was read. */
  | 'generated'
  | 'scanned'
  | 'missing-worktree'
  | 'no-worktree'
  /** Clubhouse Mode's settings can't be read, so this may be generated. Nothing in it was read. */
  | 'skipped-mode-unknown';

export interface InventoryAgentReport {
  id: string;
  name: string;
  worktreePath?: string;
  status: InventoryAgentStatus;
  /** Whether Clubhouse Mode writes this agent's worktree at wake, as agent-system decides it. */
  managed: boolean | 'unknown';
  persona?: string;
  mission?: string;
}

/** What Clubhouse Mode produces for a project, from its source folders. Names and counts only. */
export interface InventoryClubhouseModeResult {
  hasInstructions: boolean;
  permissionRuleCount: number;
  mcpServerNames: string[];
  skills: string[];
  agentTemplates: string[];
  defaultPersona?: string;
  defaultMission?: string;
}

export interface InventoryClubhouseMode {
  enabled: boolean | 'unknown';
  /** `project` when an override stored under exactly this path applies, as isClubhouseModeEnabled reads it. */
  source: 'project' | 'app' | 'unknown';
  effective?: InventoryClubhouseModeResult;
}

export type InventoryProjectStatus =
  | 'scanned'
  | 'missing'
  | 'unavailable'
  /** Cancelled before finishing. Its entries are left out, so a list never holds half a project. */
  | 'cancelled'
  | 'not-started';

export interface InventoryProjectReport {
  projectId: string;
  projectName: string;
  projectPath: string;
  status: InventoryProjectStatus;
  /** An error code or `timeout`; never an error message, which can quote a file. */
  reason?: string;
  /** The file or size limit was hit, so the list for this project is short. */
  truncated: boolean;
  filesSeen: number;
  excluded: InventoryExclusionCounts;
  /** MCP entries dropped because they are the injected Clubhouse bridge. */
  bridgeEntriesFiltered: number;
  /** Mission files. In the code, not in #2820's table, so counted and not offered. */
  missionsNotInventoried: number;
  /** Short codes for problems that didn't stop the scan. */
  warnings: string[];
  clubhouseMode: InventoryClubhouseMode;
  agents: InventoryAgentReport[];
}

export type InventoryOrphanReason =
  | 'unregistered'
  /** The project is registered but its folder is gone. */
  | 'project-missing'
  /** Names a registered project in a different spelling, which isClubhouseModeEnabled won't match. */
  | 'path-variant';

/** Stored config for a path that isn't a usable project. Reported only: the path isn't touched. */
export interface InventoryOrphanedConfig {
  settingsFile: string;
  path: string;
  reason: InventoryOrphanReason;
}

export interface ImportInventory {
  version: 1;
  status: 'complete' | 'cancelled';
  entries: InventoryEntry[];
  /** Provider and global config, off by default. Empty unless asked for. */
  providerEntries: InventoryEntry[];
  builtinMatches: InventoryBuiltinMatch[];
  projects: InventoryProjectReport[];
  orphaned: InventoryOrphanedConfig[];
  globalStatus: 'not-requested' | 'scanned' | 'unavailable' | 'cancelled';
  /** Exclusions outside any project, from the global scan. */
  globalExcluded: InventoryExclusionCounts;
}

export interface InventoryProgress {
  phase: 'project-started' | 'project-finished' | 'files' | 'global';
  projectIndex: number;
  projectCount: number;
  projectName?: string;
  filesSeen: number;
}
