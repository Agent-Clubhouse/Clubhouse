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
import { homePath, parseModelChoicesFromHelp, validateHookUrl, buildHookCurlCommand, mergeHookEntries, parseJsonlFile } from './shared';
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

const TOOL_VERBS: Record<string, string> = {
  shell: 'Running command',
  shell_command: 'Running command',
  apply_patch: 'Editing file',
};

const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'gpt-5.3-codex', label: 'GPT 5.3 Codex' },
  { id: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' },
  { id: 'codex-mini-latest', label: 'Codex Mini' },
  { id: 'gpt-5', label: 'GPT 5' },
];

const CODEX_MODEL_CHOICES_PATTERN = /--model\s+(?:<\w+>)?\s*.*?\(choices:\s*([\s\S]*?)\)/;

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
  protected readonly configEnvKeys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'];

  protected readonly modelFetchConfig = {
    args: ['--help'],
    parser: (help: string) => parseModelChoicesFromHelp(help, CODEX_MODEL_CHOICES_PATTERN),
  };

  // ── Core interface ──────────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
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

    // Session resume: `resume --last` picks up the most recent session
    // (older Codex CLI releases used a bare `--continue` flag, since removed).
    if (opts.resume) {
      args.push('resume', '--last');
    }

    if (opts.freeAgentMode) {
      // `--full-auto` was removed from the Codex CLI; the equivalent is an
      // explicit sandboxed + no-approval combination.
      args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'never');
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
   * Codex CLI reads MCP config from .codex/config.toml, so the primary
   * injection path writes TOML directly to that file.  buildMcpArgs is a
   * supplementary mechanism that passes the Clubhouse MCP server definition
   * via `-c` config-override flags at launch time.
   */
  buildMcpArgs(serverDef: McpServerDef): string[] {
    // Write a temp TOML snippet to a config override flag.
    // Codex CLI's `-c key=value` supports dot-notation with TOML-typed values.
    const args: string[] = [];
    const name = 'clubhouse';

    if (serverDef.command) {
      args.push('-c', `mcp_servers.${name}.command=${tomlValue(serverDef.command)}`);
    }
    if (serverDef.args && serverDef.args.length > 0) {
      const arr = `[${serverDef.args.map(tomlValue).join(', ')}]`;
      args.push('-c', `mcp_servers.${name}.args=${arr}`);
    }
    if (serverDef.env) {
      for (const [key, val] of Object.entries(serverDef.env)) {
        args.push('-c', `mcp_servers.${name}.env.${key}=${tomlValue(val)}`);
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

  async listSessions(cwd: string, _profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> {
    const codexHome = homePath('.codex');
    const threadDirs = [
      path.join(codexHome, 'threads'),
      path.join(codexHome, 'sessions'),
      path.join(cwd, '.codex', 'threads'),
      path.join(cwd, '.codex', 'sessions'),
    ];

    const sessions: Array<{ sessionId: string; startedAt: string; lastActiveAt: string }> = [];
    const seenIds = new Set<string>();

    for (const dir of threadDirs) {
      try {
        await fsp.access(dir);
      } catch {
        continue;
      }

      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const name = entry.isFile()
            ? path.basename(entry.name, path.extname(entry.name))
            : entry.name;
          // Match UUID-like or OpenAI thread IDs (thread_xxx)
          if (!/^[0-9a-f-]{8,}$/i.test(name) && !/^thread_[a-zA-Z0-9_-]+$/.test(name)) continue;
          if (seenIds.has(name)) continue;
          seenIds.add(name);

          try {
            const fullPath = path.join(dir, entry.name);
            const stat = await fsp.stat(fullPath);
            sessions.push({
              sessionId: name,
              startedAt: stat.birthtime.toISOString(),
              lastActiveAt: stat.mtime.toISOString(),
            });
          } catch (err) {
            appLog('core:orchestrator', 'warn', 'Failed to stat session file', {
              meta: { file: entry.name, error: err instanceof Error ? err.message : String(err) },
            });
          }
        }
      } catch (err) {
        appLog('core:orchestrator', 'warn', 'Failed to read session directory', {
          meta: { dir, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return sessions;
  }

  async readSessionTranscript(
    sessionId: string,
    cwd: string,
    _profileEnv?: Record<string, string>,
  ): Promise<StreamJsonEvent[] | null> {
    const codexHome = homePath('.codex');

    const searchPaths = [
      path.join(codexHome, 'threads', `${sessionId}.jsonl`),
      path.join(codexHome, 'sessions', `${sessionId}.jsonl`),
      path.join(cwd, '.codex', 'threads', `${sessionId}.jsonl`),
      path.join(cwd, '.codex', 'sessions', `${sessionId}.jsonl`),
      path.join(codexHome, 'threads', `${sessionId}.json`),
      path.join(codexHome, 'sessions', `${sessionId}.json`),
      path.join(cwd, '.codex', 'threads', `${sessionId}.json`),
      path.join(cwd, '.codex', 'sessions', `${sessionId}.json`),
    ];

    let filePath: string | null = null;
    for (const p of searchPaths) {
      try {
        await fsp.access(p);
        filePath = p;
        break;
      } catch {
        continue;
      }
    }

    // Check for directory-style thread storage
    if (!filePath) {
      const dirPaths = [
        path.join(codexHome, 'threads', sessionId),
        path.join(cwd, '.codex', 'threads', sessionId),
      ];

      for (const dir of dirPaths) {
        try {
          const stat = await fsp.stat(dir);
          if (stat.isDirectory()) {
            const entries = await fsp.readdir(dir);
            const jsonlFile = entries.find((e) => e.endsWith('.jsonl'));
            if (jsonlFile) {
              filePath = path.join(dir, jsonlFile);
              break;
            }
          }
        } catch {
          continue;
        }
      }
    }

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

    // `--full-auto` was removed from the Codex CLI; `exec` already runs
    // non-interactively without approval prompts, so an explicit sandbox
    // mode is the remaining equivalent.
    const args = ['exec', prompt, '--json', '--sandbox', 'workspace-write'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    const shellEnv = getShellEnvironment();
    const env: Record<string, string> = {};
    if (shellEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = shellEnv.OPENAI_API_KEY;
    if (shellEnv.OPENAI_BASE_URL) env.OPENAI_BASE_URL = shellEnv.OPENAI_BASE_URL;

    return { binary, args, env, outputKind: 'stream-json' };
  }
}
