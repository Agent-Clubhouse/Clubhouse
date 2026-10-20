import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  OrchestratorConventions,
  ProviderCapabilities,
  PasteSubmitTiming,
  SpawnOpts,
  SpawnCommandResult,
  HeadlessOpts,
  HeadlessCommandResult,
  NormalizedHookEvent,
  HookCapable,
  HeadlessCapable,
  SessionCapable,
  AgentFileCapable,
  PERMISSION_HOOK_TIMEOUT_SEC,
  TranscriptReadOptions,
} from './types';
import type { McpServerDef } from '../../shared/types';
import { BaseProvider } from './base-provider';
import { homePath, parseModelChoicesFromHelp, validateHookUrl, buildHookCurlCommand, mergeHookEntries, parseJsonlFile } from './shared';
import { isClubhouseHookEntry } from '../services/config-pipeline';
import { appLog } from '../services/log-service';
import { getShellEnvironment } from '../util/shell';
import { copilotSessionInCwd, findCopilotRunSession, findCopilotTranscript, hasCopilotSession, listCopilotSessions } from './copilot-session-store';

const execFileAsync = promisify(execFile);

/**
 * Copilot's state directory: `COPILOT_HOME` (per `copilot help environment`)
 * from the agent's profile, then the environment the PTY inherits (the login
 * shell's, then Clubhouse's own), else `~/.copilot`.
 */
export function resolveCopilotHome(profileEnv?: Record<string, string>): string {
  let shellEnv: Record<string, string> | undefined;
  try {
    shellEnv = getShellEnvironment();
  } catch {
    // telemetry-exempt: the shell env can't be read; process.env still applies
  }
  const home = [profileEnv?.COPILOT_HOME, shellEnv?.COPILOT_HOME, process.env.COPILOT_HOME]
    .map((v) => v?.trim())
    .find((v): v is string => !!v);
  if (!home) return homePath('.copilot');
  if (home === '~') return homePath();
  if (home.startsWith('~/') || home.startsWith('~\\')) return homePath(home.slice(2));
  return home;
}

const TOOL_VERBS: Record<string, string> = {
  shell: 'Running command',
  edit: 'Editing file',
  read: 'Reading file',
  search: 'Searching code',
  agent: 'Running agent',
};

const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'gpt-5', label: 'GPT 5' },
  { id: 'gpt-5-mini', label: 'GPT 5 Mini' },
];

const COPILOT_MODEL_CHOICES_PATTERN = /--model\s+<model>\s+.*?\(choices:\s*([\s\S]*?)\)/;

const DEFAULT_DURABLE_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)', 'read', 'edit', 'search'];

const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  preToolUse: 'pre_tool',
  postToolUse: 'post_tool',
  errorOccurred: 'tool_error',
  sessionEnd: 'stop',
  permissionRequest: 'permission_request',
  sessionStart: 'notification',
  userPromptSubmitted: 'notification',
};

export class CopilotCliProvider extends BaseProvider implements HookCapable, HeadlessCapable, SessionCapable, AgentFileCapable {
  readonly id = 'copilot-cli' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly shortName = 'GHCP';
  readonly badge = 'Beta';

  readonly conventions: OrchestratorConventions = {
    configDir: '.github',
    localInstructionsFile: 'copilot-instructions.md',
    legacyInstructionsFile: 'copilot-instructions.md',
    mcpConfigFile: '.github/mcp.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'hooks/hooks.json',
  };

  // ── BaseProvider configuration ──────────────────────────────────────────

  protected readonly binaryNames = ['copilot'];

  protected getExtraBinaryPaths(): string[] {
    const paths = [
      homePath('.local', 'bin', 'copilot'),
    ];
    if (process.platform === 'win32') {
      // Windows apps inherit the full persistent user/system environment, so
      // unlike packaged macOS apps they do not need version-manager paths here.
      paths.push(
        homePath('AppData', 'Roaming', 'npm', 'copilot.cmd'),
        homePath('AppData', 'Roaming', 'npm', 'copilot'),
      );
    } else {
      paths.push('/usr/local/bin/copilot', '/opt/homebrew/bin/copilot');
    }
    return paths;
  }

  protected getInstructionsPath(worktreePath: string): string {
    return path.join(worktreePath, '.github', 'copilot-instructions.md');
  }

  protected readonly toolVerbs = TOOL_VERBS;
  protected readonly durablePermissions = DEFAULT_DURABLE_PERMISSIONS;
  protected readonly quickPermissions = DEFAULT_QUICK_PERMISSIONS;
  protected readonly fallbackModelOptions = FALLBACK_MODEL_OPTIONS;
  protected readonly configEnvKeys = ['GH_HOST', 'GH_TOKEN'];

  protected readonly modelFetchConfig = {
    args: ['--help'],
    parser: (help: string) => parseModelChoicesFromHelp(help, COPILOT_MODEL_CHOICES_PATTERN),
  };

  // ── Paste timing ────────────────────────────────────────────────────────

  /**
   * Copilot CLI processes bracketed paste more slowly than Claude Code,
   * and its paste-preview render time is variable (network-bound, jitter-
   * prone in beta builds).  A fixed pre-Enter delay races against that
   * render and causes `\r` to be folded into the paste payload, leaving
   * the command sitting in the input box.
   *
   * Use buffer-quiescence detection: poll the PTY buffer and only fire
   * Enter once it's been unchanged for `quiescenceMs`.  The fixed delays
   * remain as caps so we still proceed if quiescence never settles.
   */
  override getPasteSubmitTiming(): PasteSubmitTiming {
    return {
      initialDelayMs: 2500,       // raised cap; quiescence usually fires earlier
      retryDelayMs: 800,
      finalCheckDelayMs: 400,
      chunkSize: 256,
      chunkDelayMs: 120,
      postEndMarkerDelayMs: 300,
      quiescenceMs: 200,
      quiescencePollMs: 50,
    };
  }

  // ── Core interface ──────────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: true,
      hooks: true,
      sessionResume: true,
      supportsPositionalMission: false,
      supportsAutoResumeAfterUpdate: true,
      permissions: true,
    };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult> {
    const binary = this.findBinary();
    const args: string[] = [];
    let sessionId: string | undefined;

    const hasPrompt = !!(opts.mission || opts.systemPrompt);
    // Session resume: --resume <id> for specific session, --continue for most recent.
    // Copilot CLI cannot resume in prompt mode (-p, one-shot), so resume flags go
    // only on interactive sessions: no prompt, or a durable agent woken with a
    // first message, which uses -i (run the prompt, then stay interactive).
    if (opts.resume && (!hasPrompt || opts.interactive)) {
      if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
      } else {
        args.push('--continue');
      }
    } else if (opts.interactive && await this.supportsSessionIdFlag(binary)) {
      // A fresh durable session: name its id up front (#2156), so the run's
      // session is known without searching the store afterwards.
      sessionId = randomUUID();
      args.push('--session-id', sessionId);
    }

    if (opts.freeAgentMode) {
      args.push('--yolo', '--autopilot');
    }
    if (opts.permissionMode === 'skip-all') {
      args.push('--allow-all-tools');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push('--allow-tool', tool);
      }
    }

    if (hasPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      args.push(opts.interactive ? '-i' : '-p', parts.join('\n\n'));
    }

    args.push(...this.buildAgentFileArgs({ agentFile: opts.agentFile, agentSource: opts.agentSource }));

    return sessionId ? { binary, args, sessionId } : { binary, args };
  }

  /** `copilot --help` output per binary, read once; null when it couldn't be run. */
  private readonly helpCache = new Map<string, Promise<string | null>>();

  /**
   * Whether this Copilot accepts `--session-id <uuid>` for a new session
   * (1.0.98 does; older versions would reject the flag and not start).
   */
  async supportsSessionIdFlag(binary: string): Promise<boolean> {
    let help = this.helpCache.get(binary);
    if (!help) {
      help = execFileAsync(binary, ['--help'], {
        timeout: 5000,
        shell: process.platform === 'win32',
        env: getShellEnvironment(),
      }).then((r) => (r ? String(r.stdout) : null)).catch((): null => null);
      this.helpCache.set(binary, help);
    }
    const text = await help;
    return !!text && /--session-id\b/.test(text);
  }

  // ── AgentFileCapable ───────────────────────────────────────────────────

  /**
   * Build the `--agent` / `--source` flag pair for Copilot CLI.  Used by both
   * `buildSpawnCommand` (PTY), so the flag-construction logic lives here only.
   */
  buildAgentFileArgs(opts: { agentFile?: string; agentSource?: string }): string[] {
    const args: string[] = [];
    if (opts.agentFile) args.push('--agent', opts.agentFile);
    if (opts.agentSource) args.push('--source', opts.agentSource);
    return args;
  }

  // ── MCP CLI injection ──────────────────────────────────────────────────

  /**
   * Copilot CLI reads MCP config from ~/.copilot/mcp-config.json, not from a
   * project-level file — a `.github/mcp.json` in the repo is never read
   * (verified: `copilot mcp list` in such a repo reports none configured).
   * `--additional-mcp-config` augments the user-level config for this session
   * only, without modifying it.
   */
  buildMcpArgs(servers: Record<string, McpServerDef>): string[] {
    if (Object.keys(servers).length === 0) return [];
    const config = JSON.stringify({ mcpServers: servers });
    return ['--additional-mcp-config', config];
  }

  // ── HookCapable ─────────────────────────────────────────────────────────

  async writeHooksConfig(cwd: string, hookUrl: string): Promise<void> {
    const safeUrl = validateHookUrl(hookUrl);
    const makeCurl = (event: string) => buildHookCurlCommand(safeUrl, `/${event}`);

    const ourHooks: Record<string, unknown[]> = {
      preToolUse: [{ type: 'command', bash: makeCurl('preToolUse'), timeoutSec: 5 }],
      postToolUse: [{ type: 'command', bash: makeCurl('postToolUse'), timeoutSec: 5 }],
      errorOccurred: [{ type: 'command', bash: makeCurl('errorOccurred'), timeoutSec: 5 }],
      // PermissionRequest uses a long timeout to allow for remote approval via Annex
      permissionRequest: [{ type: 'command', bash: makeCurl('permissionRequest'), timeoutSec: PERMISSION_HOOK_TIMEOUT_SEC }],
      sessionStart: [{ type: 'command', bash: makeCurl('sessionStart'), timeoutSec: 5 }],
      sessionEnd: [{ type: 'command', bash: makeCurl('sessionEnd'), timeoutSec: 5 }],
      userPromptSubmitted: [{ type: 'command', bash: makeCurl('userPromptSubmitted'), timeoutSec: 5 }],
    };

    const githubDir = path.join(cwd, '.github');
    const hooksDir = path.join(githubDir, 'hooks');
    await fsp.mkdir(hooksDir, { recursive: true });

    const settingsPath = path.join(hooksDir, 'hooks.json');

    let existing: Record<string, unknown> = { version: 1 };
    try {
      existing = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
    } catch {
      // No existing file
    }

    const mergedHooks = mergeHookEntries(existing, ourHooks, isClubhouseHookEntry);
    await fsp.writeFile(settingsPath, JSON.stringify({ ...existing, hooks: mergedHooks }, null, 2), 'utf-8');
  }

  parseHookEvent(raw: unknown): NormalizedHookEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const eventName = (obj.hook_event_name as string) || '';
    const kind = EVENT_NAME_MAP[eventName];
    if (!kind) return null;

    // Copilot sends camelCase (toolName, toolArgs) in hook stdin
    const toolName = (obj.tool_name ?? obj.toolName) as string | undefined;
    const rawInput = obj.tool_input ?? (typeof obj.toolArgs === 'string' ? JSON.parse(obj.toolArgs as string) : obj.toolArgs);

    return {
      kind,
      toolName,
      toolInput: rawInput as Record<string, unknown> | undefined,
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
    // --autopilot lets Copilot CLI v1.0.23+ run autonomously without per-step
    // approval round-trips. Headless mode is non-interactive by definition, so
    // we always opt in here.
    const args = ['-p', parts.join('\n\n'), '--allow-all', '--autopilot', '--output-format', 'json'];

    // Continue the most recent session.  Previously appended by the caller for
    // every provider; owned here so each CLI expresses resume in its own terms.
    // Copilot's prompt mode has no per-ID selector, so --continue is the only
    // option available here — see #1514.
    if (opts.resume) {
      args.push('--continue');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'stream-json' };
  }

  // ── SessionCapable ──────────────────────────────────────────────────────

  /** `<COPILOT_HOME>/session-state`, where Copilot keeps one directory per session. */
  private sessionStateDir(profileEnv?: Record<string, string>): string {
    return path.join(resolveCopilotHome(profileEnv), 'session-state');
  }

  /**
   * Sessions Copilot recorded for `cwd`, from each session directory's
   * workspace.yaml (#2156). The old scan looked for flat `<id>.json(l)` files,
   * a layout current Copilot no longer writes, and didn't filter by cwd.
   */
  async listSessions(cwd: string, profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> {
    try {
      return await listCopilotSessions(this.sessionStateDir(profileEnv), cwd);
    } catch (err) {
      appLog('core:orchestrator', 'warn', 'Failed to read GHCP session store', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return [];
    }
  }

  /**
   * The session a terminal run used, from Copilot's own store (#2156): its TUI
   * doesn't print the id, so the PTY scrape rarely finds it.
   */
  async findRunSession(run: { cwd: string; startedAt: number; endedAt: number; resumedId?: string; profileEnv?: Record<string, string> }): Promise<string | null> {
    return findCopilotRunSession(this.sessionStateDir(run.profileEnv), run);
  }

  /** Whether Copilot still has `sessionId`; undefined when there's no store or it can't be read. */
  async hasSession(sessionId: string, profileEnv?: Record<string, string>): Promise<boolean | undefined> {
    return hasCopilotSession(this.sessionStateDir(profileEnv), sessionId);
  }

  /** Whether `sessionId` is a Copilot session for `cwd`; undefined when the store can't tell. */
  async hasSessionForCwd(sessionId: string, cwd: string, profileEnv?: Record<string, string>): Promise<boolean | undefined> {
    return copilotSessionInCwd(this.sessionStateDir(profileEnv), sessionId, cwd);
  }

  /**
   * Read a historical session transcript from Copilot CLI's session storage.
   * Returns raw StreamJsonEvent[] or null if session not found.
   *
   * Looks the session up by id (#2277): the store holds every Copilot session
   * on the machine, so scanning it on each read stalled the main process.
   */
  async readSessionTranscript(
    sessionId: string,
    cwd: string,
    profileEnv?: Record<string, string>,
    opts: TranscriptReadOptions = {},
  ): Promise<import('../services/jsonl-parser').StreamJsonEvent[] | null> {
    const { stats } = opts;
    const lookupStart = performance.now();
    const counter = { probes: 0 };
    const filePath = await findCopilotTranscript(this.sessionStateDir(profileEnv), sessionId, cwd, counter);
    if (stats) {
      stats.lookupMs = performance.now() - lookupStart;
      stats.probes = counter.probes;
      stats.found = !!filePath;
    }
    if (!filePath) return null;

    const readStart = performance.now();
    const events = await parseJsonlFile(filePath, opts);
    if (stats) stats.readMs = performance.now() - readStart;
    if (!events) {
      appLog('core:orchestrator', 'warn', 'Failed to read GHCP session transcript', {
        meta: { filePath },
      });
    }
    return events;
  }

  /**
   * Extract session ID from PTY buffer output.
   * Looks for conversation/session UUID patterns in Copilot CLI output.
   */
  extractSessionId(ptyBuffer: string): string | null {
    // Copilot CLI may emit session/conversation IDs as UUIDs in various contexts
    const sessionPatterns = [
      /(?:session|conversation|thread)[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      /(?:resume|continuing)[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    ];

    for (const pattern of sessionPatterns) {
      const match = ptyBuffer.match(pattern);
      if (match) return match[1];
    }

    return null;
  }
}
