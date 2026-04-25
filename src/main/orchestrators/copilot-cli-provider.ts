import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  OrchestratorConventions,
  ProviderCapabilities,
  PasteSubmitTiming,
  SpawnOpts,
  SpawnCommandResult,
  HeadlessOpts,
  HeadlessCommandResult,
  NormalizedHookEvent,
  StructuredAdapter,
  HookCapable,
  HeadlessCapable,
  SessionCapable,
  StructuredCapable,
  AgentFileCapable,
} from './types';
import type { McpServerDef } from '../../shared/types';
import { BaseProvider } from './base-provider';
import { AcpAdapter } from './adapters';
import { homePath, parseModelChoicesFromHelp, validateHookUrl } from './shared';
import { isClubhouseHookEntry } from '../services/config-pipeline';
import { appLog } from '../services/log-service';

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

export class CopilotCliProvider extends BaseProvider implements HookCapable, HeadlessCapable, SessionCapable, StructuredCapable, AgentFileCapable {
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
      permissions: true,
      structuredMode: true,
      structuredProtocol: 'acp',
    };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult> {
    const binary = this.findBinary();
    const args: string[] = [];

    // Session resume: --resume <id> for specific session, --continue for most recent.
    // Note: Copilot CLI does not support resume in prompt mode (-p), so resume
    // flags are only appended for interactive (non-prompt) sessions.
    if (opts.resume && !(opts.mission || opts.systemPrompt)) {
      if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
      } else {
        args.push('--continue');
      }
    }

    if (opts.freeAgentMode) {
      args.push('--yolo', '--autopilot');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push('--allow-tool', tool);
      }
    }

    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      args.push('-p', parts.join('\n\n'));
    }

    args.push(...this.buildAgentFileArgs({ agentFile: opts.agentFile, agentSource: opts.agentSource }));

    return { binary, args };
  }

  // ── AgentFileCapable ───────────────────────────────────────────────────

  /**
   * Build the `--agent` / `--source` flag pair for Copilot CLI.  Used by both
   * `buildSpawnCommand` (PTY) and the structured/ACP path (via `extraArgs`),
   * so the flag-construction logic lives here only.
   */
  buildAgentFileArgs(opts: { agentFile?: string; agentSource?: string }): string[] {
    const args: string[] = [];
    if (opts.agentFile) args.push('--agent', opts.agentFile);
    if (opts.agentSource) args.push('--source', opts.agentSource);
    return args;
  }

  // ── MCP CLI injection ──────────────────────────────────────────────────

  /**
   * Copilot CLI reads MCP config from ~/.copilot/mcp-config.json, not from
   * a project-level config file. Use --additional-mcp-config to inject the
   * Clubhouse MCP server for this session without modifying user-level config.
   */
  buildMcpArgs(serverDef: McpServerDef): string[] {
    const config = JSON.stringify({ mcpServers: { clubhouse: serverDef } });
    return ['--additional-mcp-config', config];
  }

  // ── StructuredCapable ───────────────────────────────────────────────────

  createStructuredAdapter(_opts?: { resume?: boolean }): StructuredAdapter {
    return new AcpAdapter({
      binary: this.findBinary(),
      // --autopilot lets Copilot CLI v1.0.23+ run autonomously without per-step
      // approval round-trips. Structured (ACP) sessions are non-interactive by
      // definition, so they always opt in. Interactive PTY sessions only opt in
      // when freeAgentMode is set (see buildSpawnCommand).
      args: ['--acp', '--stdio', '--autopilot'],
      toolVerbs: TOOL_VERBS,
    });
  }

  // ── HookCapable ─────────────────────────────────────────────────────────

  async writeHooksConfig(cwd: string, hookUrl: string): Promise<void> {
    const safeUrl = validateHookUrl(hookUrl);
    const makeCurl = (event: string) =>
      process.platform === 'win32'
        ? `curl -s -X POST ${safeUrl}/%CLUBHOUSE_AGENT_ID%/${event} -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)`
        : `cat | curl -s -X POST ${safeUrl}/\${CLUBHOUSE_AGENT_ID}/${event} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

    const ourHooks: Record<string, unknown[]> = {
      preToolUse: [{ type: 'command', bash: makeCurl('preToolUse'), timeoutSec: 5 }],
      postToolUse: [{ type: 'command', bash: makeCurl('postToolUse'), timeoutSec: 5 }],
      errorOccurred: [{ type: 'command', bash: makeCurl('errorOccurred'), timeoutSec: 5 }],
      // PermissionRequest uses a long timeout to allow for remote approval via Annex
      permissionRequest: [{ type: 'command', bash: makeCurl('permissionRequest'), timeoutSec: 120 }],
      sessionStart: [{ type: 'command', bash: makeCurl('sessionStart'), timeoutSec: 5 }],
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

    // Merge per-event key: preserve user hooks, replace stale Clubhouse entries
    const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

    for (const [eventKey, ourEntries] of Object.entries(ourHooks)) {
      const current = mergedHooks[eventKey] || [];
      const userEntries = current.filter(e => !isClubhouseHookEntry(e));
      mergedHooks[eventKey] = [...userEntries, ...ourEntries];
    }

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

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'stream-json' };
  }

  // ── SessionCapable ──────────────────────────────────────────────────────

  /**
   * Resolve the Copilot CLI session directory for a given working directory.
   *
   * GitHub Copilot CLI stores session data under ~/.copilot/session-state/.
   * Sessions may be organized by project path or stored flat.
   */
  private resolveSessionDir(cwd: string, profileEnv?: Record<string, string>): string | null {
    const configDir = profileEnv?.GH_COPILOT_CONFIG_DIR || homePath('.copilot');
    const sessionDir = path.join(configDir, 'session-state');

    if (!fs.existsSync(sessionDir)) return null;

    // Check for project-scoped subdirectory (path encoded with dashes)
    const absCwd = path.resolve(cwd);
    const encodedPath = absCwd.replace(/[/\\]/g, '-');
    const candidates = [encodedPath, encodedPath.replace(/^-/, '')];

    for (const candidate of candidates) {
      const dir = path.join(sessionDir, candidate);
      if (fs.existsSync(dir)) {
        return dir;
      }
    }

    // Fall back to the flat session-state directory
    return sessionDir;
  }

  /**
   * List available CLI sessions by scanning Copilot CLI's session storage.
   */
  async listSessions(cwd: string, profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> {
    const sessionDir = this.resolveSessionDir(cwd, profileEnv);
    if (!sessionDir) return [];

    const sessions: Array<{ sessionId: string; startedAt: string; lastActiveAt: string }> = [];
    const seenIds = new Set<string>();

    // Scan session directory and any project-scoped subdirectories
    const dirsToScan = [sessionDir];

    try {
      const topEntries = await fsp.readdir(sessionDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (entry.isDirectory()) {
          dirsToScan.push(path.join(sessionDir, entry.name));
        }
      }
    } catch {
      // Can't read top-level — just scan sessionDir itself
    }

    for (const dir of dirsToScan) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl'))) continue;

          const ext = path.extname(entry.name);
          const sessionId = path.basename(entry.name, ext);
          // Accept UUID-like or hex-based session identifiers
          if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) continue;
          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);

          try {
            const stat = await fsp.stat(path.join(dir, entry.name));
            sessions.push({
              sessionId,
              startedAt: stat.birthtime.toISOString(),
              lastActiveAt: stat.mtime.toISOString(),
            });
          } catch (err) {
            appLog('core:orchestrator', 'warn', 'Failed to stat GHCP session file', {
              meta: { file: entry.name, error: err instanceof Error ? err.message : String(err) },
            });
          }
        }
      } catch (err) {
        appLog('core:orchestrator', 'warn', 'Failed to read GHCP session directory', {
          meta: { dir, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // Sort by most recently active first
    sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return sessions;
  }

  /**
   * Read a historical session transcript from Copilot CLI's session storage.
   * Returns raw StreamJsonEvent[] or null if session not found.
   */
  async readSessionTranscript(
    sessionId: string,
    cwd: string,
    profileEnv?: Record<string, string>,
  ): Promise<import('../services/jsonl-parser').StreamJsonEvent[] | null> {
    const sessionDir = this.resolveSessionDir(cwd, profileEnv);
    if (!sessionDir) return null;

    // Search for session file in the session directory and subdirectories
    const searchPaths = [
      path.join(sessionDir, `${sessionId}.jsonl`),
      path.join(sessionDir, `${sessionId}.json`),
    ];

    // Also check project-scoped subdirectories
    try {
      const topEntries = await fsp.readdir(sessionDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (entry.isDirectory()) {
          searchPaths.push(
            path.join(sessionDir, entry.name, `${sessionId}.jsonl`),
            path.join(sessionDir, entry.name, `${sessionId}.json`),
          );
        }
      }
    } catch {
      // Can't list subdirectories — just use top-level paths
    }

    let filePath: string | null = null;
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    }

    // Check for directory-style sessions (session ID as folder name)
    if (!filePath) {
      const dirPath = path.join(sessionDir, sessionId);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        try {
          const entries = await fsp.readdir(dirPath);
          const jsonlFile = entries.find((e) => e.endsWith('.jsonl'));
          if (jsonlFile) {
            filePath = path.join(dirPath, jsonlFile);
          }
        } catch (err) {
          appLog('core:orchestrator', 'warn', 'Failed to read GHCP session directory entries', {
            meta: { dirPath, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    if (!filePath) return null;

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const events: import('../services/jsonl-parser').StreamJsonEvent[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          // Skip malformed lines — expected in truncated sessions
        }
      }
      return events.length > 0 ? events : null;
    } catch (err) {
      appLog('core:orchestrator', 'warn', 'Failed to read GHCP session transcript', {
        meta: { filePath, error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
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
