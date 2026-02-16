import * as fs from 'fs';
import * as path from 'path';
import {
  OrchestratorProvider,
  OrchestratorConventions,
  SpawnOpts,
  HeadlessOpts,
  NormalizedHookEvent,
} from './types';
import { findBinaryInPath, homePath, buildSummaryInstruction, readQuickSummary } from './shared';

// Copilot CLI uses lowercase tool names
const TOOL_VERBS: Record<string, string> = {
  shell: 'Running command',
  edit: 'Editing file',
  read: 'Reading file',
  search: 'Searching code',
  agent: 'Running agent',
};

const MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'o4-mini', label: 'o4-mini' },
];

// Copilot CLI uses lowercase tool names
const DEFAULT_DURABLE_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = [...DEFAULT_DURABLE_PERMISSIONS, 'read', 'edit', 'search'];

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

    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

  async writeHooksConfig(cwd: string, hookUrl: string): Promise<void> {
    const curlBase = `cat | curl -s -X POST ${hookUrl}/\${CLUBHOUSE_AGENT_ID} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

    const hookEntry = { type: 'command', bash: curlBase, timeoutSec: 5 };

    const config = {
      version: 1,
      hooks: {
        preToolUse: [hookEntry],
        postToolUse: [hookEntry],
        errorOccurred: [hookEntry],
      },
    };

    const githubDir = path.join(cwd, '.github');
    const hooksDir = path.join(githubDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const settingsPath = path.join(hooksDir, 'hooks.json');
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), 'utf-8');
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

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<{ binary: string; args: string[] } | null> {
    if (!opts.mission) return null;

    const binary = findCopilotBinary();
    const parts: string[] = [];
    if (opts.systemPrompt) parts.push(opts.systemPrompt);
    parts.push(opts.mission);
    const args = ['-p', parts.join('\n\n'), '--allow-all', '--silent'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args };
  }

  getModelOptions() { return MODEL_OPTIONS; }
  getDefaultPermissions(kind: 'durable' | 'quick') {
    return kind === 'durable' ? [...DEFAULT_DURABLE_PERMISSIONS] : [...DEFAULT_QUICK_PERMISSIONS];
  }
  toolVerb(toolName: string) { return TOOL_VERBS[toolName]; }
  buildSummaryInstruction(agentId: string) { return buildSummaryInstruction(agentId); }
  readQuickSummary(agentId: string) { return readQuickSummary(agentId); }
}
