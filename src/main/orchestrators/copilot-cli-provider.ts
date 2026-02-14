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

const COPILOT_NAMES = ['copilot'];

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
};

const MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'gpt-5', label: 'GPT-5' },
];

const DEFAULT_DURABLE_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Write'];

const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  preToolUse: 'pre_tool',
  postToolUse: 'post_tool',
  errorOccurred: 'tool_error',
  sessionEnd: 'stop',
};

function findCopilotBinary(): string {
  const home = app.getPath('home');

  const commonPaths = [
    path.join(home, '.local/bin/copilot'),
    '/usr/local/bin/copilot',
    '/opt/homebrew/bin/copilot',
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  const shellPATH = getShellEnvironment().PATH || process.env.PATH || '';
  for (const dir of shellPATH.split(':')) {
    if (!dir) continue;
    for (const name of COPILOT_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  for (const name of COPILOT_NAMES) {
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
    'Could not find the copilot CLI binary. Make sure it is installed and on your PATH.'
  );
}

export class CopilotCliProvider implements OrchestratorProvider {
  readonly id = 'copilot-cli' as const;
  readonly displayName = 'GitHub Copilot CLI';

  readonly conventions: OrchestratorConventions = {
    configDir: '.github',
    localInstructionsFile: 'copilot-instructions.md',
    legacyInstructionsFile: 'copilot-instructions.md',
    mcpConfigFile: '.github/mcp.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'hooks/hooks.json',
  };

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    try {
      findCopilotBinary();
      return { available: true };
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Could not find Copilot CLI',
      };
    }
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[] }> {
    const binary = findCopilotBinary();
    const args: string[] = [];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.mission) {
      args.push('-p', opts.mission);
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
      preToolUse: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      postToolUse: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      errorOccurred: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
      sessionEnd: [{ hooks: [{ type: 'command', command: curlBase, async: true, timeout: 5 }] }],
    };

    const githubDir = path.join(cwd, '.github');
    const hooksDir = path.join(githubDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const settingsPath = path.join(hooksDir, 'hooks.json');

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
    const instructionsPath = path.join(worktreePath, '.github', 'copilot-instructions.md');
    try {
      return fs.readFileSync(instructionsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  writeInstructions(worktreePath: string, content: string): void {
    const githubDir = path.join(worktreePath, '.github');
    if (!fs.existsSync(githubDir)) {
      fs.mkdirSync(githubDir, { recursive: true });
    }
    const filePath = path.join(githubDir, 'copilot-instructions.md');
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
