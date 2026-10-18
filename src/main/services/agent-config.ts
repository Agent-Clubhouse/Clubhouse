import { execFile } from 'child_process';
import { watch, type FSWatcher } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { DurableAgentConfig, DurableConfigUpdates, OrchestratorId, SessionInfo, WorktreeStatus, DeleteResult, GitStatusFile, GitLogEntry, HelperCascadeResult, HelperDeleteChoice, HelperDisposeBlock, HelperDisposeChecks } from '../../shared/types';
import type { DurableAgentCreation, DurableCreationEvent, DurableCreationStage, DurableWorktreeOptions, StartDurableCreationParams } from '../../shared/types';
import { isDisposedAgent, parentLinkError } from '../../shared/agent-helpers';
import { appLog } from './log-service';
import { applyAgentDefaults, readProjectAgentDefaults } from './agent-settings-service';
import { tagError } from '../telemetry/types';
import { resolveOrchestrator } from './agent-system';
import { pathExists } from './fs-utils';
import { isInsideGitRepo } from './git-service';
import { stepUnderFlow } from '../telemetry/workspace';
import { persist } from '../telemetry/persist';
import { normalizeIdleSleep } from '../../shared/idle-sleep';
import { setAgentIdleSleep } from './chat-idle-settings';
import { assertAgentGitName, validateAgentGitName } from '../../shared/agent-name';

/**
 * Non-blocking git command execution. Prevents UI freezes in large repos.
 * Always an argument list, never a shell string: names that reach git here
 * can come from another agent (#2221).
 */
function execGitFileAsync(args: string[], cwd: string, maxBuffer?: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer, ...(signal ? { signal } : {}) }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

function clubhouseDir(projectPath: string): string {
  return path.join(projectPath, '.clubhouse');
}

/** The folder every agent worktree lives in. */
function agentsDir(projectPath: string): string {
  return path.join(clubhouseDir(projectPath), 'agents');
}

/**
 * The worktree folder for an agent named `name`: `<project>/.clubhouse/agents/<name>`.
 * Throws when the name is not a valid agent folder name, or when the path
 * would land anywhere but directly inside `.clubhouse/agents/` (#2221).
 */
export function resolveAgentWorktreePath(projectPath: string, name: string): string {
  assertAgentGitName(name, 'folder');
  const root = path.resolve(agentsDir(projectPath));
  const target = path.resolve(root, name);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel !== name) {
    throw new Error(`The agent's worktree must stay inside ${root}.`);
  }
  return path.join(agentsDir(projectPath), name);
}

function agentsConfigPath(projectPath: string): string {
  return path.join(clubhouseDir(projectPath), 'agents.json');
}

function agentsBackupPath(projectPath: string): string {
  return path.join(clubhouseDir(projectPath), 'agents.json.bak');
}

const GITIGNORE_BLOCK = `# Clubhouse agent manager
.clubhouse/agents/
.clubhouse/.local/
.clubhouse/agents.json
.clubhouse/settings.local.json`;

export async function ensureGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, '.gitignore');

  const requiredLines = [
    '.clubhouse/agents/',
    '.clubhouse/.local/',
    '.clubhouse/agents.json',
    '.clubhouse/agents.json.bak',
    '.clubhouse/settings.local.json',
  ];

  if (await pathExists(gitignorePath)) {
    const content = await fsp.readFile(gitignorePath, 'utf-8');

    // Check which lines are missing
    const missing = requiredLines.filter((line) => !content.includes(line));
    if (missing.length === 0) return;

    // Append only the missing lines under a header (if header isn't there yet)
    const parts: string[] = [];
    if (!content.includes('# Clubhouse agent manager')) {
      parts.push('# Clubhouse agent manager');
    }
    parts.push(...missing);

    await fsp.appendFile(gitignorePath, `\n${parts.join('\n')}\n`);
  } else {
    await fsp.writeFile(gitignorePath, `${GITIGNORE_BLOCK}\n`);
  }
}

// --- Write-back cache with dirty tracking and debounced flush ---

interface CacheEntry {
  agents: DurableAgentConfig[];
  baselineAgents: DurableAgentConfig[];
  diskSnapshot: string;
  agentsById: Map<string, DurableAgentConfig>;
  dirty: boolean;
  /** Bumped on every mutation so a flush can tell whether it covered the latest state. */
  revision: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingFlush: Promise<void> | null;
  /** Filesystem identity of the project directory (see projectIdentity). */
  identity?: string;
}

function buildAgentsById(agents: DurableAgentConfig[]): Map<string, DurableAgentConfig> {
  return new Map(agents.map((a) => [a.id, a]));
}

/** Populate cache if needed, then return both the agents array and the O(1) ID index. */
async function readAgentsEntry(projectPath: string): Promise<{ agents: DurableAgentConfig[]; agentsById: Map<string, DurableAgentConfig> }> {
  const agents = await readAgents(projectPath);
  return { agents, agentsById: configCache.get(projectPath)!.agentsById };
}

const configCache = new Map<string, CacheEntry>();
const configWatchers = new Map<string, FSWatcher>();

// ---------------------------------------------------------------------------
// Cross-project durable ID ownership
// ---------------------------------------------------------------------------
//
// Durable agent IDs must be unique across every project loaded in this app
// run: the renderer agent store and main-process services (pty-manager,
// structured/headless sessions, ...) are keyed by agent ID alone. Two project
// directories can still hold the same ID — most commonly a `.clubhouse/`
// folder copied from one project into another. Without intervention the
// agent shows up under whichever project loaded last and both projects share
// one live session slot.
//
// The first project to load an ID owns it; a later project loading the same
// ID gets a freshly generated ID persisted through the normal revision-safe
// flush. Ownership is tracked by directory identity (not the path string), so
// the same project reached via a different spelling, a symlink or a re-added
// store entry never collides with itself. Claims outlive cache entries
// because the agents.json watcher clears the cache after every write.

/** agent ID → identity of the project directory that owns it. */
const agentIdOwners = new Map<string, string>();

/**
 * Stable identity for a project directory: device + inode when available,
 * otherwise the resolved path.
 */
async function projectIdentity(projectPath: string): Promise<string> {
  try {
    const stats = await fsp.stat(projectPath);
    if (stats && stats.ino) return `ino:${stats.dev}:${stats.ino}`;
  } catch {
    // Fall through — directory may not exist yet (or stat is unavailable).
  }
  return `path:${path.resolve(projectPath)}`;
}

function generateDurableId(): string {
  return `durable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Record `identity` as the owner of exactly the given agent IDs. */
function syncAgentIdClaims(identity: string, agents: DurableAgentConfig[]): void {
  const ids = new Set(agents.map((a) => a.id));
  for (const [id, owner] of agentIdOwners) {
    if (owner === identity && !ids.has(id)) agentIdOwners.delete(id);
  }
  for (const id of ids) {
    if (!agentIdOwners.has(id)) agentIdOwners.set(id, identity);
  }
}

/** Give an agent copied under a new ID its own icon file, best-effort. */
async function copyAgentIconForNewId(icon: string, newId: string): Promise<string | undefined> {
  try {
    const iconsDir = await getAgentIconsDir();
    const newIcon = `${newId}${path.extname(icon) || '.png'}`;
    await fsp.copyFile(path.join(iconsDir, icon), path.join(iconsDir, newIcon));
    return newIcon;
  } catch {
    return undefined;
  }
}

/**
 * Regenerate IDs in `agents` that another project already owns. Synchronous
 * so the ownership check and the claim on the new IDs cannot interleave with
 * another project's load. Returns a new array (unchanged agents keep their
 * object identity) plus the reassignments, or null when nothing collided.
 */
function reassignForeignAgentIds(
  projectPath: string,
  identity: string,
  agents: DurableAgentConfig[],
): { agents: DurableAgentConfig[]; reassigned: Array<{ agent: DurableAgentConfig; oldId: string }> } | null {
  const isForeign = (id: string) => {
    const owner = agentIdOwners.get(id);
    return owner !== undefined && owner !== identity;
  };
  if (!agents.some((a) => isForeign(a.id))) return null;

  const taken = new Set(agents.map((a) => a.id));
  const reassigned: Array<{ agent: DurableAgentConfig; oldId: string }> = [];
  const result = agents.map((agent) => {
    if (!isForeign(agent.id)) return agent;
    let newId = generateDurableId();
    while (taken.has(newId) || agentIdOwners.has(newId)) newId = generateDurableId();
    taken.add(newId);
    agentIdOwners.set(newId, identity);
    const copy: DurableAgentConfig = { ...agent, id: newId };
    reassigned.push({ agent: copy, oldId: agent.id });
    return copy;
  });
  // Helpers (#2224) follow their parent to its new ID.
  const newIdFor = new Map(reassigned.map(({ agent, oldId }) => [oldId, agent.id]));
  for (let i = 0; i < result.length; i++) {
    const parentId = result[i].parentAgentId;
    const newParentId = parentId ? newIdFor.get(parentId) : undefined;
    if (newParentId) result[i] = { ...result[i], parentAgentId: newParentId };
  }

  appLog('core:agent-config', 'warn', `Reassigned ${reassigned.length} durable agent ID(s) already used by another project`, {
    meta: {
      projectPath,
      reassigned: reassigned.map(({ agent, oldId }) => ({
        oldId, newId: agent.id, name: agent.name, ownerIdentity: agentIdOwners.get(oldId),
      })),
    },
  });
  return { agents: result, reassigned };
}

/**
 * Give reassigned agents their own icon files so deleting or replacing the
 * original agent's icon cannot strip the copy's. Mutates the agents in place;
 * returns whether any icon field changed.
 */
async function copyIconsForReassignedAgents(reassigned: Array<{ agent: DurableAgentConfig }>): Promise<boolean> {
  let changed = false;
  for (const { agent } of reassigned) {
    if (!agent.icon) continue;
    const newIcon = await copyAgentIconForNewId(agent.icon, agent.id);
    if (newIcon) {
      agent.icon = newIcon;
      changed = true;
    }
  }
  return changed;
}

/** How long to wait before flushing dirty cache entries to disk (ms) */
const FLUSH_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Agent config validation — catches ghost agents and corruption early
// ---------------------------------------------------------------------------

/** Pattern for auto-generated durable IDs: durable_<timestamp>_<random> */
const DURABLE_ID_PATTERN = /^durable_\d+_[a-z0-9]+$/;

interface ValidationIssue {
  agentId: string;
  issue: string;
  severity: 'warn' | 'error';
}

/**
 * Validate an array of agent configs and return any issues found.
 * Does NOT modify the configs — callers decide how to handle issues.
 */
export function validateAgentConfigs(agents: DurableAgentConfig[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Map<string, number>();

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    // Check for missing required fields
    if (!agent.id) {
      issues.push({ agentId: `index_${i}`, issue: 'Missing agent ID', severity: 'error' });
      continue;
    }

    if (!agent.name) {
      issues.push({ agentId: agent.id, issue: 'Missing agent name — will display as raw ID', severity: 'error' });
    } else if (agent.name === agent.id || DURABLE_ID_PATTERN.test(agent.name)) {
      // Name looks like a raw ID — likely a ghost agent
      issues.push({ agentId: agent.id, issue: `Agent name "${agent.name}" matches ID pattern — possible ghost agent`, severity: 'warn' });
    }

    if (!agent.color) {
      issues.push({ agentId: agent.id, issue: 'Missing agent color', severity: 'warn' });
    }

    // Check for duplicate IDs
    const prevIndex = seenIds.get(agent.id);
    if (prevIndex !== undefined) {
      issues.push({ agentId: agent.id, issue: `Duplicate agent ID at indices ${prevIndex} and ${i}`, severity: 'error' });
    } else {
      seenIds.set(agent.id, i);
    }

    // Check worktree path exists if specified
    if (agent.worktreePath && !agent.worktreePath.includes(path.sep)) {
      issues.push({ agentId: agent.id, issue: `Suspicious worktreePath: "${agent.worktreePath}"`, severity: 'warn' });
    }
  }

  return issues;
}

/**
 * Deduplicate agents by ID, keeping the first occurrence.
 * Returns deduplicated array and list of removed duplicates.
 */
function deduplicateAgents(agents: DurableAgentConfig[]): { agents: DurableAgentConfig[]; removed: DurableAgentConfig[] } {
  const seen = new Set<string>();
  const result: DurableAgentConfig[] = [];
  const removed: DurableAgentConfig[] = [];

  for (const agent of agents) {
    if (!agent.id || seen.has(agent.id)) {
      removed.push(agent);
    } else {
      seen.add(agent.id);
      result.push(agent);
    }
  }

  return { agents: result, removed };
}

/** A persisted record is usable only if it is an object with a non-empty string ID. */
function isAgentRecord(value: unknown): value is DurableAgentConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string' && (value as { id: string }).id.length > 0;
}

function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Read a config file, returning null only when it does not exist. Any other
 * read failure (EACCES, EBUSY, EMFILE, ...) is transient from our point of view
 * and is rethrown so it never turns into a cached — and later persisted — empty
 * agent list while the file on disk is still intact.
 */
async function readConfigFileIfPresent(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) return null;
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return null;
    appLog('core:agent-config', 'error', 'Failed to read agent config file', {
      meta: { filePath, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

async function readAgentsFromDisk(projectPath: string): Promise<DurableAgentConfig[]> {
  const configPath = agentsConfigPath(projectPath);
  const backupPath = agentsBackupPath(projectPath);

  appLog('core:agent-config', 'debug', 'Reading agent configs from disk', {
    meta: { configPath, backupPath },
  });

  let agents: DurableAgentConfig[] | null = null;
  let source: 'main' | 'backup' | 'empty' = 'empty';

  let droppedInvalid = false;

  // Try to read main config
  const mainRaw = await readConfigFileIfPresent(configPath);
  if (mainRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(mainRaw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isAgentRecord);
        if (valid.length > 0 || parsed.length === 0) {
          agents = valid;
          source = 'main';
          droppedInvalid = valid.length !== parsed.length;
          if (droppedInvalid) {
            appLog('core:agent-config', 'warn', `Dropped ${parsed.length - valid.length} invalid record(s) from agents.json`, {
              meta: { configPath },
            });
          }
          appLog('core:agent-config', 'info', `Loaded ${agents.length} agent(s) from disk`, {
            meta: {
              configPath,
              agents: agents.map((a) => ({ id: a.id, name: a.name, hasWorktree: !!a.worktreePath })),
            },
          });
        } else {
          // Non-empty but every record is invalid (e.g. `[null]`) — this is
          // corruption, not an intentionally empty list. Fall back to backup.
          persist.recovery('agents', 'primary_corrupt');
          appLog('core:agent-config', 'error', 'agents.json has no valid agent records — attempting recovery from backup', {
            meta: { configPath },
          });
        }
      }
    } catch (err) {
      persist.recovery('agents', 'primary_corrupt');
      appLog('core:agent-config', 'error', 'Failed to parse agents.json — attempting recovery from backup', {
        meta: { configPath, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Main file missing or corrupt — fall back to backup
  if (!agents) {
    const backupRaw = await readConfigFileIfPresent(backupPath);
    if (backupRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(backupRaw);
        const valid = Array.isArray(parsed) ? parsed.filter(isAgentRecord) : [];
        if (valid.length > 0) {
          agents = valid;
          source = 'backup';
          persist.recovery('agents', 'restored_from_backup');
          appLog('core:agent-config', 'warn', `Recovered ${agents.length} agent(s) from backup`, {
            meta: {
              backupPath,
              agents: agents.map((a) => ({ id: a.id, name: a.name })),
            },
          });
          // Restore the main file from the backup without clobbering the backup
          // itself. The backup is the last known-good snapshot and must survive
          // the recovery path to preserve future recovery options.
          await writeAgentsToDiskSkippingBackup(projectPath, agents);
        }
      } catch (backupErr) {
        persist.recovery('agents', 'backup_corrupt');
        appLog('core:agent-config', 'error', 'Backup agents.json.bak is also corrupt', {
          meta: { backupPath, error: backupErr instanceof Error ? backupErr.message : String(backupErr) },
        });
      }
    }
  }

  if (!agents) {
    appLog('core:agent-config', 'info', 'No agent configs found on disk', { meta: { projectPath } });
    return [];
  }

  // Validate loaded configs
  const issues = validateAgentConfigs(agents);
  if (issues.length > 0) {
    appLog('core:agent-config', 'warn', `Agent config validation found ${issues.length} issue(s)`, {
      meta: { source, issues },
    });
  }

  // Deduplicate — remove agents with duplicate IDs
  const { agents: deduped, removed } = deduplicateAgents(agents);
  if (removed.length > 0) {
    appLog('core:agent-config', 'warn', `Removed ${removed.length} duplicate agent(s)`, {
      meta: {
        removedAgents: removed.map((a) => ({ id: a.id, name: a.name })),
      },
    });
  }
  // Structured mode was removed (the Chat runtime replaces it). Drop the legacy
  // per-agent flag so those agents start in the terminal, and persist the
  // cleaned list once.
  const strippedLegacy = stripLegacyStructuredMode(deduped);
  if (strippedLegacy > 0) {
    appLog('core:agent-config', 'info', `Removed legacy structuredMode from ${strippedLegacy} agent(s)`, {
      meta: { projectPath },
    });
  }

  const normalizedHelpers = normalizeHelperFields(deduped);
  if (normalizedHelpers > 0) {
    appLog('core:agent-config', 'warn', `Repaired helper fields on ${normalizedHelpers} agent(s)`, {
      meta: { projectPath },
    });
  }

  if (removed.length > 0 || droppedInvalid || strippedLegacy > 0 || normalizedHelpers > 0) {
    // Persist the cleaned list without clobbering a valid backup when the
    // current file had to be recovered from backup first, or when the current
    // file held invalid records (copying it into the backup would replace the
    // last known-good snapshot with a damaged one).
    if (source === 'backup' || droppedInvalid) {
      await writeAgentsToDiskSkippingBackup(projectPath, deduped);
    } else {
      await writeAgentsToDisk(projectPath, deduped);
    }
  }

  return deduped;
}

/**
 * Remove the legacy `structuredMode` flag from agent records in place.
 * Returns how many records carried it.
 */
export function stripLegacyStructuredMode(agents: DurableAgentConfig[]): number {
  let count = 0;
  for (const agent of agents) {
    const record = agent as DurableAgentConfig & { structuredMode?: unknown };
    if ('structuredMode' in record) {
      delete record.structuredMode;
      count++;
    }
  }
  return count;
}

/**
 * Repair helper fields (#2224) in place: drop malformed values, self-parenting
 * and parent cycles, and release a live helper whose parent no longer exists
 * so it loads as an ordinary durable agent instead of an orphan. A disposed
 * helper keeps its link for history. Configs without the fields are untouched.
 * Returns how many records changed.
 */
export function normalizeHelperFields(agents: DurableAgentConfig[]): number {
  const changed = new Set<string>();
  for (const agent of agents) {
    const record = agent as DurableAgentConfig & Record<string, unknown>;
    if ('parentAgentId' in record && (typeof record.parentAgentId !== 'string' || !record.parentAgentId)) {
      delete record.parentAgentId;
      changed.add(agent.id);
    }
    if ('disposable' in record && record.disposable !== true) {
      delete record.disposable;
      changed.add(agent.id);
    }
    if ('disposedAt' in record && (typeof record.disposedAt !== 'string' || !record.disposedAt)) {
      delete record.disposedAt;
      changed.add(agent.id);
    }
  }
  const ids = new Set(agents.map((a) => a.id));
  for (const agent of agents) {
    const parentId = agent.parentAgentId;
    if (!parentId) continue;
    const others = agents.map((a) => (a === agent ? { id: a.id } : a));
    const dangling = !ids.has(parentId);
    if (parentId === agent.id || (!dangling && parentLinkError(others, agent.id, parentId))
      || (dangling && !isDisposedAgent(agent))) {
      delete agent.parentAgentId;
      delete agent.disposable;
      changed.add(agent.id);
    }
  }
  return changed.size;
}

async function writeAgentsToDisk(projectPath: string, agents: DurableAgentConfig[]): Promise<void> {
  await writeAgentsToDiskWithOptions(projectPath, agents, { skipBackup: false });
}

async function writeAgentsToDiskSkippingBackup(projectPath: string, agents: DurableAgentConfig[]): Promise<void> {
  await writeAgentsToDiskWithOptions(projectPath, agents, { skipBackup: true });
}

async function writeAgentsToDiskWithOptions(
  projectPath: string,
  agents: DurableAgentConfig[],
  options: { skipBackup?: boolean },
): Promise<void> {
  const dir = clubhouseDir(projectPath);
  await ensureDir(dir);
  ensureConfigWatcher(projectPath);

  const configPath = agentsConfigPath(projectPath);
  const backupPath = agentsBackupPath(projectPath);
  const skipBackup = options.skipBackup ?? false;

  let previousConfig: string | null = null;
  if (!skipBackup && await pathExists(configPath)) {
    try {
      previousConfig = await fsp.readFile(configPath, 'utf-8');
    } catch {
      // Non-fatal — if the current config is unreadable, we still write the
      // new config and leave the backup untouched rather than clobbering it.
    }
  }

  // Atomic write: write to temp file then rename — prevents partial/corrupt
  // files if the process crashes mid-write. We update the backup only after the
  // main file rename succeeds so a crash can never leave both files corrupt.
  const tmpPath = configPath + '.tmp.' + randomUUID().slice(0, 8);
  await persist.timed('agents', async () => {
    await fsp.writeFile(tmpPath, JSON.stringify(agents, null, 2), 'utf-8');
    await fsp.rename(tmpPath, configPath);
  });

  if (!skipBackup && previousConfig !== null) {
    const backupTmpPath = backupPath + '.tmp.' + randomUUID().slice(0, 8);
    try {
      await fsp.writeFile(backupTmpPath, previousConfig, 'utf-8');
      await fsp.rename(backupTmpPath, backupPath);
    } catch {
      // Non-fatal — best-effort backup refresh. The main file is already written.
    }
  }

  appLog('core:agent-config', 'info', `Wrote ${agents.length} agent(s) to disk`, {
    meta: { configPath, agentIds: agents.map((a) => a.id), skippedBackup: skipBackup },
  });
}

function cloneAgents(agents: DurableAgentConfig[]): DurableAgentConfig[] {
  return JSON.parse(JSON.stringify(agents)) as DurableAgentConfig[];
}

function mergeExternalAgents(
  baseline: DurableAgentConfig[],
  local: DurableAgentConfig[],
  external: DurableAgentConfig[],
): DurableAgentConfig[] {
  const baselineById = new Map(baseline.map((agent) => [agent.id, agent]));
  const localById = new Map(local.map((agent) => [agent.id, agent]));
  const externalById = new Map(external.map((agent) => [agent.id, agent]));
  const ids = new Set([...baselineById.keys(), ...localById.keys(), ...externalById.keys()]);
  const merged = [...ids].flatMap((id) => {
    const baselineAgent = baselineById.get(id);
    const localAgent = localById.get(id);
    const externalAgent = externalById.get(id);
    // A baseline agent missing locally was deliberately deleted in the app.
    // Do not resurrect it merely because the same agent was edited on disk.
    if (!localAgent) return baselineAgent ? [] : externalAgent ? [externalAgent] : [];
    if (!externalAgent) return baselineAgent ? [] : [localAgent];
    if (!baselineAgent) return [externalAgent];

    const agent = { ...localAgent };
    const keys = new Set([...Object.keys(baselineAgent), ...Object.keys(localAgent), ...Object.keys(externalAgent)]);
    for (const key of keys) {
      const baselineValue = JSON.stringify(baselineAgent[key as keyof DurableAgentConfig]);
      const localValue = JSON.stringify(localAgent[key as keyof DurableAgentConfig]);
      const externalValue = JSON.stringify(externalAgent[key as keyof DurableAgentConfig]);
      if (externalValue !== baselineValue && localValue === baselineValue) {
        if (externalAgent[key as keyof DurableAgentConfig] === undefined) {
          delete (agent as Partial<DurableAgentConfig>)[key as keyof DurableAgentConfig];
        } else {
          Object.assign(agent, { [key]: externalAgent[key as keyof DurableAgentConfig] });
        }
      }
    }
    return [agent];
  });

  const baselineIds = baseline.map((agent) => agent.id).join('\0');
  const externalIds = external.map((agent) => agent.id).join('\0');
  if (baselineIds !== externalIds) {
    const order = new Map(external.map((agent, index) => [agent.id, index]));
    merged.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  } else {
    const order = new Map(local.map((agent, index) => [agent.id, index]));
    merged.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  return merged;
}

function ensureConfigWatcher(projectPath: string): void {
  if (configWatchers.has(projectPath)) return;
  try {
    const watcher = watch(clubhouseDir(projectPath), (_eventType, filename) => {
      if (String(filename) !== 'agents.json') return;
      const entry = configCache.get(projectPath);
      if (entry && !entry.dirty && !entry.pendingFlush) {
        clearAgentConfigCache(projectPath);
      }
      notifyAgentConfigChanged(projectPath);
    });
    watcher.on('error', (err) => {
      appLog('core:agent-config', 'warn', 'Failed to watch agents.json for external changes', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
    });
    configWatchers.set(projectPath, watcher);
  } catch (err) {
    appLog('core:agent-config', 'warn', 'Failed to watch agents.json for external changes', {
      meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Persistence barrier: resolves only once disk reflects the latest in-memory
 * state. A mutation that lands while a write is in flight keeps the entry dirty,
 * so the loop writes again instead of returning after the older write.
 */
async function flushEntry(projectPath: string, entry: CacheEntry): Promise<void> {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  while (entry.pendingFlush || entry.dirty) {
    if (entry.pendingFlush) {
      const waitStart = Date.now();
      try {
        await entry.pendingFlush;
      } finally {
        persist.barrierWait('agents', Date.now() - waitStart);
      }
      continue;
    }
    await startFlush(projectPath, entry);
  }
}

function startFlush(projectPath: string, entry: CacheEntry): Promise<void> {
  // Immutable write snapshot. Callers mutate entry.agents in place (e.g.
  // createDurable pushes onto it), so the write must not observe — and then
  // falsely acknowledge — changes made after this point.
  const revision = entry.revision;
  const snapshot = cloneAgents(entry.agents);
  const baseline = entry.baselineAgents;

  const flushPromise = (async () => {
    let agentsToWrite = snapshot;
    let externalAgents: DurableAgentConfig[] | null = null;
    const currentRaw = await readConfigFileIfPresent(agentsConfigPath(projectPath));
    if (currentRaw !== null) {
      let currentAgents: DurableAgentConfig[];
      try {
        const parsed: unknown = JSON.parse(currentRaw);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        currentAgents = parsed.filter(isAgentRecord);
      } catch {
        throw new Error('Cannot flush agents.json because it was externally changed to invalid JSON');
      }
      const currentSnapshot = JSON.stringify(currentAgents);
      if (currentSnapshot !== entry.diskSnapshot) {
        persist.recovery('agents', 'external_change_merged');
        appLog('core:agent-config', 'warn', 'Detected external agents.json change; merging instead of overwriting it', {
          meta: { projectPath },
        });
        externalAgents = currentAgents;
        agentsToWrite = mergeExternalAgents(baseline, snapshot, currentAgents);
      }
    }
    await writeAgentsToDisk(projectPath, agentsToWrite);
    entry.baselineAgents = cloneAgents(agentsToWrite);
    entry.diskSnapshot = JSON.stringify(agentsToWrite);
    if (entry.revision === revision) {
      if (externalAgents) {
        entry.agents = agentsToWrite;
        entry.agentsById = buildAgentsById(agentsToWrite);
      }
      entry.dirty = false;
    } else if (externalAgents) {
      // A newer mutation landed mid-write. Fold the external edits we just
      // merged into it and stay dirty so the barrier writes the newer state.
      entry.agents = mergeExternalAgents(baseline, entry.agents, externalAgents);
      entry.agentsById = buildAgentsById(entry.agents);
    }
  })()
    .catch((err) => {
      appLog('core:agent-config', 'error', 'Failed to write agents.json', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    })
    .finally(() => {
      if (entry.pendingFlush === flushPromise) {
        entry.pendingFlush = null;
      }
    });

  entry.pendingFlush = flushPromise;
  return flushPromise;
}

function scheduleFlush(projectPath: string, entry: CacheEntry): void {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
  }
  entry.flushTimer = setTimeout(() => {
    void flushEntry(projectPath, entry).catch((err) => {
      appLog('core:agent-config', 'error', 'Debounced agents.json flush failed', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
    });
  }, FLUSH_DELAY_MS);
}

async function readAgents(projectPath: string): Promise<DurableAgentConfig[]> {
  let entry = configCache.get(projectPath);
  if (!entry) {
    const identity = await projectIdentity(projectPath);
    const diskAgents = await readAgentsFromDisk(projectPath);
    // A concurrent read may have populated the cache while we were awaiting.
    const existing = configCache.get(projectPath);
    if (existing) return existing.agents;

    const reassignment = reassignForeignAgentIds(projectPath, identity, diskAgents);
    const agents = reassignment?.agents ?? diskAgents;
    entry = {
      agents,
      // Baseline and snapshot describe what is on disk, so a reassignment is a
      // pending local change that the flush persists (and merges, if needed).
      baselineAgents: cloneAgents(diskAgents),
      diskSnapshot: JSON.stringify(diskAgents),
      agentsById: buildAgentsById(agents),
      dirty: false,
      revision: 0,
      flushTimer: null,
      pendingFlush: null,
      identity,
    };
    configCache.set(projectPath, entry);
    syncAgentIdClaims(identity, agents);
    ensureConfigWatcher(projectPath);
    appLog('core:agent-config', 'info', `Cache initialized with ${agents.length} agent(s)`, {
      meta: { projectPath, agentIds: agents.map((a) => a.id) },
    });
    // A creation left 'creating' by an earlier run was interrupted by a quit (#2226).
    scheduleCreationRecovery(projectPath, agents);
    if (reassignment) {
      // Mark dirty before awaiting so the agents.json watcher cannot drop the
      // reassignment from the cache before it is persisted.
      entry.revision++;
      entry.dirty = true;
      scheduleFlush(projectPath, entry);
      if (await copyIconsForReassignedAgents(reassignment.reassigned)) {
        entry.revision++;
        entry.dirty = true;
        scheduleFlush(projectPath, entry);
      }
    }
  }
  return entry.agents;
}

async function writeAgents(projectPath: string, agents: DurableAgentConfig[]): Promise<void> {
  let entry = configCache.get(projectPath);
  if (!entry) {
    entry = {
      agents,
      baselineAgents: cloneAgents(agents),
      diskSnapshot: JSON.stringify(agents),
      agentsById: buildAgentsById(agents),
      dirty: true,
      revision: 0,
      flushTimer: null,
      pendingFlush: null,
    };
    configCache.set(projectPath, entry);
  } else {
    // Log when agent count decreases — this is the signal for data loss
    const prevCount = entry.agents.length;
    if (agents.length < prevCount) {
      const newIds = new Set(agents.map((a) => a.id));
      const removed = entry.agents.filter((a) => !newIds.has(a.id));
      appLog('core:agent-config', 'warn', `Agent count decreased: ${prevCount} → ${agents.length}`, {
        meta: {
          projectPath,
          removedAgents: removed.map((a) => ({ id: a.id, name: a.name })),
          caller: new Error().stack?.split('\n').slice(1, 4).map((l) => l.trim()),
        },
      });
    }
    entry.agents = agents;
    entry.agentsById = buildAgentsById(agents);
  }
  if (entry.identity) syncAgentIdClaims(entry.identity, agents);
  entry.revision++;
  entry.dirty = true;
  scheduleFlush(projectPath, entry);
  notifyAgentConfigChanged(projectPath);
}

/** Called with the project path after a project's agent list may have changed. */
export type AgentConfigChangeListener = (projectPath: string) => void;
const agentConfigChangeListeners = new Set<AgentConfigChangeListener>();

/**
 * Listen for changes to a project's agents: every in-app write, and external
 * edits seen by the agents.json watcher. Listeners run synchronously and may
 * be called for writes that changed nothing they care about. Returns an
 * unsubscribe function.
 */
export function onAgentConfigChanged(listener: AgentConfigChangeListener): () => void {
  agentConfigChangeListeners.add(listener);
  return () => { agentConfigChangeListeners.delete(listener); };
}

function notifyAgentConfigChanged(projectPath: string): void {
  for (const listener of agentConfigChangeListeners) {
    try {
      listener(projectPath);
    } catch (err) {
      // telemetry-exempt: logged; a listener's failure must not fail the config write
      appLog('core:agent-config', 'warn', 'Agent config change listener failed', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/** Flush any pending writes for a project path immediately */
export async function flushAgentConfig(projectPath: string): Promise<void> {
  const entry = configCache.get(projectPath);
  if (entry) {
    await flushEntry(projectPath, entry);
  }
}

/**
 * Flush all pending writes across all project paths. Drains until stable: a
 * project mutated (or first cached) while earlier flushes were in flight is
 * flushed too, so callers about to exit never lose an acknowledged change.
 */
export async function flushAllAgentConfigs(): Promise<void> {
  const dirtyEntries = [...configCache.entries()].filter(([, e]) => e.dirty);
  if (dirtyEntries.length > 0) {
    appLog('core:agent-config', 'info', `Flushing ${dirtyEntries.length} dirty cache(s) on shutdown`, {
      meta: { projects: dirtyEntries.map(([p, e]) => ({ path: p, agentCount: e.agents.length })) },
    });
  }
  do {
    await Promise.all([...configCache.entries()].map(([projectPath, entry]) => flushEntry(projectPath, entry)));
  } while ([...configCache.values()].some((entry) => entry.dirty || entry.pendingFlush));
}

/** Clear the in-memory cache (cancels pending timers without flushing). Useful for tests. */
export function clearAgentConfigCache(projectPath?: string): void {
  const entries = projectPath ? [configCache.get(projectPath)].filter((entry): entry is CacheEntry => !!entry) : configCache.values();
  for (const entry of entries) {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
  }
  if (projectPath) {
    configCache.delete(projectPath);
    configWatchers.get(projectPath)?.close();
    configWatchers.delete(projectPath);
  } else {
    configCache.clear();
    agentIdOwners.clear();
    creationRecoveries.clear();
    for (const [watchedProjectPath, watcher] of configWatchers) {
      watcher.close();
      configWatchers.delete(watchedProjectPath);
    }
  }
}

export async function listDurable(projectPath: string): Promise<DurableAgentConfig[]> {
  await readAgents(projectPath);
  // Interrupted creations are settled (cleaned up and marked failed) before the first list (#2226).
  await creationRecoveries.get(projectPath);
  return readAgents(projectPath);
}

/**
 * Check if a backup exists with more agents than the current config.
 * Returns the backup agent list if recovery is available, or null otherwise.
 */
export async function getBackupInfo(projectPath: string): Promise<{ backupAgents: DurableAgentConfig[]; currentCount: number } | null> {
  const backupPath = agentsBackupPath(projectPath);
  if (!(await pathExists(backupPath))) return null;

  try {
    const raw = await fsp.readFile(backupPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const backupAgents = Array.isArray(parsed) ? parsed.filter(isAgentRecord) : [];
    if (backupAgents.length === 0) return null;

    const currentAgents = await readAgents(projectPath);
    // Recovery is available if the backup has more agents
    if (backupAgents.length > currentAgents.length) {
      return { backupAgents, currentCount: currentAgents.length };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Restore agents from the backup file, merging any agents that are in the
 * backup but missing from the current config.
 */
export async function restoreFromBackup(projectPath: string): Promise<{ restoredCount: number; agents: DurableAgentConfig[] }> {
  const backupPath = agentsBackupPath(projectPath);
  if (!(await pathExists(backupPath))) {
    return { restoredCount: 0, agents: await readAgents(projectPath) };
  }

  const raw = await fsp.readFile(backupPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const backupAgents = Array.isArray(parsed) ? parsed.filter(isAgentRecord) : [];
  if (backupAgents.length === 0) {
    return { restoredCount: 0, agents: await readAgents(projectPath) };
  }

  const currentAgents = await readAgents(projectPath);
  const currentIds = new Set(currentAgents.map((a) => a.id));

  // Merge: add agents from backup that are missing from current
  const missing = backupAgents.filter((a) => !currentIds.has(a.id));
  if (missing.length === 0) {
    return { restoredCount: 0, agents: currentAgents };
  }

  // A backup can predate an ID reassignment (or hold another project's ID).
  const entryIdentity = configCache.get(projectPath)?.identity ?? await projectIdentity(projectPath);
  const reassignment = reassignForeignAgentIds(projectPath, entryIdentity, missing);
  if (reassignment) await copyIconsForReassignedAgents(reassignment.reassigned);
  const merged = [...currentAgents, ...(reassignment?.agents ?? missing)];
  await writeAgents(projectPath, merged);
  // Flush immediately — don't risk losing the restore
  const entry = configCache.get(projectPath);
  if (entry) await flushEntry(projectPath, entry);

  appLog('core:agent-config', 'info', `Restored ${missing.length} agent(s) from backup`, {
    meta: { projectPath, restoredIds: merged.slice(currentAgents.length).map((a) => a.id) },
  });

  return { restoredCount: missing.length, agents: merged };
}

export async function getDurableConfig(projectPath: string, agentId: string): Promise<DurableAgentConfig | null> {
  const { agentsById } = await readAgentsEntry(projectPath);
  return agentsById.get(agentId) ?? null;
}

export async function updateDurableConfig(
  projectPath: string,
  agentId: string,
  updates: DurableConfigUpdates,
): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return;
  if (updates.quickAgentDefaults !== undefined) {
    agent.quickAgentDefaults = updates.quickAgentDefaults;
  }
  if (updates.orchestrator !== undefined) {
    agent.orchestrator = updates.orchestrator;
  }
  if (updates.model !== undefined) {
    if (updates.model && updates.model !== 'default') {
      agent.model = updates.model;
    } else {
      delete agent.model;
    }
  }
  if (updates.freeAgentMode !== undefined) {
    if (updates.freeAgentMode) {
      agent.freeAgentMode = true;
    } else {
      delete agent.freeAgentMode;
    }
  }
  if (updates.clubhouseModeOverride !== undefined) {
    if (updates.clubhouseModeOverride) {
      agent.clubhouseModeOverride = true;
    } else {
      delete agent.clubhouseModeOverride;
    }
  }
  if (updates.lastSleep !== undefined) {
    if (updates.lastSleep) {
      agent.lastSleep = updates.lastSleep;
    } else {
      delete agent.lastSleep;
    }
  }
  if (updates.lastSessionId !== undefined) {
    if (updates.lastSessionId) {
      agent.lastSessionId = updates.lastSessionId;
    } else {
      delete agent.lastSessionId;
    }
  }
  if (updates.mcpIds !== undefined) {
    if (updates.mcpIds && updates.mcpIds.length > 0) {
      agent.mcpIds = updates.mcpIds;
    } else {
      delete agent.mcpIds;
    }
  }
  if (updates.mcpConfigs !== undefined) {
    if (updates.mcpConfigs && Object.keys(updates.mcpConfigs).length > 0) {
      agent.mcpConfigs = updates.mcpConfigs;
    } else {
      delete agent.mcpConfigs;
    }
  }
  if (updates.runtimeMode !== undefined) {
    if (updates.runtimeMode === 'chat' || updates.runtimeMode === 'terminal') {
      agent.runtimeMode = updates.runtimeMode;
    } else {
      delete agent.runtimeMode;
    }
  }
  if (updates.idleSleep !== undefined) {
    const idleSleep = normalizeIdleSleep(updates.idleSleep);
    if (idleSleep === 'inherit') {
      delete agent.idleSleep;
    } else {
      agent.idleSleep = idleSleep;
    }
  }
  if (updates.mission !== undefined) {
    if (updates.mission) {
      agent.mission = updates.mission;
    } else {
      delete agent.mission;
    }
  }
  if (updates.persona !== undefined) {
    if (updates.persona) {
      agent.persona = updates.persona;
    } else {
      delete agent.persona;
    }
  }
  if (updates.buildCommand !== undefined) {
    if (updates.buildCommand) {
      agent.buildCommand = updates.buildCommand;
    } else {
      delete agent.buildCommand;
    }
  }
  if (updates.testCommand !== undefined) {
    if (updates.testCommand) {
      agent.testCommand = updates.testCommand;
    } else {
      delete agent.testCommand;
    }
  }
  if (updates.lintCommand !== undefined) {
    if (updates.lintCommand) {
      agent.lintCommand = updates.lintCommand;
    } else {
      delete agent.lintCommand;
    }
  }
  if (updates.sourceControlProvider !== undefined) {
    if (updates.sourceControlProvider) {
      agent.sourceControlProvider = updates.sourceControlProvider;
    } else {
      delete agent.sourceControlProvider;
    }
  }
  await writeAgents(projectPath, agents);
  // A running chat session picks the new timeout up now.
  if (updates.idleSleep !== undefined) setAgentIdleSleep(agentId, agent.idleSleep);
}

/** Persist the last CLI session ID for a durable agent */
export async function updateSessionId(projectPath: string, agentId: string, sessionId: string | null): Promise<void> {
  await updateDurableConfig(projectPath, agentId, { lastSessionId: sessionId });
}

/** Maximum number of sessions to keep in history per agent */
const MAX_SESSION_HISTORY = 50;

/** Add or update a session entry in the agent's session history */
export async function addSessionEntry(projectPath: string, agentId: string, entry: SessionInfo): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return;

  if (!agent.sessionHistory) {
    agent.sessionHistory = [];
  }

  // Update existing entry or add new one
  const idx = agent.sessionHistory.findIndex((s) => s.sessionId === entry.sessionId);
  if (idx >= 0) {
    // Preserve existing friendly name if the new entry doesn't have one
    const existing = agent.sessionHistory[idx];
    agent.sessionHistory[idx] = {
      ...entry,
      friendlyName: entry.friendlyName || existing.friendlyName,
    };
  } else {
    agent.sessionHistory.push(entry);
  }

  // Trim to max size (keep most recent)
  if (agent.sessionHistory.length > MAX_SESSION_HISTORY) {
    agent.sessionHistory.sort((a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    );
    agent.sessionHistory = agent.sessionHistory.slice(0, MAX_SESSION_HISTORY);
  }

  // Also update lastSessionId
  agent.lastSessionId = entry.sessionId;

  await writeAgents(projectPath, agents);
}

/**
 * Record that a session is active now: add it to the agent's session history
 * (started now) if it isn't there, otherwise move its lastActiveAt, keeping
 * when it started and its friendly name. Also sets lastSessionId. Chat runs
 * call this when the CLI reports its native session id and when the session
 * ends, so chat sessions reach the Sessions picker the way terminal runs do.
 */
export async function touchSessionEntry(projectPath: string, agentId: string, sessionId: string, at: string = new Date().toISOString()): Promise<void> {
  const { agentsById } = await readAgentsEntry(projectPath);
  const existing = agentsById.get(agentId)?.sessionHistory?.find((s) => s.sessionId === sessionId);
  await addSessionEntry(projectPath, agentId, {
    sessionId,
    startedAt: existing?.startedAt ?? at,
    lastActiveAt: at,
    ...(existing?.friendlyName && { friendlyName: existing.friendlyName }),
  });
}

/** Set or clear the friendly name for a session */
export async function updateSessionName(projectPath: string, agentId: string, sessionId: string, friendlyName: string | null): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent?.sessionHistory) return;

  const session = agent.sessionHistory.find((s) => s.sessionId === sessionId);
  if (!session) return;

  if (friendlyName) {
    session.friendlyName = friendlyName;
  } else {
    delete session.friendlyName;
  }

  await writeAgents(projectPath, agents);
}

/**
 * Drop session history entries by id, and the resume id if it is one of them
 * (sessions the CLI's own store no longer has, #2156).
 */
export async function removeSessionEntries(projectPath: string, agentId: string, sessionIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return;
  const drop = new Set(sessionIds);
  const before = agent.sessionHistory?.length ?? 0;
  if (agent.sessionHistory) agent.sessionHistory = agent.sessionHistory.filter((s) => !drop.has(s.sessionId));
  const clearedResume = !!agent.lastSessionId && drop.has(agent.lastSessionId);
  if (clearedResume) agent.lastSessionId = null;
  if ((agent.sessionHistory?.length ?? 0) === before && !clearedResume) return;
  await writeAgents(projectPath, agents);
}

/** Get session history for an agent */
export async function getSessionHistory(projectPath: string, agentId: string): Promise<SessionInfo[]> {
  const agent = await getDurableConfig(projectPath, agentId);
  if (!agent?.sessionHistory) return [];
  // Return sorted by most recently active first
  return [...agent.sessionHistory].sort((a, b) =>
    new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  );
}

// ---------------------------------------------------------------------------
// Durable creation (#2226)
//
// beginDurableCreation checks the request, reserves the folder and branch,
// writes the agent's record in a 'creating' state (flushed to disk before any
// git work) and starts the slow part at once: resolving the base commit,
// `git branch`, `git worktree add` (which can take a minute on a big repo) and
// the instruction/config injection. It returns once the record exists, with a
// `done` promise for the rest. createDurable awaits `done`; the asynchronous
// API (agent-creation.ts) returns the id straight away.
//
// Ownership: Clubhouse only ever deletes a folder it made itself (claimed with
// a non-recursive mkdir before `worktree add`, recorded as folderOwned), and a
// branch it created itself (recorded for good on the agent as branchOwned +
// branchStartSha, and deleted only while it still points at that commit and
// is not checked out). A creation interrupted by a quit is found on the
// next launch (once per project) and cleaned up, unless another live Clubhouse
// instance owns it.
// ---------------------------------------------------------------------------

/** Thrown by a creation's `done` when it was cancelled; the agent's record and partial worktree are gone. */
export class DurableCreationCancelledError extends Error {
  constructor() {
    super('Agent creation was cancelled.');
    this.name = 'DurableCreationCancelledError';
  }
}

/** Identifies this Clubhouse process in the creations it owns. */
const INSTANCE_ID = randomUUID();
/** How often a running creation refreshes its heartbeat. */
const CREATION_HEARTBEAT_MS = 30_000;
/** A creation whose owner has not beaten for this long is treated as interrupted. */
const CREATION_LEASE_MS = 2 * 60_000;

export type DurableCreationListener = (event: DurableCreationEvent) => void;
const creationListeners = new Set<DurableCreationListener>();

/** Listen to the stages of asynchronous creations, and to interrupted ones found at launch. Returns the unsubscribe function. */
export function onDurableCreationEvent(listener: DurableCreationListener): () => void {
  creationListeners.add(listener);
  return () => { creationListeners.delete(listener); };
}

function emitCreationEvent(
  projectPath: string,
  agentId: string,
  stage: DurableCreationStage,
  startMs: number,
  config?: DurableAgentConfig,
  reason?: string,
): void {
  const event: DurableCreationEvent = {
    projectPath,
    agentId,
    stage,
    at: new Date().toISOString(),
    elapsedMs: Math.max(0, Date.now() - startMs),
    ...(reason !== undefined ? { reason } : {}),
    ...(config ? { config } : {}),
  };
  for (const listener of creationListeners) {
    try {
      listener(event);
    } catch {
      // telemetry-exempt: one listener never breaks the others or the creation.
    }
  }
}

interface ActiveCreation {
  /** The project path the creation was started with (the cache key). */
  projectPath: string;
  controller: AbortController;
  /** Settles once the creation has finished, including its cleanup. */
  settled: Promise<void>;
}

/** Creations in progress in this process, by agent id. */
const activeCreations = new Map<string, ActiveCreation>();
/** Agent folders (resolved paths) claimed by creations in progress. */
const reservedFolders = new Set<string>();
/** Branches claimed by creations in progress, as `<resolved project>\0<branch>`. */
const reservedBranches = new Set<string>();

function branchKey(projectPath: string, branch: string): string {
  return `${path.resolve(projectPath)}\0${branch}`;
}

/** True while an agent's creation is still running in this process. */
export function isDurableCreationActive(agentId: string): boolean {
  return activeCreations.has(agentId);
}

/** What the worktree of a new agent will be. */
interface WorktreePlan {
  folder: string;
  wtPath: string;
  branch: string;
  /** True when the caller named the branch; an existing branch is then refused. */
  branchNamed: boolean;
  branchFrom?: string;
}

/**
 * Why `ref` cannot be used as the place a new branch starts from, or null.
 * Looser than a branch name (tags, remote branches and commit ids are fine),
 * but never empty, option-like, or containing whitespace or control characters.
 * git resolves it to a commit before anything is created.
 */
export function branchFromProblem(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length === 0) return 'Enter the branch or commit to start from.';
  if (ref.length > 256) return 'Keep the branch to start from to 256 characters or fewer.';
  if (ref.startsWith('-')) return 'The branch to start from cannot start with -.';
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(ref)) return 'The branch to start from cannot contain spaces or control characters.';
  return null;
}

/**
 * Validate the folder and branch (#2221 rules) and the branch-from of a new
 * agent's worktree. Throws (tagged `validation`) on the first bad one.
 */
function planDurableWorktree(projectPath: string, name: string, options: DurableWorktreeOptions): WorktreePlan {
  try {
    const folder = options.folderName ?? name;
    const wtPath = resolveAgentWorktreePath(projectPath, folder);
    const branch = options.branchName ?? `${folder}/standby`;
    assertAgentGitName(branch, 'branch');
    if (options.branchFrom !== undefined) {
      const problem = branchFromProblem(options.branchFrom);
      if (problem) throw new Error(problem);
    }
    return {
      folder, wtPath, branch,
      branchNamed: options.branchName !== undefined,
      ...(options.branchFrom !== undefined ? { branchFrom: options.branchFrom } : {}),
    };
  } catch (err) {
    throw tagError(err, 'validation');
  }
}

export interface DurableCreationRunOptions {
  /** Send the stages to onDurableCreationEvent listeners (the asynchronous API does). */
  emitEvents?: boolean;
  /**
   * Keep a failed agent's record, marked failed with the reason, instead of
   * removing it. The asynchronous API keeps it so the failure stays visible;
   * createDurable removes it because its caller gets the error instead.
   */
  keepFailedRecord?: boolean;
  /** Extra injection into the new worktree after the project defaults (e.g. a persona). Failures are logged, not fatal. */
  inject?: (config: DurableAgentConfig) => Promise<void>;
}

export interface DurableCreationHandle {
  /** The new agent's record, in the 'creating' state. */
  config: DurableAgentConfig;
  /** Resolves with the ready config; rejects with the failure, or DurableCreationCancelledError. */
  done: Promise<DurableAgentConfig>;
}

function cloneAgent(agent: DurableAgentConfig): DurableAgentConfig {
  return JSON.parse(JSON.stringify(agent)) as DurableAgentConfig;
}

/** Apply `fn` to an agent's record and save it. Returns a copy of the result, or null when the record is gone. */
async function mutateAgentRecord(
  projectPath: string,
  agentId: string,
  fn: (agent: DurableAgentConfig) => void,
  { flush = false }: { flush?: boolean } = {},
): Promise<DurableAgentConfig | null> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return null;
  fn(agent);
  await writeAgents(projectPath, agents);
  if (flush) await flushAgentConfig(projectPath);
  return cloneAgent(agent);
}

async function removeAgentRecord(projectPath: string, agentId: string): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  if (!agentsById.has(agentId)) return;
  await writeAgents(projectPath, agents.filter((a) => a.id !== agentId));
  await flushAgentConfig(projectPath);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether deleting this agent may delete its branch: only a branch Clubhouse
 * created. Records from before #2226 have no `branchOwned`; their branch counts
 * as owned only when it is the default `<folder>/standby`.
 */
export function ownsAgentBranch(agent: Pick<DurableAgentConfig, 'branch' | 'branchOwned' | 'worktreePath'>): boolean {
  if (!agent.branch) return false;
  if (agent.branchOwned !== undefined) return agent.branchOwned;
  return !!agent.worktreePath && agent.branch === `${path.basename(agent.worktreePath)}/standby`;
}

const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

/**
 * Delete an agent's branch if Clubhouse owns it (see ownsAgentBranch), and
 * only while it still points at the commit it was created at, so work on it
 * is never lost. The delete is `git branch -D`, which refuses a branch that is
 * checked out anywhere (a user may have checked out an agent's branch);
 * then the branch is kept. Records from before #2226 have no start commit and
 * use `git branch -d`, which also refuses unmerged work. A recorded start
 * commit that is not a full SHA is not trusted. Returns true when the branch
 * was deleted. Never throws.
 */
export async function deleteAgentBranch(
  projectPath: string,
  agent: Pick<DurableAgentConfig, 'id' | 'branch' | 'branchOwned' | 'branchStartSha' | 'worktreePath'>,
): Promise<boolean> {
  const branch = agent.branch;
  const keep = (why: string, error?: unknown) => {
    appLog('core:agent-config', error ? 'warn' : 'info', `Kept the agent branch: ${why}`, {
      meta: { agentId: agent.id, branch, ...(error ? { error: errorMessage(error) } : {}) },
    });
    return false;
  };
  if (!branch) return false;
  if (!ownsAgentBranch(agent)) return keep('Clubhouse did not create it');
  if (agent.branchStartSha !== undefined && !SHA_PATTERN.test(agent.branchStartSha)) return keep('its recorded start commit is not a commit id');
  try {
    if (agent.branchStartSha) {
      let tip = '';
      try {
        tip = (await execGitFileAsync(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath)).trim();
      } catch {
        // telemetry-exempt: a branch that no longer exists has nothing to delete.
        return false;
      }
      if (tip.toLowerCase() !== agent.branchStartSha.toLowerCase()) return keep('it has moved since the agent was created');
      await execGitFileAsync(['branch', '-D', '--', branch], projectPath);
    } else {
      await execGitFileAsync(['branch', '-d', '--', branch], projectPath);
    }
    return true;
  } catch (err) {
    // telemetry-exempt: a kept branch is the safe outcome; logged for diagnosis.
    return keep('git refused (checked out, or unmerged)', err);
  }
}

/**
 * Remove what a creation made: the worktree registration and folder (only
 * when `ownsFolder`), and the branch (only when owned). Best effort; failures
 * are logged. Never runs a repository-wide prune.
 */
async function cleanupPartialWorktree(
  projectPath: string,
  part: Pick<DurableAgentConfig, 'id' | 'branch' | 'branchOwned' | 'branchStartSha'> & { wtPath?: string; ownsFolder: boolean },
): Promise<void> {
  const hasGit = await isInsideGitRepo(projectPath).catch(() => false);
  if (part.wtPath && part.ownsFolder) {
    if (hasGit) {
      try {
        await execGitFileAsync(['worktree', 'remove', '--force', '--', part.wtPath], projectPath);
      } catch {
        // telemetry-exempt: usually not registered yet; the folder removal below covers it.
      }
    }
    try {
      await fsp.rm(part.wtPath, { recursive: true, force: true });
    } catch {
      // telemetry-exempt: best-effort cleanup; the creation's own failure is what gets reported.
    }
  }
  if (hasGit && part.branchOwned && part.branchStartSha && SHA_PATTERN.test(part.branchStartSha)) {
    await deleteAgentBranch(projectPath, { id: part.id, branch: part.branch, branchOwned: true, branchStartSha: part.branchStartSha });
  }
}

/** True when `wtPath` is exactly an agent folder of this project, so cleanup may delete it. */
function isOwnAgentFolder(projectPath: string, wtPath: string): boolean {
  try {
    return path.resolve(resolveAgentWorktreePath(projectPath, path.basename(wtPath))) === path.resolve(wtPath);
  } catch {
    // telemetry-exempt: an invalid folder is simply not ours to delete.
    return false;
  }
}

/** A folder name close to `folder` that no agent and no creation in progress uses. */
function suggestFolderName(projectPath: string, folder: string, agents: DurableAgentConfig[]): string {
  const used = new Set(agents.map((a) => a.worktreePath && path.resolve(a.worktreePath)).filter(Boolean));
  for (let n = 2; n < 100; n++) {
    const candidate = `${folder}-${n}`;
    if (validateAgentGitName(candidate, 'folder')) break;
    const resolved = path.resolve(agentsDir(projectPath), candidate);
    if (!used.has(resolved) && !reservedFolders.has(resolved)) return candidate;
  }
  return `${folder.slice(0, 50)}-${Date.now().toString(36).slice(-6)}`;
}

/**
 * Check a new agent's request, reserve its folder and branch, write its record
 * in the 'creating' state, and start the git work. Resolves once the record
 * exists. Throws (tagged `validation`) for a bad name, folder, branch or base,
 * or a folder or branch already in use.
 */
export async function beginDurableCreation(
  projectPath: string,
  params: StartDurableCreationParams,
  options: DurableCreationRunOptions = {},
): Promise<DurableCreationHandle> {
  const { name, color, model, orchestrator, freeAgentMode, mcpIds, mcpConfigs, persona } = params;
  const useWorktree = params.useWorktree !== false;
  // The folder and branch come from the request; refuse bad ones before anything touches disk.
  const plan = useWorktree ? planDurableWorktree(projectPath, name, params) : undefined;

  await ensureDir(clubhouseDir(projectPath));
  await ensureGitignore(projectPath);

  // Inherit freeAgentMode from project defaults if not explicitly set
  const projectDefaults = await readProjectAgentDefaults(projectPath);
  const effectiveFreeAgent = freeAgentMode ?? (projectDefaults.freeAgentMode || undefined);
  const folderOnDisk = plan ? await pathExists(plan.wtPath) : false;
  const agents = await readAgents(projectPath);

  // From here until the record is in the cache there is no await, so two
  // creations in this process cannot both claim the same folder or branch.
  const parentAgentId = params.parentAgentId;
  if (parentAgentId !== undefined) {
    const parent = agents.find((a) => a.id === parentAgentId);
    if (!parent) throw tagError(new Error('Parent agent not found'), 'validation');
    if (isDisposedAgent(parent)) throw tagError(new Error('A disposed agent cannot be a parent'), 'validation');
  }
  let folderKey: string | undefined;
  let branchReservation: string | undefined;
  if (plan) {
    const target = path.resolve(plan.wtPath);
    const where = `.clubhouse/agents/${plan.folder}`;
    const usedByAgent = agents.some((a) => a.worktreePath && path.resolve(a.worktreePath) === target);
    let problem: string | null = null;
    if (reservedFolders.has(target)) problem = `Another agent is being created in ${where}.`;
    else if (usedByAgent) problem = `Another agent already uses ${where}.`;
    else if (folderOnDisk) problem = `The folder ${where} is left over from a removed agent. Delete it, or`;
    if (problem) {
      const suggestion = suggestFolderName(projectPath, plan.folder, agents);
      throw tagError(new Error(problem.endsWith(', or')
        ? `${problem} use another folder name such as "${suggestion}".`
        : `${problem} Use another folder name such as "${suggestion}".`), 'validation');
    }
    const key = branchKey(projectPath, plan.branch);
    if (reservedBranches.has(key) || agents.some((a) => a.branch === plan.branch && !!a.worktreePath)) {
      throw tagError(new Error(`Another agent already uses the branch "${plan.branch}". Choose another branch name.`), 'validation');
    }
    reservedFolders.add(target);
    reservedBranches.add(key);
    folderKey = target;
    branchReservation = key;
  }

  let id = generateDurableId();
  while (agentIdOwners.has(id)) id = generateDurableId();
  const startedAt = new Date().toISOString();
  const config: DurableAgentConfig = {
    id,
    name,
    color,
    ...(plan ? { branch: plan.branch, worktreePath: plan.wtPath, branchOwned: false } : {}),
    createdAt: startedAt,
    ...(model && model !== 'default' ? { model } : {}),
    ...(orchestrator ? { orchestrator } : {}),
    ...(effectiveFreeAgent ? { freeAgentMode: effectiveFreeAgent } : {}),
    ...(mcpIds && mcpIds.length > 0 ? { mcpIds } : {}),
    ...(mcpConfigs && Object.keys(mcpConfigs).length > 0 ? { mcpConfigs } : {}),
    ...(persona ? { persona } : {}),
    // Helpers (#2224): a new agent can start life as a helper of another.
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    ...(parentAgentId !== undefined && params.disposable ? { disposable: true } : {}),
    creation: {
      state: 'creating',
      startedAt,
      stage: 'config_created',
      owner: { pid: process.pid, instanceId: INSTANCE_ID },
      heartbeatAt: startedAt,
    },
  };

  let markSettled!: () => void;
  const active: ActiveCreation = {
    projectPath,
    controller: new AbortController(),
    settled: new Promise<void>((resolve) => { markSettled = resolve; }),
  };
  const release = () => {
    activeCreations.delete(id);
    if (folderKey) reservedFolders.delete(folderKey);
    if (branchReservation) reservedBranches.delete(branchReservation);
    markSettled();
  };
  activeCreations.set(id, active);
  agents.push(config);
  try {
    await writeAgents(projectPath, agents);
    // With a worktree to make, the record must be on disk before git starts,
    // so a quit mid-create is found on the next launch. Without one there is
    // nothing to clean up, so the usual debounced write is enough.
    if (plan) await flushAgentConfig(projectPath);
  } catch (err) {
    await removeAgentRecord(projectPath, id).catch(() => { /* telemetry-exempt: the original error is rethrown */ });
    release();
    throw err;
  }

  const snapshot = cloneAgent(config);
  // Started here, never left to the caller, so a reservation cannot leak.
  const done = runDurableCreation(projectPath, snapshot, plan, active, options).finally(release);
  // A caller that only wants the id need not handle `done`; failures are logged and reported as events.
  done.catch(() => { /* telemetry-exempt: reported by the creation itself */ });
  return { config: snapshot, done };
}

/**
 * Claim a new agent's folder with a non-recursive mkdir, which fails if the
 * folder exists: that is atomic across processes, so a folder another process
 * made is never ours (and never cleaned up). `git worktree add` accepts the
 * empty folder. Returns true, or throws when the folder is taken.
 */
async function claimAgentFolder(wtPath: string, folder: string): Promise<true> {
  await ensureDir(path.dirname(wtPath));
  try {
    await fsp.mkdir(wtPath);
  } catch (err) {
    // telemetry-exempt: rethrown below, typed for telemetry.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw tagError(new Error(`The folder .clubhouse/agents/${folder} appeared while the agent was being created. Use another folder name.`), 'worktree_failed');
    }
    throw err;
  }
  return true;
}

async function runDurableCreation(
  projectPath: string,
  initial: DurableAgentConfig,
  plan: WorktreePlan | undefined,
  active: ActiveCreation,
  options: DurableCreationRunOptions,
): Promise<DurableAgentConfig> {
  const id = initial.id;
  const startMs = Date.parse(initial.createdAt) || Date.now();
  const { signal } = active.controller;
  const emit = (stage: DurableCreationStage, config?: DurableAgentConfig, reason?: string) => {
    if (options.emitEvents) emitCreationEvent(projectPath, id, stage, startMs, config, reason);
  };
  const checkCancelled = () => {
    if (signal.aborted) throw new DurableCreationCancelledError();
  };
  /** Update the record; a missing record means it was removed mid-create. */
  const update = async (fn: (agent: DurableAgentConfig) => void, flush = false) => {
    const updated = await mutateAgentRecord(projectPath, id, fn, { flush });
    if (!updated) throw new DurableCreationCancelledError();
    return updated;
  };
  const reachStage = (stage: DurableCreationStage) => update((agent) => {
    if (agent.creation) agent.creation = { ...agent.creation, stage };
  });

  // Heartbeat, so another Clubhouse instance can tell this creation is alive.
  const heartbeat = setInterval(() => {
    void mutateAgentRecord(projectPath, id, (agent) => {
      if (agent.creation?.state === 'creating') agent.creation.heartbeatAt = new Date().toISOString();
    }, { flush: true }).catch(() => { /* telemetry-exempt: a missed beat only shortens the lease */ });
  }, CREATION_HEARTBEAT_MS);
  heartbeat.unref?.();

  let ownsFolder = false;
  let branchOwned = false;
  let branchStartSha: string | undefined;
  emit('config_created', cloneAgent(initial));

  try {
    if (plan) {
      checkCancelled();
      const { wtPath, branch, branchFrom } = plan;
      const hasGit = await isInsideGitRepo(projectPath);
      if (hasGit) {
        // Ensure repo has at least one commit (required for branching/worktrees)
        try {
          await execGitFileAsync(['rev-parse', 'HEAD'], projectPath);
        } catch {
          // Empty repo with no commits — bootstrap with an initial commit
          // Include .gitignore which ensureGitignore() has already created/updated
          appLog('core:agent-config', 'info', 'Empty repository detected, creating initial commit for worktree support', {
            meta: { agentName: initial.name, projectPath },
          });
          try {
            const gitignorePath = path.join(projectPath, '.gitignore');
            if (await pathExists(gitignorePath)) {
              await execGitFileAsync(['add', '--', '.gitignore'], projectPath);
            }
            await execGitFileAsync(['commit', '--allow-empty', '-m', 'Clubhouse - Initial Commit'], projectPath);
          } catch (commitErr) {
            appLog('core:agent-config', 'warn', 'Failed to create initial commit in empty repository', {
              meta: { agentName: initial.name, projectPath, error: errorMessage(commitErr) },
            });
          }
        }
        checkCancelled();

        // Resolve the base to a commit first, so the branch starts exactly there.
        const base = branchFrom ?? 'HEAD';
        let sha = '';
        try {
          sha = (await execGitFileAsync(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], projectPath, undefined, signal)).trim();
        } catch {
          // telemetry-exempt: an unresolvable base is reported just below, typed for telemetry.
          checkCancelled();
        }
        if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
          throw tagError(new Error(branchFrom !== undefined
            ? `Could not find "${branchFrom}" to start the branch from.`
            : 'Could not find the current commit to start the branch from.'), branchFrom !== undefined ? 'validation' : 'worktree_failed');
        }

        try {
          await execGitFileAsync(['branch', '--no-track', '--', branch, sha], projectPath, undefined, signal);
          branchOwned = true;
          branchStartSha = sha;
        } catch (err) {
          checkCancelled();
          if (plan.branchNamed || branchFrom !== undefined) {
            // Until there is an explicit adopt mode, a named or based branch must be new.
            throw tagError(new Error(`Could not create the branch "${branch}": ${errorMessage(err).trim()}. Choose a branch name that does not exist yet.`), 'validation');
          }
          // The default <folder>/standby branch may already exist; the worktree reuses it, but it is not ours to delete.
        }
        // Record ownership for good before the slow step, so cleanup after a quit (and any later delete) knows.
        await update((agent) => {
          agent.branchOwned = branchOwned;
          if (branchStartSha) agent.branchStartSha = branchStartSha;
          else delete agent.branchStartSha;
        }, true);
        checkCancelled();

        ownsFolder = await claimAgentFolder(wtPath, plan.folder);
        // Saved before the slow step, so recovery after a quit removes only a folder this creation made.
        await update((agent) => { if (agent.creation) agent.creation.folderOwned = true; }, true);
        checkCancelled();
        try {
          // Only spanned under an active agent create flow (Phase 4), never orphaned.
          await stepUnderFlow('clubhouse.git.worktree_add', () => execGitFileAsync(['worktree', 'add', '--', wtPath, branch], projectPath, undefined, signal));
        } catch (err) {
          checkCancelled();
          const errMsg = errorMessage(err);
          appLog('core:agent-config', 'error', 'Git worktree creation failed', {
            meta: { agentName: initial.name, branch, worktreePath: wtPath, error: errMsg },
          });
          throw tagError(new Error(
            `Failed to create git worktree for "${plan.folder}": ${errMsg}. ` +
            `The branch "${branch}" may already be checked out elsewhere, or the path may conflict with an existing worktree. ` +
            'Run `git worktree list` and `git worktree prune` to investigate.'
          ), 'worktree_failed');
        }
      } else {
        ownsFolder = await claimAgentFolder(wtPath, plan.folder);
      }
      checkCancelled();
      emit('worktree_added', await reachStage('worktree_added'));
    }

    // Apply project-level defaults as snapshots into the new worktree
    checkCancelled();
    if (initial.worktreePath) {
      const worktreePath = initial.worktreePath;
      try {
        const provider = await resolveOrchestrator(projectPath, initial.orchestrator);
        await applyAgentDefaults(
          worktreePath,
          projectPath,
          (wt, content) => provider.writeInstructions(wt, content),
          provider.conventions,
        );
      } catch (err) {
        appLog('core:agent-config', 'warn', 'Failed to apply project agent defaults', {
          meta: { agentName: initial.name, error: errorMessage(err) },
        });
      }
    }
    if (options.inject) {
      try {
        await options.inject(cloneAgent(initial));
      } catch (err) {
        // telemetry-exempt: injection is best effort, like the project defaults above; logged.
        appLog('core:agent-config', 'warn', 'Failed to inject config into the new agent', {
          meta: { agentName: initial.name, error: errorMessage(err) },
        });
      }
    }
    checkCancelled();
    emit('config_injected', await reachStage('config_injected'));

    checkCancelled();
    // Flushed when a worktree was made, so a quit right after ready is not mistaken for an interrupted creation.
    const ready = await update((agent) => { delete agent.creation; }, !!plan);
    emit('ready', ready);
    return ready;
  } catch (err) {
    const cancelled = signal.aborted || err instanceof DurableCreationCancelledError;
    if (plan) {
      await cleanupPartialWorktree(projectPath, { id, wtPath: plan.wtPath, ownsFolder, branch: plan.branch, branchOwned, branchStartSha });
    }
    if (cancelled) {
      await removeAgentRecord(projectPath, id);
      appLog('core:agent-config', 'info', 'Agent creation cancelled and cleaned up', { meta: { agentId: id } });
      emit('cancelled');
      throw new DurableCreationCancelledError();
    }
    const reason = errorMessage(err);
    if (options.keepFailedRecord) {
      const failed = await mutateAgentRecord(projectPath, id, (agent) => {
        // The worktree and any branch Clubhouse made are gone; a later delete must not touch anything.
        delete agent.worktreePath;
        delete agent.branch;
        delete agent.branchOwned;
        delete agent.branchStartSha;
        const { owner: _owner, heartbeatAt: _beat, folderOwned: _folder, ...rest } = agent.creation ?? { startedAt: initial.createdAt, state: 'failed' as const };
        agent.creation = { ...rest, state: 'failed', stage: 'failed', reason };
      }, { flush: true });
      emit('failed', failed ?? undefined, reason);
    } else {
      await removeAgentRecord(projectPath, id);
      emit('failed', undefined, reason);
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Stop a creation in progress and wait until it has cleaned up. Returns false
 * when the agent is not being created in this process.
 */
async function stopDurableCreation(projectPath: string, agentId: string): Promise<boolean> {
  const active = activeCreations.get(agentId);
  if (!active || path.resolve(active.projectPath) !== path.resolve(projectPath)) return false;
  active.controller.abort();
  await active.settled;
  return true;
}

/**
 * Cancel a creation in progress: stops git, removes the partial worktree and
 * any branch Clubhouse made, and removes the agent's record. If the creation
 * finished (ready or failed) just before the cancel took effect, the agent is
 * deleted the normal way instead. Resolves false when the agent is not being
 * created.
 */
export async function cancelDurableCreation(projectPath: string, agentId: string): Promise<boolean> {
  const active = activeCreations.get(agentId);
  if (!(await stopDurableCreation(projectPath, agentId))) return false;
  if ((await readAgentsEntry(active!.projectPath)).agentsById.has(agentId)) {
    await deleteDurable(active!.projectPath, agentId);
  }
  return true;
}

export const INTERRUPTED_CREATION_REASON = 'Creation was interrupted because Clubhouse closed before the worktree was ready.';

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // telemetry-exempt: EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when another live Clubhouse instance is running this creation, so it must be left alone. */
function isCreationOwnedElsewhere(creation: DurableAgentCreation): boolean {
  const owner = creation.owner;
  if (!owner || owner.instanceId === INSTANCE_ID) return false;
  // This process is not running it (it is not in activeCreations), whatever instance id it carries.
  if (owner.pid === process.pid || !isPidAlive(owner.pid)) return false;
  const beat = Date.parse(creation.heartbeatAt ?? creation.startedAt);
  return Number.isFinite(beat) && Date.now() - beat < CREATION_LEASE_MS;
}

function isInterruptedCreation(agent: DurableAgentConfig): boolean {
  return agent.creation?.state === 'creating' && !activeCreations.has(agent.id) && !isCreationOwnedElsewhere(agent.creation);
}

/**
 * Clean up creations a previous run of the app left in the 'creating' state
 * (it quit mid-create): remove the partial worktree and the branch if
 * Clubhouse made it, mark the agent failed and report a 'failed' event.
 * Creations running in this process, or in another live Clubhouse instance,
 * are left alone. Returns the ids it marked failed.
 */
export async function recoverInterruptedCreations(projectPath: string): Promise<string[]> {
  const agents = await readAgents(projectPath);
  const stale = agents.filter(isInterruptedCreation);
  const recovered: string[] = [];
  for (const agent of stale) {
    const { id, worktreePath, branch } = agent;
    appLog('core:agent-config', 'warn', 'Cleaning up an agent creation interrupted by a quit', {
      meta: { projectPath, agentId: id, worktreePath, branch },
    });
    await cleanupPartialWorktree(projectPath, {
      id,
      wtPath: worktreePath,
      ownsFolder: agent.creation?.folderOwned === true && !!worktreePath && isOwnAgentFolder(projectPath, worktreePath),
      branch,
      branchOwned: agent.branchOwned === true,
      branchStartSha: agent.branchStartSha,
    });
    const updated = await mutateAgentRecord(projectPath, id, (record) => {
      if (!isInterruptedCreation(record) || !record.creation) return;
      delete record.worktreePath;
      delete record.branch;
      delete record.branchOwned;
      delete record.branchStartSha;
      const { owner: _owner, heartbeatAt: _beat, folderOwned: _folder, ...rest } = record.creation;
      record.creation = { ...rest, state: 'failed', stage: 'failed', reason: INTERRUPTED_CREATION_REASON };
    }, { flush: true });
    if (updated?.creation?.state === 'failed' && updated.creation.reason === INTERRUPTED_CREATION_REASON) {
      recovered.push(id);
      emitCreationEvent(projectPath, id, 'failed', Date.parse(updated.createdAt) || Date.now(), updated, INTERRUPTED_CREATION_REASON);
    }
  }
  return recovered;
}

/** Recovery of interrupted creations, run once per project per launch (not on every cache reload). */
const creationRecoveries = new Map<string, Promise<void>>();

function scheduleCreationRecovery(projectPath: string, agents: DurableAgentConfig[]): void {
  if (creationRecoveries.has(projectPath)) return;
  if (!agents.some((a) => a.creation?.state === 'creating')) {
    creationRecoveries.set(projectPath, Promise.resolve());
    return;
  }
  creationRecoveries.set(projectPath, recoverInterruptedCreations(projectPath).then((): void => undefined, (err: unknown): void => {
    appLog('core:agent-config', 'error', 'Failed to clean up an interrupted agent creation', {
      meta: { projectPath, error: errorMessage(err) },
    });
  }));
}

/** Refuse an operation that needs a finished agent while its creation runs. */
function creationInProgressResult(agentId: string): DeleteResult | null {
  return activeCreations.has(agentId)
    ? { ok: false, message: 'This agent is still being created. Cancel it, or wait until it is ready.' }
    : null;
}

export async function createDurable(
  projectPath: string,
  name: string,
  color: string,
  model?: string,
  useWorktree: boolean = true,
  orchestrator?: OrchestratorId,
  freeAgentMode?: boolean,
  mcpIds?: string[],
  mcpConfigs?: Record<string, Record<string, string>>,
  persona?: string,
  worktreeOptions: DurableWorktreeOptions = {},
): Promise<DurableAgentConfig> {
  const handle = await beginDurableCreation(projectPath, {
    ...worktreeOptions,
    name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, mcpConfigs, persona,
  }, { keepFailedRecord: false });
  // The caller gets the error, so a failed agent leaves no record behind.
  return handle.done;
}

export async function reorderDurable(projectPath: string, orderedIds: string[]): Promise<DurableAgentConfig[]> {
  const agents = await readAgents(projectPath);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const result: DurableAgentConfig[] = [];
  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (agent) {
      result.push(agent);
      byId.delete(id);
    }
  }
  // Append any agents not in orderedIds (shouldn't happen, but safe)
  for (const agent of byId.values()) {
    result.push(agent);
  }
  await writeAgents(projectPath, result);
  return result;
}

export async function renameDurable(projectPath: string, agentId: string, newName: string): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return;
  agent.name = newName;
  await writeAgents(projectPath, agents);
}

export async function updateDurable(
  projectPath: string,
  agentId: string,
  updates: { name?: string; color?: string; icon?: string | null; emoji?: string | null },
): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return;
  if (updates.name !== undefined) agent.name = updates.name;
  if (updates.color !== undefined) agent.color = updates.color;
  if (updates.icon !== undefined) {
    if (updates.icon === null || updates.icon === '') {
      delete agent.icon;
    } else {
      agent.icon = updates.icon;
    }
  }
  if (updates.emoji !== undefined) {
    if (updates.emoji === null || updates.emoji === '') {
      delete agent.emoji;
    } else {
      agent.emoji = updates.emoji;
      // Emoji and image icon are mutually exclusive — clear image when emoji is set
      delete agent.icon;
    }
  }
  await writeAgents(projectPath, agents);
}

export async function deleteDurable(projectPath: string, agentId: string): Promise<void> {
  // Deleting an agent that is still being created stops the creation, which
  // cleans up after itself. If it finished just before the stop took effect,
  // the record is still there and is deleted below like any other (#2226).
  await stopDurableCreation(projectPath, agentId);
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return;

  if (agent.worktreePath) await removeAgentWorktree(projectPath, agent);

  // Re-read: the cache may have been replaced while git ran.
  const agents = await readAgents(projectPath);
  await writeAgents(projectPath, releaseHelpersOf(agents.filter((a) => a.id !== agentId), agentId));
}

/** Remove an agent's worktree, its branch and any leftover directory. */
async function removeAgentWorktree(projectPath: string, agent: DurableAgentConfig): Promise<void> {
  const worktreePath = agent.worktreePath;
  if (!worktreePath) return;
  const agentId = agent.id;
  const hasGit = await isInsideGitRepo(projectPath);
  if (hasGit) {
    try {
      await stepUnderFlow('clubhouse.git.worktree_remove', () => execGitFileAsync(['worktree', 'remove', '--force', '--', worktreePath], projectPath));
    } catch (err) {
      appLog('core:agent-config', 'warn', 'Git worktree removal failed, will clean up manually', {
        meta: {
          agentId, worktreePath,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // Remove the folder if it is still there. A failure (EBUSY on Windows)
  // throws before the branch goes, so a half-removed agent keeps its branch.
  if (await pathExists(worktreePath)) {
    await fsp.rm(worktreePath, { recursive: true, force: true });
  }

  // Delete the branch only if Clubhouse created it, it has not moved and it is
  // not checked out anywhere (#2226). Never throws; a kept branch is logged.
  if (hasGit && agent.branch) {
    await deleteAgentBranch(projectPath, agent);
  }
}

async function detectBaseBranch(projectPath: string): Promise<string> {
  // Try main, then master, then fallback to HEAD
  for (const candidate of ['main', 'master']) {
    try {
      await execGitFileAsync(['rev-parse', '--verify', candidate], projectPath);
      return candidate;
    } catch {
      // not found
    }
  }
  return 'HEAD';
}

function parseStatusLine(line: string): GitStatusFile {
  const xy = line.substring(0, 2);
  const filePath = line.substring(3);
  const staged = xy[0] !== ' ' && xy[0] !== '?';
  return { path: filePath, status: xy.trim(), staged };
}

function parseLogLine(line: string): GitLogEntry | null {
  // format: hash|shortHash|subject|author|date
  const parts = line.split('|');
  if (parts.length < 5) return null;
  return {
    hash: parts[0],
    shortHash: parts[1],
    subject: parts.slice(2, -2).join('|'), // subject may contain |
    author: parts[parts.length - 2],
    date: parts[parts.length - 1],
  };
}

export async function getWorktreeStatus(projectPath: string, agentId: string): Promise<WorktreeStatus> {
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) {
    return { isValid: false, branch: '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
  }

  // Non-worktree agents have no worktree to inspect
  if (!agent.worktreePath) {
    return { isValid: false, branch: '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
  }

  const wt = agent.worktreePath;
  const [wtExists, wtGitExists] = await Promise.all([
    pathExists(wt),
    pathExists(path.join(wt, '.git')),
  ]);
  if (!wtExists || !wtGitExists) {
    return { isValid: false, branch: agent.branch || '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
  }

  // Run git status, base branch detection, and remote check in parallel
  const [statusResult, base, remoteResult] = await Promise.all([
    execGitFileAsync(['status', '--porcelain'], wt).catch(() => ''),
    detectBaseBranch(projectPath),
    execGitFileAsync(['remote'], wt).catch(() => ''),
  ]);

  // Parse uncommitted files (use trimEnd to preserve leading status chars like " M")
  const uncommittedFiles = statusResult.trimEnd()
    ? statusResult.trimEnd().split('\n').filter(Boolean).map(parseStatusLine)
    : [];

  // Get unpushed commits (depends on base branch result)
  let unpushedCommits: GitLogEntry[] = [];
  try {
    const logOut = await execGitFileAsync(
      ['log', `${base}..HEAD`, '--format=%H|%h|%s|%an|%ai'],
      wt,
    );
    unpushedCommits = logOut.trim().split('\n').filter(Boolean)
      .map(parseLogLine)
      .filter((e): e is GitLogEntry => e !== null);
  } catch {
    // ignore
  }

  return {
    isValid: true,
    branch: agent.branch || '',
    uncommittedFiles,
    unpushedCommits,
    hasRemote: remoteResult.trim().length > 0,
  };
}

async function saveWorktreeBeforeDelete(
  wt: string,
  agent: DurableAgentConfig,
  options: { commitMessage: string; branch?: string },
): Promise<void> {
  // Stage all and commit
  await execGitFileAsync(['add', '-A'], wt);
  try {
    await execGitFileAsync(['commit', '-m', options.commitMessage], wt);
  } catch {
    // Nothing to commit is OK
  }

  // Push if remote exists
  try {
    const remoteOut = await execGitFileAsync(['remote'], wt);
    const branch = options.branch ?? agent.branch;
    // A branch read back from agents.json predates strict names; never let
    // one be read as an option or a src:dst refspec.
    if (remoteOut.trim() && branch && !branch.startsWith('-') && !branch.includes(':')) {
      await execGitFileAsync(['push', '-u', '--', 'origin', branch], wt);
    }
  } catch (pushErr) {
    const branch = options.branch ?? agent.branch;
    const isCleanupBranch = options.branch !== undefined;
    appLog(
      'core:agent-config',
      'warn',
      `Push failed during ${isCleanupBranch ? 'cleanup-branch deletion' : 'delete-commit-push'}, work saved locally`,
      {
        meta: {
          agentId: agent.id,
          ...(isCleanupBranch ? { cleanupBranch: branch } : { branch }),
          error: pushErr instanceof Error ? pushErr.message : String(pushErr),
        },
      },
    );
  }
}

export async function deleteCommitAndPush(projectPath: string, agentId: string): Promise<DeleteResult> {
  // Mid-create there is no finished worktree to save; deleting cancels the creation (#2226).
  if (isDurableCreationActive(agentId)) {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Creation cancelled' };
  }
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const wt = agent.worktreePath;
  if (!wt) {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Deleted (no worktree)' };
  }

  try {
    await saveWorktreeBeforeDelete(wt, agent, { commitMessage: 'Save work before deletion' });
  } catch (err: any) {
    appLog('core:agent-config', 'error', 'Failed to commit during agent deletion', {
      meta: { agentId, error: err.message },
    });
    return { ok: false, message: err.message || 'Failed to commit' };
  }

  await deleteDurable(projectPath, agentId);
  return { ok: true, message: 'Committed, pushed, and deleted' };
}

/**
 * The branch an agent's work is saved to before deletion: `<name>/cleanup`.
 * Names can be renamed freely after creation, so when that is not a valid
 * branch name this falls back to the standby branch's prefix, then the id.
 */
export function cleanupBranchFor(agent: Pick<DurableAgentConfig, 'id' | 'name' | 'branch'>): string {
  const standbyPrefix = agent.branch?.endsWith('/standby') ? agent.branch.slice(0, -'/standby'.length) : undefined;
  for (const prefix of [agent.name, standbyPrefix, agent.id]) {
    if (!prefix) continue;
    const candidate = `${prefix}/cleanup`;
    if (!validateAgentGitName(candidate, 'branch')) return candidate;
  }
  return 'clubhouse-agent/cleanup';
}

export async function deleteWithCleanupBranch(projectPath: string, agentId: string): Promise<DeleteResult> {
  // Mid-create there is no finished worktree to save; deleting cancels the creation (#2226).
  if (isDurableCreationActive(agentId)) {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Creation cancelled' };
  }
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const wt = agent.worktreePath;
  if (!wt) {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Deleted (no worktree)' };
  }

  const cleanupBranch = cleanupBranchFor(agent);

  try {
    // Create and checkout cleanup branch
    try {
      await execGitFileAsync(['checkout', '-b', cleanupBranch], wt);
    } catch {
      // Branch may exist, try just checking out
      await execGitFileAsync(['checkout', cleanupBranch], wt);
    }

    await saveWorktreeBeforeDelete(wt, agent, {
      commitMessage: 'Cleanup: save work before agent deletion',
      branch: cleanupBranch,
    });
  } catch (err: any) {
    appLog('core:agent-config', 'error', 'Failed to create cleanup branch during agent deletion', {
      meta: { agentId, error: err.message },
    });
    return { ok: false, message: err.message || 'Failed to create cleanup branch' };
  }

  await deleteDurable(projectPath, agentId);
  return { ok: true, message: `Saved to ${cleanupBranch} and deleted` };
}

export async function deleteSaveAsPatch(projectPath: string, agentId: string, savePath: string): Promise<DeleteResult> {
  // Mid-create there is no finished worktree to save; deleting cancels the creation (#2226).
  if (isDurableCreationActive(agentId)) {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Creation cancelled' };
  }
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const wt = agent.worktreePath;
  if (!wt) {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Deleted (no worktree)' };
  }

  const base = await detectBaseBranch(projectPath);

  try {
    let patchContent = '';

    const largeBuffer = 50 * 1024 * 1024;

    // Get diff of uncommitted changes
    try {
      const diff = await execGitFileAsync(['diff', 'HEAD'], wt, largeBuffer);
      if (diff.trim()) {
        patchContent += `# Uncommitted changes\n${diff}\n`;
      }
    } catch {
      // ignore
    }

    // Get untracked files diff
    try {
      const untracked = await execGitFileAsync(['ls-files', '--others', '--exclude-standard'], wt);
      if (untracked.trim()) {
        // Stage untracked so we can diff them
        await execGitFileAsync(['add', '-A'], wt);
        const stagedDiff = await execGitFileAsync(['diff', '--cached'], wt, largeBuffer);
        if (stagedDiff.trim()) {
          patchContent += `# Staged changes (including untracked)\n${stagedDiff}\n`;
        }
        // Reset staging
        await execGitFileAsync(['reset', 'HEAD'], wt);
      }
    } catch {
      // ignore
    }

    // Get format-patch for committed but not in base
    try {
      const patches = await execGitFileAsync(
        ['format-patch', `${base}..HEAD`, '--stdout'],
        wt,
        largeBuffer,
      );
      if (patches.trim()) {
        patchContent += `# Commits since ${base}\n${patches}\n`;
      }
    } catch {
      // ignore
    }

    if (!patchContent) {
      patchContent = '# No changes to export\n';
    }

    await fsp.writeFile(savePath, patchContent, 'utf-8');
  } catch (err: any) {
    appLog('core:agent-config', 'error', 'Failed to save patch file during agent deletion', {
      meta: { agentId, savePath, error: err.message },
    });
    return { ok: false, message: err.message || 'Failed to save patch' };
  }

  await deleteDurable(projectPath, agentId);
  return { ok: true, message: `Patch saved to ${savePath}` };
}

export async function deleteForce(projectPath: string, agentId: string): Promise<DeleteResult> {
  try {
    await deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Force deleted' };
  } catch (err: any) {
    return { ok: false, message: err.message || 'Failed to force delete' };
  }
}

export async function deleteUnregister(projectPath: string, agentId: string): Promise<DeleteResult> {
  // "Remove from list" keeps the files, which a creation in progress cannot promise (#2226).
  const creating = creationInProgressResult(agentId);
  if (creating) return creating;
  const agents = await readAgents(projectPath);
  const filtered = agents.filter((a) => a.id !== agentId);
  await writeAgents(projectPath, releaseHelpersOf(filtered, agentId));
  return { ok: true, message: 'Removed from agents list (files left on disk)' };
}

// --- Helpers (#2224) ---
//
// A helper is a durable agent whose `parentAgentId` names another durable
// agent in the same project. Disposing a helper removes its worktree and
// branch but keeps its row and session history with `disposedAt` set.

/**
 * Release the live helpers of a deleted agent so none is left pointing at a
 * parent that no longer exists. Callers that want the helpers disposed do that
 * first through resolveHelpersForDelete; this is the safe fallback for every
 * other delete path (remote, plugins). Returns `agents` with copies where
 * something changed.
 */
function releaseHelpersOf(agents: DurableAgentConfig[], deletedId: string): DurableAgentConfig[] {
  const released: string[] = [];
  const result = agents.map((agent) => {
    if (agent.parentAgentId !== deletedId || isDisposedAgent(agent)) return agent;
    released.push(agent.id);
    const copy = { ...agent };
    delete copy.parentAgentId;
    delete copy.disposable;
    return copy;
  });
  if (released.length > 0) {
    appLog('core:agent-config', 'info', `Kept ${released.length} helper(s) of a deleted agent as ordinary agents`, {
      meta: { deletedId, released },
    });
  }
  return released.length > 0 ? result : agents;
}

/**
 * The helpers of an agent in sidebar order: direct ones, or every live helper
 * below it with `recursive`. Disposed ones only when asked (never recursive).
 */
export async function listHelpers(
  projectPath: string,
  agentId: string,
  options: { includeDisposed?: boolean; recursive?: boolean } = {},
): Promise<DurableAgentConfig[]> {
  const agents = await readAgents(projectPath);
  if (options.recursive) return liveDescendants(agents, agentId);
  return agents.filter((a) => a.parentAgentId === agentId && (options.includeDisposed || !isDisposedAgent(a)));
}

/** The agent's parent, or null for a top-level agent or a parent that no longer exists. */
export async function getParentAgent(projectPath: string, agentId: string): Promise<DurableAgentConfig | null> {
  const { agentsById } = await readAgentsEntry(projectPath);
  const parentId = agentsById.get(agentId)?.parentAgentId;
  return parentId ? agentsById.get(parentId) ?? null : null;
}

/**
 * Make `agentId` a helper of `parentAgentId`, or a top-level agent when the
 * parent is null. Rejects self-parenting, unknown agents, cycles and disposed
 * agents on either side. `disposable` is set alongside when given; releasing
 * a helper always clears it.
 */
export async function setParentAgent(
  projectPath: string,
  agentId: string,
  parentAgentId: string | null,
  options: { disposable?: boolean } = {},
): Promise<void> {
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) throw new Error('Agent not found');
  if (isDisposedAgent(agent)) throw new Error('A disposed agent cannot change parent');
  if (parentAgentId === null) {
    delete agent.parentAgentId;
    delete agent.disposable;
  } else {
    const error = parentLinkError(agents, agentId, parentAgentId);
    if (error) throw new Error(error);
    if (isDisposedAgent(agentsById.get(parentAgentId))) throw new Error('A disposed agent cannot be a parent');
    agent.parentAgentId = parentAgentId;
    if (options.disposable !== undefined) {
      if (options.disposable) agent.disposable = true;
      else delete agent.disposable;
    }
  }
  await writeAgents(projectPath, agents);
}

/** A `git rev-list --count` result. Any failure throws, so a check never reads as zero. */
async function gitCount(args: string[], cwd: string): Promise<number> {
  const out = await execGitFileAsync(args, cwd);
  const n = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`git ${args.join(' ')} returned "${out.trim()}"`);
  return n;
}

/** Whether a local branch exists. Throws when git can't answer. */
async function localBranchExists(branch: string, cwd: string): Promise<boolean> {
  try {
    await execGitFileAsync(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
    return true;
  } catch (err) {
    // show-ref exits 1 for a missing ref; anything else is a failure.
    if ((err as { code?: unknown } | null)?.code === 1) return false;
    throw err;
  }
}

/** The local base branch (main, then master), or null when neither exists. */
async function findLocalBase(cwd: string): Promise<string | null> {
  for (const candidate of ['main', 'master']) {
    if (await localBranchExists(candidate, cwd)) return `refs/heads/${candidate}`;
  }
  return null;
}

/**
 * Why a helper's creation stops it being disposed, or null. A creation running
 * in this process does not block: disposeAgent cancels it and lets it settle
 * first. One still marked 'creating' that this process is not running (another
 * Clubhouse instance owns it) blocks, since its worktree is not ours to touch.
 */
export function helperCreationBlock(agent: DurableAgentConfig): string | null {
  return agent.creation?.state === 'creating' && !isDurableCreationActive(agent.id)
    ? 'it is still being created in another Clubhouse window'
    : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The delete status checks for an agent before its worktree and branch go:
 * uncommitted files, commits deleting the branch would destroy, and commits
 * not merged into the base branch. Fails closed: if any check can't run, the
 * result carries `error` and disposal is blocked.
 */
export async function getDisposeChecks(
  projectPath: string,
  agentId: string,
  options: { alsoDisposed?: string[] } = {},
): Promise<HelperDisposeChecks> {
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return { dirty: 0, unpushed: 0, unmerged: null, error: 'agent not found' };
  const creating = helperCreationBlock(agent);
  if (creating) return { dirty: 0, unpushed: 0, unmerged: null, error: creating };
  if (isDisposedAgent(agent)) return { dirty: 0, unpushed: 0, unmerged: 0 };
  // A creation running here has made nothing anyone worked in; disposing cancels it.
  if (isDurableCreationActive(agentId)) return { dirty: 0, unpushed: 0, unmerged: 0 };
  try {
    return await runDisposeChecks(projectPath, agent, agentsById, options.alsoDisposed ?? []);
  } catch (err) {
    // telemetry-exempt: the failure blocks disposal and reaches the user in the result
    return { dirty: 0, unpushed: 0, unmerged: null, error: `couldn't check, ${errorText(err)}` };
  }
}

/**
 * Whether `dir` is inside a git work tree. Only git's own "not a git
 * repository" answer means no; any other failure throws, so a check that
 * can't run never reads as "no repository, nothing to lose".
 */
async function probeGitWorkTree(dir: string): Promise<boolean> {
  try {
    return (await execGitFileAsync(['rev-parse', '--is-inside-work-tree'], dir)).trim() === 'true';
  } catch (err) {
    if (/not a git repository/i.test(errorText(err))) return false;
    throw err;
  }
}

/**
 * The local branches disposing an agent deletes or leaves without a
 * worktree: its recorded branch and the branch its worktree has checked out.
 * Throws when git can't answer.
 */
async function branchesDisposedWith(agent: DurableAgentConfig): Promise<string[]> {
  const names = agent.branch ? [agent.branch] : [];
  const wt = agent.worktreePath;
  if (wt && await pathExists(path.join(wt, '.git'))) {
    try {
      const head = (await execGitFileAsync(['symbolic-ref', '--quiet', 'HEAD'], wt)).trim();
      if (head.startsWith('refs/heads/')) names.push(head.slice('refs/heads/'.length));
    } catch (err) {
      // symbolic-ref exits 1 on a detached HEAD; anything else is a failure.
      if ((err as { code?: unknown } | null)?.code !== 1) throw err;
    }
  }
  return names;
}

/**
 * `alsoDisposed` names the branches of every other helper disposed in the
 * same cascade. Work that survives only on one of those branches is not safe.
 */
async function runDisposeChecks(
  projectPath: string,
  agent: DurableAgentConfig,
  agentsById: Map<string, DurableAgentConfig>,
  alsoDisposed: string[],
): Promise<HelperDisposeChecks> {
  const wt = agent.worktreePath;
  const wtExists = !!wt && await pathExists(wt);
  if (wtExists && !(await pathExists(path.join(wt, '.git')))) {
    throw new Error(`${wt} is not a git worktree`);
  }
  if (!wtExists && !(await probeGitWorkTree(projectPath))) {
    // No worktree and no repository: nothing on disk to lose.
    return { dirty: 0, unpushed: 0, unmerged: 0 };
  }
  const cwd = wtExists ? wt : projectPath;

  // The refs disposal would destroy: the worktree's HEAD and the agent's
  // branch. `own` holds their short branch names, left out of --branches.
  const refs: string[] = [];
  const own: string[] = [];
  if (agent.branch && await localBranchExists(agent.branch, cwd)) {
    refs.push(`refs/heads/${agent.branch}`);
    own.push(agent.branch);
  }
  let dirty = 0;
  if (wtExists) {
    refs.push('HEAD');
    const status = await execGitFileAsync(['status', '--porcelain'], cwd);
    dirty = status.split('\n').filter((line) => line.trim()).length;
    try {
      const head = (await execGitFileAsync(['symbolic-ref', '--quiet', 'HEAD'], cwd)).trim();
      if (head.startsWith('refs/heads/')) own.push(head.slice('refs/heads/'.length));
    } catch (err) {
      // symbolic-ref exits 1 on a detached HEAD; anything else is a failure.
      if ((err as { code?: unknown } | null)?.code !== 1) throw err;
    }
  }
  if (refs.length === 0) {
    // The worktree folder and the branch are both gone already.
    return { dirty: 0, unpushed: 0, unmerged: 0 };
  }

  const remotes = (await execGitFileAsync(['remote'], cwd)).trim();
  if (remotes) {
    // A remote with no remote-tracking refs was never fetched; every commit
    // would read as unpushed, which says nothing useful.
    const tracking = (await execGitFileAsync(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'], cwd)).trim();
    if (!tracking) throw new Error('its remote has never been fetched');
  }
  // With a remote, pushed work survives disposal. Without one, work survives
  // only on a local branch that stays: not this agent's, and not one of the
  // other helpers disposed with it.
  const excluded = [...new Set([...own, ...alsoDisposed])];
  const unpushed = remotes
    ? await gitCount(['rev-list', '--count', ...refs, '--not', '--remotes'], cwd)
    : await gitCount(['rev-list', '--count', ...refs, '--not', ...excluded.map((r) => `--exclude=${r}`), '--branches'], cwd);

  // Information only: merged into main/master, else into the parent's branch.
  const parentBranch = agent.parentAgentId ? agentsById.get(agent.parentAgentId)?.branch : undefined;
  let base = await findLocalBase(cwd);
  if (!base && parentBranch && await localBranchExists(parentBranch, cwd)) base = `refs/heads/${parentBranch}`;
  const unmerged = base ? await gitCount(['rev-list', '--count', ...refs, '--not', base], cwd) : null;

  return { dirty, unpushed, unmerged };
}

/** Disposal loses nothing only when the worktree is clean, all work is saved and every check ran. */
function hasWorkAtRisk(checks: HelperDisposeChecks): boolean {
  return checks.dirty > 0 || checks.unpushed > 0 || !!checks.error;
}

/** Remove a helper's worktree and branch and mark it disposed, keeping its row. */
async function disposeAgent(projectPath: string, agentId: string): Promise<void> {
  // A creation still running is cancelled and settled first (#2226): a
  // cancelled creation removes its partial worktree, owned branch and row, so
  // nothing is left to dispose. One that finished just before the cancel took
  // effect is disposed below like any other.
  await stopDurableCreation(projectPath, agentId);
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent || isDisposedAgent(agent)) return;
  const creating = helperCreationBlock(agent);
  if (creating) throw new Error(`${agent.name} can't be disposed because ${creating}`);
  if (agent.worktreePath) await removeAgentWorktree(projectPath, agent);

  // Re-read: the cache may have been replaced while git ran.
  const { agents, agentsById: current } = await readAgentsEntry(projectPath);
  const row = current.get(agentId);
  if (!row) return;
  row.disposedAt = new Date().toISOString();
  delete row.worktreePath;
  await writeAgents(projectPath, agents);
}

/**
 * Dispose one helper after the delete status checks. With work at risk it
 * changes nothing and returns the checks, unless `force` is set.
 */
export async function disposeHelper(
  projectPath: string,
  agentId: string,
  options: { force?: boolean } = {},
): Promise<DeleteResult & { checks?: HelperDisposeChecks }> {
  const { agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };
  if (isDisposedAgent(agent)) return { ok: true, message: 'Already disposed' };
  const checks = await getDisposeChecks(projectPath, agentId);
  if (!options.force && hasWorkAtRisk(checks)) {
    return {
      ok: false,
      message: checks.error ? `${agent.name} wasn't disposed (${checks.error})` : `${agent.name} has work that disposing would lose`,
      checks,
    };
  }
  try {
    await disposeAgent(projectPath, agentId);
  } catch (err) {
    // telemetry-exempt: returned to the caller as a failed result
    return { ok: false, message: errorText(err), checks };
  }
  return { ok: true, message: 'Disposed', checks };
}

/** Every live helper below an agent, nearest first. */
function liveDescendants(agents: DurableAgentConfig[], agentId: string): DurableAgentConfig[] {
  const result: DurableAgentConfig[] = [];
  const seen = new Set<string>([agentId]);
  const queue = [agentId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const agent of agents) {
      if (agent.parentAgentId !== parentId || seen.has(agent.id)) continue;
      seen.add(agent.id);
      queue.push(agent.id);
      if (!isDisposedAgent(agent)) result.push(agent);
    }
  }
  return result;
}

/**
 * Settle an orchestrator's helpers before it is deleted, so none is orphaned.
 * - 'dispose' disposes every live helper below it, helpers of helpers too.
 *   It runs the delete status checks first; if any helper has uncommitted,
 *   unpushed or unmerged work it changes nothing and returns `blocked`,
 *   unless `force` is set.
 * - 'keep' makes its direct helpers ordinary durable agents. Their own
 *   helpers stay attached to them.
 * `dryRun` runs the checks and reports what would happen without changing
 * anything. The caller stops running helpers first and deletes the
 * orchestrator after.
 */
export async function resolveHelpersForDelete(
  projectPath: string,
  agentId: string,
  choice: HelperDeleteChoice,
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<HelperCascadeResult> {
  const agents = await readAgents(projectPath);
  if (!agents.some((a) => a.id === agentId)) return { ok: false, message: 'Agent not found' };

  if (choice === 'keep') {
    const released = await listHelpers(projectPath, agentId);
    if (released.length === 0) return { ok: true, message: 'No helpers', helperIds: [] };
    if (options.dryRun) return { ok: true, message: `Would keep ${released.length} helper(s)`, helperIds: released.map((a) => a.id) };
    await writeAgents(projectPath, releaseHelpersOf(await readAgents(projectPath), agentId));
    return { ok: true, message: `Kept ${released.length} helper(s)`, helperIds: released.map((a) => a.id) };
  }

  const helpers = liveDescendants(agents, agentId);
  if (helpers.length === 0) return { ok: true, message: 'No helpers', helperIds: [] };

  // Every branch this cascade removes, so one helper's work kept only on a
  // sibling's branch is not counted as safe.
  const disposedBranches = new Set<string>();
  const branchErrors = new Map<string, string>();
  for (const helper of helpers) {
    try {
      for (const name of await branchesDisposedWith(helper)) disposedBranches.add(name);
    } catch (err) {
      // telemetry-exempt: blocks this helper below and reaches the user in the result
      branchErrors.set(helper.id, `couldn't check, ${errorText(err)}`);
    }
  }
  const checked = await Promise.all(helpers.map(async (helper) => {
    const branchError = branchErrors.get(helper.id);
    return {
      helper,
      checks: branchError
        ? { dirty: 0, unpushed: 0, unmerged: null, error: branchError }
        : await getDisposeChecks(projectPath, helper.id, { alsoDisposed: [...disposedBranches] }),
    };
  }));
  const blocked: HelperDisposeBlock[] = checked
    .filter(({ checks }) => hasWorkAtRisk(checks))
    .map(({ helper, checks }) => ({ agentId: helper.id, name: helper.name, checks }));
  if (blocked.length > 0 && !options.force) {
    return {
      ok: false,
      message: blocked.length === 1
        ? `${blocked[0].name} has work that disposing would lose, or couldn't be checked`
        : `${blocked.length} helpers have work that disposing would lose, or couldn't be checked`,
      blocked,
    };
  }

  if (options.dryRun) {
    return { ok: true, message: `Would dispose ${helpers.length} helper(s)`, helperIds: helpers.map((a) => a.id) };
  }
  const disposed: string[] = [];
  const failed: NonNullable<HelperCascadeResult['failed']> = [];
  for (const helper of helpers) {
    try {
      await disposeAgent(projectPath, helper.id);
      disposed.push(helper.id);
    } catch (err) {
      // telemetry-exempt: logged and returned in `failed`; the delete flow reports it
      failed.push({ agentId: helper.id, name: helper.name, reason: errorText(err) });
      appLog('core:agent-config', 'error', 'Failed to dispose a helper', {
        meta: { agentId: helper.id, parentId: agentId, error: errorText(err) },
      });
    }
  }
  if (failed.length > 0) {
    return {
      ok: false,
      message: `Disposed ${disposed.length} of ${helpers.length} helpers`,
      helperIds: disposed,
      failed,
    };
  }
  return { ok: true, message: `Disposed ${helpers.length} helper(s)`, helperIds: disposed };
}

// --- Agent icon storage ---

async function getAgentIconsDir(): Promise<string> {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  const dir = path.join(app.getPath('home'), dirName, 'agent-icons');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Save a cropped PNG data URL as the agent's icon. Returns the filename. */
export async function saveAgentIcon(projectPath: string, agentId: string, dataUrl: string): Promise<string> {
  await removeAgentIconFile(agentId);

  const filename = `${agentId}.png`;
  const dest = path.join(await getAgentIconsDir(), filename);

  // Strip data URL prefix and write binary
  const base64 = dataUrl.replace(/^data:image\/[\w+.-]+;base64,/, '');
  await fsp.writeFile(dest, Buffer.from(base64, 'base64'));

  // Update agents.json
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (agent) {
    agent.icon = filename;
    await writeAgents(projectPath, agents);
  }

  return filename;
}

/** Read an agent icon file and return a data URL, or null if not found. */
export async function readAgentIconData(filename: string): Promise<string | null> {
  const filePath = path.join(await getAgentIconsDir(), filename);
  if (!(await pathExists(filePath))) return null;
  const data = await fsp.readFile(filePath);
  return `data:image/png;base64,${data.toString('base64')}`;
}

/** Remove the icon file for an agent. */
export async function removeAgentIconFile(agentId: string): Promise<void> {
  const iconsDir = await getAgentIconsDir();
  try {
    const files = await fsp.readdir(iconsDir);
    for (const file of files) {
      if (file.startsWith(agentId + '.')) {
        await fsp.unlink(path.join(iconsDir, file));
      }
    }
  } catch {
    // icons dir may not exist yet
  }
}

/** Remove agent icon metadata and file. */
export async function removeAgentIcon(projectPath: string, agentId: string): Promise<void> {
  await removeAgentIconFile(agentId);
  const { agents, agentsById } = await readAgentsEntry(projectPath);
  const agent = agentsById.get(agentId);
  if (agent) {
    delete agent.icon;
    await writeAgents(projectPath, agents);
  }
}

// ---------------------------------------------------------------------------
// Recovery audit — compares running agents against disk configs
// ---------------------------------------------------------------------------

export interface RecoveryAuditResult {
  projectPath: string;
  diskAgents: Array<{ id: string; name: string }>;
  runningAgentIds: string[];
  missingFromDisk: string[];
  ghostAgents: Array<{ id: string; name: string }>;
  duplicateIds: string[];
  healthy: boolean;
}

/**
 * Audit agent state for a project by comparing disk configs against a set of
 * running agent IDs (provided by the caller, since the agent registry lives
 * in a different module).
 *
 * Returns a structured result with discrepancies. Logs a summary.
 */
export async function auditRecovery(
  projectPath: string,
  runningAgentIds: Set<string>,
): Promise<RecoveryAuditResult> {
  const agents = await readAgents(projectPath);

  const diskAgents = agents.map((a) => ({ id: a.id, name: a.name }));
  const diskIds = new Set(agents.map((a) => a.id));

  // Running agents not found in disk config
  const missingFromDisk = [...runningAgentIds].filter((id) => !diskIds.has(id));

  // Ghost agents: name is missing or matches the raw ID pattern
  const ghostAgents = agents
    .filter((a) => !a.name || a.name === a.id || DURABLE_ID_PATTERN.test(a.name))
    .map((a) => ({ id: a.id, name: a.name || '(missing)' }));

  // Duplicate IDs
  const idCounts = new Map<string, number>();
  for (const a of agents) {
    idCounts.set(a.id, (idCounts.get(a.id) || 0) + 1);
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  const healthy = missingFromDisk.length === 0 && ghostAgents.length === 0 && duplicateIds.length === 0;

  const result: RecoveryAuditResult = {
    projectPath,
    diskAgents,
    runningAgentIds: [...runningAgentIds],
    missingFromDisk,
    ghostAgents,
    duplicateIds,
    healthy,
  };

  appLog('core:agent-config', healthy ? 'info' : 'warn', 'Recovery audit complete', {
    meta: {
      projectPath,
      diskAgentCount: agents.length,
      runningAgentCount: runningAgentIds.size,
      healthy,
      ...(missingFromDisk.length > 0 ? { missingFromDisk } : {}),
      ...(ghostAgents.length > 0 ? { ghostAgents } : {}),
      ...(duplicateIds.length > 0 ? { duplicateIds } : {}),
    },
  });

  return result;
}
