import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fsp from 'fs/promises';
import {
  OrchestratorConventions,
  ProviderCapabilities,
  SpawnOpts,
  SpawnCommandResult,
  HeadlessOpts,
  HeadlessCommandResult,
  HeadlessCapable,
  StructuredAdapter,
  StructuredCapable,
  HookCapable,
  SessionCapable,
  NormalizedHookEvent,
  PERMISSION_HOOK_TIMEOUT_SEC,
} from './types';
import type { McpServerDef } from '../../shared/types';
import type { StreamJsonEvent } from '../services/jsonl-parser';
import { BaseProvider } from './base-provider';
import { CodexAppServerAdapter } from './adapters';
import { createCodexHeadlessNormalizer } from './codex-headless-events';
import { homePath, validateHookUrl, buildHookCurlCommand, mergeHookEntries, parseJsonlFile } from './shared';
import { getShellEnvironment, invalidateShellEnvironmentCache } from '../util/shell';
import { isClubhouseHookEntry } from '../services/config-pipeline';
import { appLog } from '../services/log-service';

const execFileAsync = promisify(execFile);

/** Format a string as a TOML value (double-quoted). */
function tomlValue(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Codex rollout filename: `rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl`.
 * Capture 1 is the local-time start stamp, capture 2 the session id.
 */
const ROLLOUT_FILE_PATTERN =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** `sessions/YYYY/MM/DD/` is three levels; allow one spare for re-partitioning. */
const CODEX_SESSION_WALK_MAX_DEPTH = 4;

/** Upper bound on rollout files examined per listing, newest partitions first. */
const CODEX_SESSION_SCAN_LIMIT = 500;

/** Enough to cover the opening `session_meta` line without reading whole transcripts. */
const ROLLOUT_META_READ_BYTES = 64 * 1024;

/**
 * Convert a rollout filename stamp (`2026-09-05T17-28-00`) to an ISO string.
 * Only the time separators are dashes, so restore the colons before parsing.
 * Returns null when the stamp doesn't parse, letting callers fall back to mtime.
 */
function parseRolloutFilenameTimestamp(stamp: string): string | null {
  const [datePart, timePart] = stamp.split('T');
  if (!datePart || !timePart) return null;
  const parsed = new Date(`${datePart}T${timePart.replace(/-/g, ':')}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const TOOL_VERBS: Record<string, string> = {
  shell: 'Running command',
  shell_command: 'Running command',
  apply_patch: 'Editing file',
};

// Used only when `codex debug models` is unavailable or unparseable.  Codex
// renames its catalog frequently, so treat this as a last resort rather than a
// maintained list — the live query below is the real source.
const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
];

/** One entry of `codex debug models` output. */
interface CodexModelEntry {
  slug?: unknown;
  display_name?: unknown;
  /** 'list' for picker-visible models; 'hide' for internal ones (e.g. codex-auto-review). */
  visibility?: unknown;
  /** Ascending catalog rank — lower is more prominent. */
  priority?: unknown;
}

/**
 * Parse `codex debug models` JSON into picker options.
 *
 * Codex's `--help` has no `(choices: …)` list for `--model`, so the previous
 * help-scraping parser always returned null and the static fallback was used
 * unconditionally — offering models that no longer exist.  `codex debug models`
 * emits the live catalog instead.
 *
 * Returns null (→ static fallback) when the output isn't the expected shape.
 */
export function parseCodexDebugModels(stdout: string): Array<{ id: string; label: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;

  const visible = (models as CodexModelEntry[])
    .filter((m) => typeof m?.slug === 'string' && m.slug.length > 0)
    // 'hide' models are excluded from Codex's own picker; treat a missing
    // visibility as listable so a schema change doesn't empty the menu.
    .filter((m) => m.visibility === undefined || m.visibility === 'list')
    .sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
      return pa - pb;
    })
    .map((m) => ({
      id: m.slug as string,
      label: typeof m.display_name === 'string' && m.display_name.length > 0
        ? m.display_name
        : (m.slug as string),
    }));

  if (visible.length === 0) return null;

  return [{ id: 'default', label: 'Default' }, ...visible];
}

// Codex uses sandbox-based permissions rather than per-tool permissions.
// These map to general categories for compatibility with the permission UI.
const DEFAULT_DURABLE_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = [...DEFAULT_DURABLE_PERMISSIONS, 'shell(*)', 'apply_patch'];

/**
 * Codex hook event names → normalised kinds.
 *
 * Codex's own event set (HookEventName, per `codex app-server
 * generate-json-schema`) is:
 *
 *   SessionStart  SessionEnd  PreToolUse  PostToolUse  PermissionRequest
 *   PreCompact    PostCompact UserPromptSubmit  SubagentStart  SubagentStop
 *   Stop          Interrupt
 *
 * This map was previously copied from the Claude Code provider and listed two
 * events Codex does not have — `PostToolUseFailure` and `Notification` — while
 * omitting every Codex-specific one.  Neither phantom could ever match, so
 * tool-error and notification events were simply never delivered.
 *
 * `SessionEnd` is deliberately absent: Codex emits both `Stop` (turn finished)
 * and `SessionEnd` (process exiting), and mapping both to 'stop' would report
 * the agent idle twice per session.  `Stop` is the one that means "turn done".
 */
const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  SessionStart: 'notification',
  UserPromptSubmit: 'notification',
};

/**
 * Autonomy flags for an unattended Codex session.
 *
 * `--full-auto` was removed from the Codex CLI; the sandbox and approval
 * policies are now separate axes.  'skip-all' means the user explicitly asked
 * for no sandbox and no approvals, which is a different thing from 'auto'
 * (sandboxed, but never stops to ask).
 */
function codexAutonomyArgs(permissionMode: SpawnOpts['permissionMode']): string[] {
  if (permissionMode === 'skip-all') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
}

export class CodexCliProvider extends BaseProvider implements HeadlessCapable, StructuredCapable, HookCapable, SessionCapable {
  readonly id = 'codex-cli' as const;
  readonly displayName = 'Codex CLI';
  readonly shortName = 'CX';
  readonly badge = 'Beta';

  readonly conventions: OrchestratorConventions = {
    configDir: '.codex',
    localInstructionsFile: 'AGENTS.md',
    legacyInstructionsFile: 'AGENTS.md',
    mcpConfigFile: '.codex/config.toml',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'config.toml',
    // Codex reads hooks from .codex/hooks.json, not from config.toml
    hooksFile: 'hooks.json',
    settingsFormat: 'toml',
  };

  // ── BaseProvider configuration ──────────────────────────────────────────

  protected readonly binaryNames = ['codex'];

  protected getExtraBinaryPaths(): string[] {
    const paths = [
      homePath('.local', 'bin', 'codex'),
      homePath('.npm-global', 'bin', 'codex'),
    ];
    if (process.platform === 'win32') {
      paths.push(
        homePath('AppData', 'Roaming', 'npm', 'codex.cmd'),
        homePath('AppData', 'Roaming', 'npm', 'codex'),
      );
    } else {
      paths.push(
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex',
        // Node version manager locations — common when codex is installed via npm
        homePath('.volta', 'bin', 'codex'),
        homePath('.local', 'share', 'pnpm', 'codex'),
        homePath('.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'codex'),
        // NVM installs — nvm creates a `current` symlink to the active version
        homePath('.nvm', 'current', 'bin', 'codex'),
        // Bun global installs
        homePath('.bun', 'bin', 'codex'),
      );
    }
    return paths;
  }

  protected getInstructionsPath(worktreePath: string): string {
    return path.join(worktreePath, 'AGENTS.md');
  }

  protected readonly toolVerbs = TOOL_VERBS;
  protected readonly durablePermissions = DEFAULT_DURABLE_PERMISSIONS;
  protected readonly quickPermissions = DEFAULT_QUICK_PERMISSIONS;
  protected readonly fallbackModelOptions = FALLBACK_MODEL_OPTIONS;
  // CODEX_HOME is Codex's config/state root — the analogue of Claude Code's
  // CLAUDE_CONFIG_DIR. Declaring it lets a Clubhouse profile give an agent an
  // isolated session store, config.toml and auth.
  protected readonly configEnvKeys = ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'];

  protected readonly modelFetchConfig = {
    args: ['debug', 'models'],
    parser: parseCodexDebugModels,
  };

  // ── Core interface ──────────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      // `codex exec --json` emits structured events, normalised into stream-json
      // by createEventNormalizer — see codex-headless-events.
      structuredOutput: true,
      hooks: true,
      sessionResume: true,
      permissions: true,
      structuredMode: true,
    };
  }

  /**
   * Override base checkAvailability to also verify the binary executes
   * (catches broken installs / wrong arch) and to re-source the shell env.
   */
  async checkAvailability(envOverride?: Record<string, string>): Promise<{ available: boolean; error?: string }> {
    let binary: string;
    try {
      binary = this.findBinary();
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : `Could not find ${this.displayName}`,
      };
    }

    // Re-source the shell environment so env vars added after app launch are picked up.
    invalidateShellEnvironmentCache();

    // Binary found — verify it actually runs (catches broken installs / wrong arch)
    try {
      await execFileAsync(binary, ['--version'], {
        timeout: 10000,
        shell: process.platform === 'win32',
        env: { ...getShellEnvironment(), ...envOverride },
      });
    } catch {
      return {
        available: false,
        error: `Found Codex at ${binary} but it failed to execute. Reinstall with: npm install -g @openai/codex`,
      };
    }

    // Don't hard-block on OPENAI_API_KEY here — the key may be available in the
    // user's shell profile (.zshrc etc.) which the PTY login shell will source,
    // or it may be injected via a Clubhouse Profile.  Blocking here produces
    // false negatives when getShellEnvironment() can't capture the full env
    // (e.g. Electron launched from Dock, env set by direnv/1Password/mise).
    // The Codex binary will report a clear auth error if the key is truly absent.

    return { available: true };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult> {
    const binary = this.findBinary();
    const args: string[] = [];

    // Session resume.  `codex resume` takes an optional SESSION_ID positional
    // (a UUID or a session name); `--last` selects the most recent instead.
    // Older Codex releases used a bare `--continue` flag, since removed.
    if (opts.resume) {
      args.push('resume', opts.sessionId ? opts.sessionId : '--last');
    }

    if (opts.freeAgentMode) {
      args.push(...codexAutonomyArgs(opts.permissionMode));
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    // The mission/prompt is a bare positional argument for Codex (unlike
    // Claude Code's -p flag), so it must stay last even after buildMcpArgs()
    // output is injected — otherwise Codex's arg parser misreads the
    // trailing -c flags as extra positionals and exits with a usage error.
    // See trailingArgs on SpawnCommandResult.
    const trailingArgs: string[] = [];
    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      trailingArgs.push(parts.join('\n\n'));
    }

    // Explicitly pass through API keys so they reach the spawned process even
    // when Electron's own process.env doesn't have them (Dock launch, stale cache).
    const shellEnv = getShellEnvironment();
    const env: Record<string, string> = {};
    if (shellEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = shellEnv.OPENAI_API_KEY;
    if (shellEnv.OPENAI_BASE_URL) env.OPENAI_BASE_URL = shellEnv.OPENAI_BASE_URL;

    return { binary, args, env, trailingArgs };
  }

  // ── MCP args ───────────────────────────────────────────────────────────

  /**
   * Codex reads `mcp_servers` only from `$CODEX_HOME/config.toml` — never from
   * a project-level `.codex/config.toml`.  Verified directly: the same table is
   * invisible in-repo and visible under CODEX_HOME.  So the TOML that
   * materialisation writes into the worktree does not reach Codex, and `-c`
   * config overrides at launch are the only path that does.
   *
   * `-c key=value` takes dot-notation with TOML-typed values.
   */
  buildMcpArgs(servers: Record<string, McpServerDef>): string[] {
    const args: string[] = [];

    for (const [name, def] of Object.entries(servers)) {
      // A server name lands in a dotted config key, so anything outside this
      // set would produce an unparseable override rather than a clear error.
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        appLog('core:orchestrator', 'warn', 'Skipping MCP server with a name Codex cannot key on', {
          meta: { name },
        });
        continue;
      }

      if (def.type) {
        args.push('-c', `mcp_servers.${name}.type=${tomlValue(def.type)}`);
      }
      if (def.command) {
        args.push('-c', `mcp_servers.${name}.command=${tomlValue(def.command)}`);
      }
      if (def.args && def.args.length > 0) {
        const arr = `[${def.args.map(tomlValue).join(', ')}]`;
        args.push('-c', `mcp_servers.${name}.args=${arr}`);
      }
      if (def.url) {
        args.push('-c', `mcp_servers.${name}.url=${tomlValue(def.url)}`);
      }
      if (def.env) {
        for (const [key, val] of Object.entries(def.env)) {
          args.push('-c', `mcp_servers.${name}.env.${key}=${tomlValue(val)}`);
        }
      }
    }

    return args;
  }

  // ── StructuredCapable ───────────────────────────────────────────────────

  createStructuredAdapter(_opts?: { resume?: boolean }): StructuredAdapter {
    return new CodexAppServerAdapter({
      binary: this.findBinary(),
      toolVerbs: TOOL_VERBS,
    });
  }

  // ── HookCapable ─────────────────────────────────────────────────────────

  async writeHooksConfig(cwd: string, hookUrl: string): Promise<void> {
    const safeUrl = validateHookUrl(hookUrl);
    const curl = buildHookCurlCommand(safeUrl);

    // Only events Codex actually defines — see EVENT_NAME_MAP.  Registering an
    // unknown event name is at best inert and at worst rejects the whole file.
    const hooks: Record<string, unknown[]> = {
      PreToolUse: [{ hooks: [{ type: 'command', command: curl, async: true, timeout: 5 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: curl, async: true, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: curl, async: true, timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: curl, async: true, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: curl, async: true, timeout: 5 }] }],
      // A longer timeout so the hook server can hold the response while a
      // remote approval decision comes back from the Annex iOS client.
      PermissionRequest: [{ hooks: [{ type: 'command', command: curl, timeout: PERMISSION_HOOK_TIMEOUT_SEC }] }],
    };

    const codexDir = path.join(cwd, '.codex');
    await fsp.mkdir(codexDir, { recursive: true });

    const hooksPath = path.join(codexDir, 'hooks.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fsp.readFile(hooksPath, 'utf-8'));
    } catch {
      // No existing file — expected on first run
    }

    const mergedHooks = mergeHookEntries(existing, hooks, isClubhouseHookEntry);
    await fsp.writeFile(hooksPath, JSON.stringify({ ...existing, hooks: mergedHooks }, null, 2), 'utf-8');
  }

  parseHookEvent(raw: unknown): NormalizedHookEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const eventName = (obj.hook_event_name as string) || '';
    const kind = EVENT_NAME_MAP[eventName];
    if (!kind) return null;

    return {
      kind,
      toolName: obj.tool_name as string | undefined,
      toolInput: obj.tool_input as Record<string, unknown> | undefined,
      message: obj.message as string | undefined,
    };
  }

  // ── SessionCapable ──────────────────────────────────────────────────────

  /**
   * Root of Codex's own state directory.
   *
   * Codex honours `CODEX_HOME`; a Clubhouse profile can set it to give an agent
   * an isolated session store, config and auth (the equivalent of Claude Code's
   * `CLAUDE_CONFIG_DIR`).
   */
  private resolveCodexHome(profileEnv?: Record<string, string>): string {
    return profileEnv?.CODEX_HOME || homePath('.codex');
  }

  /**
   * Collect rollout transcripts under `<CODEX_HOME>/sessions`.
   *
   * Codex partitions them by date — `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
   * — so this walks rather than reading a flat directory.  The walk is depth-
   * limited and count-capped so a long-lived store can't stall the main process,
   * and it tolerates a flat or differently-partitioned layout rather than
   * hardcoding the current three levels.
   */
  private async collectRolloutFiles(sessionsDir: string): Promise<string[]> {
    const found: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > CODEX_SESSION_WALK_MAX_DEPTH || found.length >= CODEX_SESSION_SCAN_LIMIT) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // Newest date partitions sort last by name, so descend in reverse to hit
      // recent sessions before the scan limit bites.
      for (const entry of [...entries].sort((a, b) => b.name.localeCompare(a.name))) {
        if (found.length >= CODEX_SESSION_SCAN_LIMIT) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (ROLLOUT_FILE_PATTERN.test(entry.name)) {
          found.push(full);
        }
      }
    };

    await walk(sessionsDir, 0);
    return found;
  }

  /**
   * Read the `session_meta` record that opens every rollout file.
   *
   * Older Codex releases key the id as `payload.id`, newer ones also emit
   * `payload.session_id`; both carry `payload.cwd`.  The filename is the more
   * reliable source for the id, so this is only consulted for `cwd` and the
   * recorded start time.
   */
  private async readRolloutMeta(filePath: string): Promise<{ cwd?: string; startedAt?: string }> {
    let raw: string;
    try {
      // The meta record is the first line; read a bounded prefix rather than
      // the whole transcript, which can be megabytes.
      const handle = await fsp.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(ROLLOUT_META_READ_BYTES);
        const { bytesRead } = await handle.read(buf, 0, ROLLOUT_META_READ_BYTES, 0);
        raw = buf.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await handle.close();
      }
    } catch {
      return {};
    }

    const firstLine = raw.split('\n', 1)[0];
    if (!firstLine) return {};

    try {
      const parsed = JSON.parse(firstLine) as { payload?: Record<string, unknown> };
      const payload = parsed?.payload;
      if (!payload || typeof payload !== 'object') return {};
      return {
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        startedAt: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
      };
    } catch {
      // A truncated prefix can't be parsed — fall back to filename metadata.
      return {};
    }
  }

  /**
   * List Codex sessions recorded for `cwd`.
   *
   * Previously this probed `~/.codex/threads` (which does not exist) and the
   * flat `~/.codex/sessions` root, matching entries against a UUID-shaped
   * regex.  The only entry at that level is the year directory, so the filter
   * never matched and the picker was always empty.
   */
  async listSessions(cwd: string, profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> {
    const sessionsDir = path.join(this.resolveCodexHome(profileEnv), 'sessions');
    const targetCwd = path.resolve(cwd);

    let files: string[];
    try {
      files = await this.collectRolloutFiles(sessionsDir);
    } catch (err) {
      appLog('core:orchestrator', 'warn', 'Failed to scan Codex session store', {
        meta: { sessionsDir, error: err instanceof Error ? err.message : String(err) },
      });
      return [];
    }

    const sessions: Array<{ sessionId: string; startedAt: string; lastActiveAt: string }> = [];
    const seenIds = new Set<string>();

    for (const filePath of files) {
      const match = ROLLOUT_FILE_PATTERN.exec(path.basename(filePath));
      if (!match) continue;

      const [, filenameTimestamp, sessionId] = match;
      if (seenIds.has(sessionId)) continue;

      const meta = await this.readRolloutMeta(filePath);

      // Only surface sessions recorded in this project.  A rollout with no
      // readable cwd is skipped rather than shown against every project.
      if (!meta.cwd || path.resolve(meta.cwd) !== targetCwd) continue;

      let lastActiveAt: string;
      try {
        lastActiveAt = (await fsp.stat(filePath)).mtime.toISOString();
      } catch {
        continue;
      }

      seenIds.add(sessionId);
      sessions.push({
        sessionId,
        startedAt: meta.startedAt ?? parseRolloutFilenameTimestamp(filenameTimestamp) ?? lastActiveAt,
        lastActiveAt,
      });
    }

    sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return sessions;
  }

  /**
   * Read a rollout transcript by session id.  The id is the UUID suffix of the
   * rollout filename, so this locates the file by scanning names rather than
   * guessing a path.
   */
  async readSessionTranscript(
    sessionId: string,
    _cwd: string,
    profileEnv?: Record<string, string>,
  ): Promise<StreamJsonEvent[] | null> {
    const sessionsDir = path.join(this.resolveCodexHome(profileEnv), 'sessions');

    let files: string[];
    try {
      files = await this.collectRolloutFiles(sessionsDir);
    } catch {
      return null;
    }

    const filePath = files.find((f) => {
      const match = ROLLOUT_FILE_PATTERN.exec(path.basename(f));
      return match?.[2] === sessionId;
    });

    if (!filePath) return null;

    const events = await parseJsonlFile(filePath);
    if (!events) {
      appLog('core:orchestrator', 'warn', 'Failed to read session transcript', {
        meta: { filePath },
      });
    }
    return events;
  }

  extractSessionId(ptyBuffer: string): string | null {
    const patterns = [
      // Codex thread IDs with thread_ prefix
      /thread[_:]([a-zA-Z0-9_-]{16,})/,
      // UUID-style thread/session IDs
      /thread[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      /session[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      /resume[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    ];

    for (const pattern of patterns) {
      const match = ptyBuffer.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  // ── HeadlessCapable ─────────────────────────────────────────────────────

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = this.findBinary();
    const parts: string[] = [];
    if (opts.systemPrompt) parts.push(opts.systemPrompt);
    parts.push(opts.mission);
    const prompt = parts.join('\n\n');

    // Continuing an existing thread uses the `exec resume` subcommand, which
    // takes [SESSION_ID] [PROMPT] positionals.  Note it accepts NEITHER
    // `--sandbox` nor `--ask-for-approval` (unlike plain `exec`), so the only
    // autonomy control available on this path is the bypass flag.
    const args = opts.resume
      ? ['exec', 'resume', opts.sessionId ? opts.sessionId : '--last', prompt, '--json']
      : ['exec', prompt, '--json'];

    if (opts.permissionMode === 'skip-all') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (!opts.resume) {
      // `exec` already runs non-interactively and never prompts, so the sandbox
      // mode is the meaningful control on a fresh run.
      args.push('--sandbox', 'workspace-write');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    const shellEnv = getShellEnvironment();
    const env: Record<string, string> = {};
    if (shellEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = shellEnv.OPENAI_API_KEY;
    if (shellEnv.OPENAI_BASE_URL) env.OPENAI_BASE_URL = shellEnv.OPENAI_BASE_URL;

    return {
      binary,
      args,
      env,
      outputKind: 'stream-json',
      // `codex exec --json` emits Codex's own event vocabulary, not Claude
      // Code's stream-json — see codex-headless-events.
      createEventNormalizer: createCodexHeadlessNormalizer,
    };
  }
}
