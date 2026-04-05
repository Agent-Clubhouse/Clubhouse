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
  NormalizedHookEvent,
} from './types';
import type { McpServerDef } from '../../shared/types';
import { BaseProvider } from './base-provider';
import { CodexAppServerAdapter } from './adapters';
import { homePath, parseModelChoicesFromHelp } from './shared';
import { getShellEnvironment, invalidateShellEnvironmentCache } from '../util/shell';
import { isClubhouseHookEntry } from '../services/config-pipeline';

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
  { id: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6 (1M)' },
  { id: 'claude-sonnet-4-6[1m]', label: 'Claude Sonnet 4.6 (1M)' },
];

const CODEX_MODEL_CHOICES_PATTERN = /--model\s+(?:<\w+>)?\s*.*?\(choices:\s*([\s\S]*?)\)/;

// Codex uses sandbox-based permissions rather than per-tool permissions.
// These map to general categories for compatibility with the permission UI.
const DEFAULT_DURABLE_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = [...DEFAULT_DURABLE_PERMISSIONS, 'shell(*)', 'apply_patch'];

/** Codex hook event names → normalised kinds (same semantics as Claude Code). */
const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  PostToolUseFailure: 'tool_error',
  Stop: 'stop',
  Notification: 'notification',
  PermissionRequest: 'permission_request',
};

export class CodexCliProvider extends BaseProvider implements HeadlessCapable, StructuredCapable, HookCapable {
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

    // Session resume: --continue for most recent session
    if (opts.resume) {
      args.push('--continue');
    }

    if (opts.freeAgentMode) {
      args.push('--full-auto');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      args.push(parts.join('\n\n'));
    }

    // Explicitly pass through API keys so they reach the spawned process even
    // when Electron's own process.env doesn't have them (Dock launch, stale cache).
    const shellEnv = getShellEnvironment();
    const env: Record<string, string> = {};
    if (shellEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = shellEnv.OPENAI_API_KEY;
    if (shellEnv.OPENAI_BASE_URL) env.OPENAI_BASE_URL = shellEnv.OPENAI_BASE_URL;

    return { binary, args, env };
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
    const curlBase = process.platform === 'win32'
      ? `curl -s -X POST ${hookUrl}/%CLUBHOUSE_AGENT_ID% -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)`
      : `cat | curl -s -X POST ${hookUrl}/\${CLUBHOUSE_AGENT_ID} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

    const hooks: Record<string, unknown[]> = {
      PreToolUse: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: curlBase, timeout: 120 }] }],
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

    // Merge per-event key: preserve user hooks, replace stale Clubhouse entries
    const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

    for (const [eventKey, ourEntries] of Object.entries(hooks)) {
      const current = mergedHooks[eventKey] || [];
      const userEntries = current.filter(e => !isClubhouseHookEntry(e));
      mergedHooks[eventKey] = [...userEntries, ...ourEntries];
    }

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

  // ── HeadlessCapable ─────────────────────────────────────────────────────

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = this.findBinary();
    const parts: string[] = [];
    if (opts.systemPrompt) parts.push(opts.systemPrompt);
    parts.push(opts.mission);
    const prompt = parts.join('\n\n');

    const args = ['exec', prompt, '--json', '--full-auto'];

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
