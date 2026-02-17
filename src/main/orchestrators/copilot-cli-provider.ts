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
};

const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'gpt-5', label: 'GPT-5' },
];

function humanizeModelId(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parse model choices from `copilot --help` output */
function parseModelChoicesFromHelp(helpText: string): Array<{ id: string; label: string }> | null {
  const match = helpText.match(/--model\s+<model>\s+.*?\(choices:\s*([\s\S]*?)\)/);
  if (!match) return null;
  const raw = match[1].replace(/\n/g, ' ');
  const ids = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 0) return null;
  return [
    { id: 'default', label: 'Default' },
    ...ids.map((id) => ({ id, label: humanizeModelId(id) })),
  ];
}

const DEFAULT_DURABLE_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  preToolUse: 'pre_tool',
  postToolUse: 'post_tool',
  errorOccurred: 'tool_error',
  sessionEnd: 'stop',
};

function findCopilotBinary(): string {
  return findBinaryInPath(['copilot'], [
    homePath('.local/bin/copilot'),
    '/usr/local/bin/copilot',
    '/opt/homebrew/bin/copilot',
  ]);
}

export class CopilotCliProvider implements OrchestratorProvider {
  readonly id = 'copilot-cli' as const;
  readonly displayName = 'GitHub Copilot CLI';
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

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[]; env?: Record<string, string> }> {
    const binary = findCopilotBinary();
    const args: string[] = [];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      args.push('-p', parts.join('\n\n'));
    }

    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

  async writeHooksConfig(cwd: string, hookUrl: string): Promise<void> {
    const curlBase = `cat | curl -s -X POST ${hookUrl}/\${CLUBHOUSE_AGENT_ID} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

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

  async getModelOptions() {
    try {
      const binary = findCopilotBinary();
      const { stdout } = await execFileAsync(binary, ['--help'], { timeout: 5000 });
      const parsed = parseModelChoicesFromHelp(stdout);
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
