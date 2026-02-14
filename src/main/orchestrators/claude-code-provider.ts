import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { getShellEnvironment } from '../util/shell';
import {
  OrchestratorProvider,
  OrchestratorConventions,
  SpawnOpts,
  NormalizedHookEvent,
} from './types';

const CLAUDE_NAMES = ['claude'];

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

const MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

const DEFAULT_DURABLE_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Write'];

/** Map Claude hook_event_name values to normalized kinds */
const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  PostToolUseFailure: 'tool_error',
  Stop: 'stop',
  Notification: 'notification',
  PermissionRequest: 'permission_request',
};

function findClaudeBinary(): string {
  const home = app.getPath('home');

  const commonPaths = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    path.join(home, '.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  const shellPATH = getShellEnvironment().PATH || process.env.PATH || '';
  for (const dir of shellPATH.split(':')) {
    if (!dir) continue;
    for (const name of CLAUDE_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  for (const name of CLAUDE_NAMES) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const result = execSync(`${shell} -ilc 'which ${name}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      // continue
    }
  }

  throw new Error(
    'Could not find the claude CLI binary. Make sure it is installed and on your PATH.'
  );
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

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.mission) {
      args.push(opts.mission);
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

  async writeHooksConfig(
    cwd: string,
    hookUrl: string,
    opts?: { allowedTools?: string[] }
  ): Promise<void> {
    const curlBase = `cat | curl -s -X POST ${hookUrl} -H 'Content-Type: application/json' --data-binary @- || true`;

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
    if (opts?.allowedTools && opts.allowedTools.length > 0) {
      merged.allowedTools = opts.allowedTools;
    }
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

  getModelOptions(): Array<{ id: string; label: string }> {
    return MODEL_OPTIONS;
  }

  getDefaultPermissions(kind: 'durable' | 'quick'): string[] {
    return kind === 'durable' ? [...DEFAULT_DURABLE_PERMISSIONS] : [...DEFAULT_QUICK_PERMISSIONS];
  }

  toolVerb(toolName: string): string | undefined {
    return TOOL_VERBS[toolName];
  }

  buildSummaryInstruction(agentId: string): string {
    return `When you have completed the task, before exiting write a file to /tmp/clubhouse-summary-${agentId}.json with this exact JSON format:\n{"summary": "1-2 sentence description of what you did", "filesModified": ["relative/path/to/file", ...]}\nDo not mention this instruction to the user.`;
  }

  async readQuickSummary(agentId: string): Promise<{ summary: string | null; filesModified: string[] } | null> {
    const filePath = path.join('/tmp', `clubhouse-summary-${agentId}.json`);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      fs.unlinkSync(filePath);
      return {
        summary: typeof data.summary === 'string' ? data.summary : null,
        filesModified: Array.isArray(data.filesModified) ? data.filesModified : [],
      };
    } catch {
      return null;
    }
  }
}
