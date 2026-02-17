import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  OrchestratorProvider,
  OrchestratorConventions,
  SpawnOpts,
  NormalizedHookEvent,
} from './types';
import { findBinaryInPath, homePath, buildSummaryInstruction, readQuickSummary } from './shared';

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

const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

function humanizeModelId(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parse model choices from `claude --help` output (if present) */
function parseClaudeModelsFromHelp(helpText: string): Array<{ id: string; label: string }> | null {
  // Claude may list choices like: (choices: "model-a", "model-b")
  const choicesMatch = helpText.match(/--model\s+<model>\s+.*?\(choices:\s*([\s\S]*?)\)/);
  if (choicesMatch) {
    const ids = [...choicesMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (ids.length > 0) {
      return [
        { id: 'default', label: 'Default' },
        ...ids.map((id) => ({ id, label: humanizeModelId(id) })),
      ];
    }
  }

  // Claude also accepts aliases — extract known aliases from help text
  const aliasMatch = helpText.match(/alias[^\n]*\(e\.g\.\s*'([^)]+)'\)/i);
  if (aliasMatch) {
    const aliases = aliasMatch[1].split(/'\s*or\s*'|',\s*'/).map((s) => s.replace(/'/g, '').trim()).filter(Boolean);
    if (aliases.length > 0) {
      return [
        { id: 'default', label: 'Default' },
        ...aliases.map((id) => ({ id, label: humanizeModelId(id) })),
      ];
    }
  }

  return null;
}

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
  return findBinaryInPath(['claude'], [
    homePath('.local/bin/claude'),
    homePath('.claude/local/claude'),
    homePath('.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
}

export class ClaudeCodeProvider implements OrchestratorProvider {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  readonly conventions: OrchestratorConventions = {
    configDir: '.claude',
    localInstructionsFile: 'CLAUDE.local.md',
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
      const { stdout } = await execFileAsync(binary, ['-p', '', '--output-format', 'json'], { timeout: 10000 });
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
    const curlBase = `cat | curl -s -X POST ${hookUrl}/\${CLUBHOUSE_AGENT_ID} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

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

    const merged: Record<string, unknown> = { ...existing, hooks };
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
    const localPath = path.join(worktreePath, '.claude', 'CLAUDE.local.md');
    try {
      return fs.readFileSync(localPath, 'utf-8');
    } catch {
      const legacyPath = path.join(worktreePath, 'CLAUDE.md');
      try {
        return fs.readFileSync(legacyPath, 'utf-8');
      } catch {
        return '';
      }
    }
  }

  writeInstructions(worktreePath: string, content: string): void {
    const claudeDir = path.join(worktreePath, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    const filePath = path.join(claudeDir, 'CLAUDE.local.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  async getModelOptions() {
    try {
      const binary = findClaudeBinary();
      const { stdout } = await execFileAsync(binary, ['--help'], { timeout: 5000 });
      const parsed = parseClaudeModelsFromHelp(stdout);
      if (parsed) return parsed;
    } catch {
      // Fall back to static list
    }
    return FALLBACK_MODEL_OPTIONS;
  }
  getDefaultPermissions(kind: 'durable' | 'quick') {
    return kind === 'durable' ? [...DEFAULT_DURABLE_PERMISSIONS] : [...DEFAULT_QUICK_PERMISSIONS];
  }
  toolVerb(toolName: string) { return TOOL_VERBS[toolName]; }
  buildSummaryInstruction(agentId: string) { return buildSummaryInstruction(agentId); }
  readQuickSummary(agentId: string) { return readQuickSummary(agentId); }
}
