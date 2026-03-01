import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  OrchestratorProvider,
  OrchestratorConventions,
  ProviderCapabilities,
  SpawnOpts,
  HeadlessOpts,
  HeadlessCommandResult,
  NormalizedHookEvent,
} from './types';
import { findBinaryInPath, homePath, buildSummaryInstruction, readQuickSummary } from './shared';
import { isClubhouseHookEntry } from '../services/config-pipeline';

const TOOL_VERBS: Record<string, string> = {
  Bash: 'Running command',
  Edit: 'Editing file',
  Write: 'Writing file',
  Read: 'Reading file',
  Glob: 'Searching files',
  Grep: 'Searching code',
  Task: 'Running task',
  WebSearch: 'Searching web',
  WebFetch: 'Fetching page',
  EnterPlanMode: 'Planning',
  ExitPlanMode: 'Finishing plan',
  NotebookEdit: 'Editing notebook',
};

// Claude Code uses well-known aliases — no machine-readable model list in --help
const MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

const DEFAULT_DURABLE_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  PostToolUseFailure: 'tool_error',
  Stop: 'stop',
  Notification: 'notification',
  PermissionRequest: 'permission_request',
};

function findClaudeBinary(): string {
  const paths = [
    homePath('.local', 'bin', 'claude'),
    homePath('.claude', 'local', 'claude'),
    homePath('.npm-global', 'bin', 'claude'),
  ];
  if (process.platform === 'win32') {
    paths.push(
      homePath('AppData', 'Roaming', 'npm', 'claude.cmd'),
      homePath('AppData', 'Roaming', 'npm', 'claude'),
      homePath('.claude', 'local', 'claude.exe'),
    );
  } else {
    paths.push(
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      homePath('.volta', 'bin', 'claude'),
      homePath('.local', 'share', 'pnpm', 'claude'),
      homePath('.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'claude'),
    );
  }
  return findBinaryInPath(['claude'], paths);
}

export class ClaudeCodeProvider implements OrchestratorProvider {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly shortName = 'CC';

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: true,
      hooks: true,
      sessionResume: true,
      permissions: true,
    };
  }

  readonly conventions: OrchestratorConventions = {
    configDir: '.claude',
    localInstructionsFile: 'CLAUDE.md',
    legacyInstructionsFile: 'CLAUDE.md',
    mcpConfigFile: '.mcp.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'settings.local.json',
  };

  async checkAvailability(_envOverride?: Record<string, string>): Promise<{ available: boolean; error?: string }> {
    try {
      findClaudeBinary();
      return { available: true };
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Could not find Claude CLI',
      };
    }
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[] }> {
    const binary = findClaudeBinary();
    const args: string[] = [];

    // Session resume: --resume <id> for specific session, --continue for most recent
    if (opts.resume) {
      if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
      } else {
        args.push('--continue');
      }
    }

    if (opts.freeAgentMode) {
      args.push('--dangerously-skip-permissions');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    if (opts.mission) {
      args.push(opts.mission);
    }

    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

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
      // PermissionRequest uses a longer timeout (120s) so that the hook server
      // can hold the response while waiting for a remote approval decision
      // from the Annex iOS client.
      PermissionRequest: [{ hooks: [{ type: 'command', command: curlBase, timeout: 120 }] }],
    };

    const claudeDir = path.join(cwd, '.claude');
    await fsp.mkdir(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.local.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
    } catch {
      // No existing file
    }

    // Merge per-event key: preserve user hooks, replace stale Clubhouse entries
    const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

    for (const [eventKey, ourEntries] of Object.entries(hooks)) {
      const current = mergedHooks[eventKey] || [];
      const userEntries = current.filter(e => !isClubhouseHookEntry(e));
      mergedHooks[eventKey] = [...userEntries, ...ourEntries];
    }

    const merged: Record<string, unknown> = { ...existing, hooks: mergedHooks };
    await fsp.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
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

  readInstructions(worktreePath: string): string {
    const filePath = path.join(worktreePath, 'CLAUDE.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  writeInstructions(worktreePath: string, content: string): void {
    const filePath = path.join(worktreePath, 'CLAUDE.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = findClaudeBinary();
    const args: string[] = ['-p', opts.mission];

    args.push('--output-format', opts.outputFormat || 'stream-json');
    args.push('--verbose');

    // Skip all permission prompts for headless agents
    args.push('--dangerously-skip-permissions');

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      for (const tool of opts.disallowedTools) {
        args.push('--disallowedTools', tool);
      }
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    if (opts.noSessionPersistence) {
      args.push('--no-session-persistence');
    }

    return { binary, args, outputKind: 'stream-json' };
  }

  /**
   * List available CLI sessions by scanning Claude Code's project session storage.
   *
   * Claude Code stores sessions under ~/.claude/projects/<encoded-path>/.
   * The encoded path replaces path separators with dashes.
   */
  async listSessions(cwd: string, profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> {
    const configDir = profileEnv?.CLAUDE_CONFIG_DIR || homePath('.claude');
    const projectsDir = path.join(configDir, 'projects');

    if (!fs.existsSync(projectsDir)) return [];

    // Claude Code encodes project path by replacing separators with dashes
    const absCwd = path.resolve(cwd);
    const encodedPath = absCwd.replace(/[/\\]/g, '-');

    // Try candidate directory names (with and without leading dash)
    const candidates = [encodedPath, encodedPath.replace(/^-/, '')];

    let projectDir: string | null = null;
    for (const candidate of candidates) {
      const dir = path.join(projectsDir, candidate);
      if (fs.existsSync(dir)) {
        projectDir = dir;
        break;
      }
    }

    if (!projectDir) return [];

    // Look for session files. Claude Code may store them in various
    // subdirectory structures; check common locations.
    const sessionLocations = [
      path.join(projectDir, 'sessions'),
      projectDir,
    ];

    const sessions: Array<{ sessionId: string; startedAt: string; lastActiveAt: string }> = [];
    const seenIds = new Set<string>();

    for (const dir of sessionLocations) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

          // Session ID is the filename without extension
          const sessionId = path.basename(entry.name, '.json');
          // Skip non-UUID-like filenames (avoid config files)
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
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    // Sort by most recently active first
    sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return sessions;
  }

  /**
   * Extract session ID from PTY buffer output.
   * Looks for UUID patterns that Claude Code uses as session identifiers.
   */
  extractSessionId(ptyBuffer: string): string | null {
    // Claude Code session IDs are UUIDs. Match the first UUID in the output.
    // Look specifically for session-related context first.
    const sessionPatterns = [
      /session[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      /resume[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    ];

    for (const pattern of sessionPatterns) {
      const match = ptyBuffer.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  getProfileEnvKeys(): string[] {
    return ['CLAUDE_CONFIG_DIR'];
  }

  async getModelOptions() {
    return MODEL_OPTIONS;
  }
  getDefaultPermissions(kind: 'durable' | 'quick') {
    return kind === 'durable' ? [...DEFAULT_DURABLE_PERMISSIONS] : [...DEFAULT_QUICK_PERMISSIONS];
  }
  toolVerb(toolName: string) { return TOOL_VERBS[toolName]; }
  buildSummaryInstruction(agentId: string) { return buildSummaryInstruction(agentId); }
  readQuickSummary(agentId: string) { return readQuickSummary(agentId); }
}
