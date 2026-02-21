import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
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

const execFileAsync = promisify(execFile);

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

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    let binary: string;
    try {
      binary = findClaudeBinary();
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Could not find Claude CLI',
      };
    }

    // Binary found — verify authentication with a quick no-op call
    try {
      const { stdout } = await execFileAsync(binary, ['-p', '', '--output-format', 'json'], {
        timeout: 10000,
        shell: process.platform === 'win32', // .cmd shims need shell on Windows
      });
      const result = JSON.parse(stdout);
      if (result.is_error && typeof result.result === 'string') {
        const msg = result.result as string;
        if (msg.includes('API key') || msg.includes('/login') || msg.includes('authentication')) {
          return { available: false, error: 'Not signed in — run "claude" and follow login prompts' };
        }
        return { available: false, error: msg };
      }
    } catch {
      // Timeout or parse failure — binary exists so treat as available
    }
    return { available: true };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[] }> {
    const binary = findClaudeBinary();
    const args: string[] = [];

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
      PermissionRequest: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
    };

    const claudeDir = path.join(cwd, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const settingsPath = path.join(claudeDir, 'settings.local.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
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
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
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
