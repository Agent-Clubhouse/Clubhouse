/**
 * What the existing-user import inventory reports (#2820). Paths, hashes and
 * names only: no file contents, and no MCP argument, URL or env values. The mapping onto the
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
  /** A CLI's own subagent file (`.claude/agents/x.md`, `.github/agents/x.agent.md`). Provider config, so off by default. */
  | 'native-subagent'
  | 'mcp-server';

/** `provider` and `global` are read only on request and kept apart from `project`. */
export type InventoryScope = 'project' | 'provider' | 'global';

/**
 * What git answered for one file. `unknown` means git wasn't asked or couldn't say,
 * and is common: git runs only on a plain repo at the root, so a linked worktree's
 * files read this. It says nothing about the file, and mustn't read as safe to import.
 */
export type InventoryGitState = 'tracked' | 'untracked' | 'ignored' | 'unknown';

export type InventoryExclusionReason =
  | 'secret-looking'
  /** A name that could itself hold a credential, or that isn't valid text. */
  | 'unsafe-name'
  | 'hard-link'
  /** A FIFO, socket or device. Never opened. */
  | 'special-file'
  | 'non-definition'
  | 'too-large'
  | 'unreadable'
  | 'symlink'
  | 'over-limit';

export type InventoryExclusionCounts = Record<InventoryExclusionReason, number>;

/** One thing left out. Bounded per project; `excluded` has the full counts. */
export interface InventoryExclusion {
  reason: InventoryExclusionReason;
  /** Relative to the source root, `/` separated. Absent when the path itself isn't fit to show. */
  relativePath?: string;
}

/** A value from config that's a path: shown only if it's plainly one, identified either way. */
export interface InventoryConfiguredPath {
  text?: string;
  hash: string;
  length: number;
}

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

/**
 * What a source can't promise. On instructions from a worktree Clubhouse Mode
 * doesn't write: they may hold text Clubhouse wrote, wildcards already expanded,
 * and git state hints at who wrote them without saying. Never read as hand-edited.
 */
export type InventorySourceCaveat = 'wildcards-may-be-expanded' | 'git-state-is-a-hint';

/** Why a repository-configured path was left alone. None of these paths were touched, except where noted. */
export type InventoryExternalReason =
  | 'invalid-path'
  | 'relative-path'
  | 'unc-path'
  | 'parent-traversal'
  /** Not inside the project. Only `includeExternalRoots` can bring it in, whatever git says about it. */
  | 'outside-project'
  /** Inside the project as written, but a symlink leads out. Only the links inside the project were read. */
  | 'symlink-outside-project';

/** Why a worktree outside the plain project scan may be read. */
export interface InventoryWorktreeAccess {
  by: 'project-root' | 'explicit-inclusion';
  /** What `agents.json` holds. */
  configuredPath: InventoryConfiguredPath;
  /** Set for `explicit-inclusion`: the entry in `includeExternalRoots` that allowed it. */
  includedRoot?: string;
}

/**
 * A path in a repository's config that points outside the authorized roots.
 * Metadata only: no read, hash or count of anything there. Passing the path in
 * `includeExternalRoots` is the only way to have it scanned.
 */
export interface InventoryExternalReference {
  projectId: string;
  projectName: string;
  agent: { id: string; name: string };
  /** Untrusted. `text` is absent when it isn't plainly a path, so a credential or a pasted document never comes back. */
  configuredPath: InventoryConfiguredPath;
  reason: InventoryExternalReason;
}

/** One place an entry was found. */
export interface InventorySource {
  /** Stable across scans: from the project, kind, name and relative path, not content or an absolute path. */
  id: string;
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
  /** Set on anything read from an agent's worktree: what allowed it. */
  worktreeAccess?: InventoryWorktreeAccess;
  caveats?: InventorySourceCaveat[];
  files: InventoryFile[];
  /** Files in this source left out of `files` and of the hash. Nonzero means the entry is partial. */
  excludedFileCount: number;
}

/**
 * What can be said about an MCP server without showing anything that could be a
 * credential, whatever its shape. No arguments, URL path or query, env or header
 * values. A later import step reads the details on the user's explicit action.
 *
 * Such an entry's `contentHash` covers only these fields, so it's the same from
 * scan to scan and can't confirm a guess at a withheld value. It doesn't change when
 * only withheld details do; two definitions that differ there are separate entries
 * with `conflict` set and possibly the same hash, compared inside the scan by a key
 * that never leaves it.
 */
export interface InventoryMcpDefinition {
  /** The executable's plain name. Absent when the command doesn't reduce to one. */
  commandName?: string;
  argumentCount: number;
  /** Scheme and host only. */
  url?: { scheme: string; host?: string };
  /** Only a known transport name. */
  transport?: string;
  /** Env and forwarded variable names that pass a safe-name check. */
  envNames: string[];
  /** There's more to this definition than these fields show. */
  detailsWithheld: boolean;
}

/** A value from config that's free text, so only its identity is reported. */
export interface InventoryConfigRef {
  /** Set only when the value is a plain id that doesn't look like a credential. */
  id?: string;
  hash: string;
  length: number;
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
  /** Stable across scans while this source remains: its first source's id. */
  id: string;
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
  /** Its configured path is outside the authorized roots: see `externalReferences`. Nothing there was touched. */
  | 'external'
  /** Clubhouse Mode's settings can't be read, so this may be generated. Nothing in it was read. */
  | 'skipped-mode-unknown';

export interface InventoryAgentReport {
  id: string;
  name: string;
  worktreePath?: InventoryConfiguredPath;
  status: InventoryAgentStatus;
  /** Whether Clubhouse Mode writes this agent's worktree at wake, as agent-system decides it. */
  managed: boolean | 'unknown';
  persona?: InventoryConfigRef;
  mission?: InventoryConfigRef;
  /** MCP config files in this worktree holding more than the bridge. Counted, not offered. Always 0 for an external path. */
  mcpFilesNotInventoried: number;
  worktreeAccess?: InventoryWorktreeAccess;
}

/** What Clubhouse Mode produces for a project, from its source folders. Names and counts only. */
export interface InventoryClubhouseModeResult {
  hasInstructions: boolean;
  permissionRuleCount: number;
  mcpServerNames: string[];
  skills: string[];
  agentTemplates: string[];
  defaultPersona?: InventoryConfigRef;
  defaultMission?: InventoryConfigRef;
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
  exclusions: InventoryExclusion[];
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
  /** Names a registered project in a different spelling, which the exact-string lookups won't match. */
  | 'path-variant';

/** A stored `projectOverrides` key for a path that isn't a usable project. Reported only: the path isn't touched. */
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
  externalReferences: InventoryExternalReference[];
  /** Entries in `includeExternalRoots` no agent's configured path matched. Nothing was scanned for them. */
  unmatchedExternalRoots: string[];
  globalStatus: 'not-requested' | 'scanned' | 'unavailable' | 'cancelled';
  /** Exclusions outside any project, from the global scan. */
  globalExcluded: InventoryExclusionCounts;
  globalExclusions: InventoryExclusion[];
}

export interface InventoryProgress {
  phase: 'project-started' | 'project-finished' | 'files' | 'global';
  projectIndex: number;
  projectCount: number;
  projectName?: string;
  filesSeen: number;
}
