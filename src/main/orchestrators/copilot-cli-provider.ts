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
  return findBinaryInPath(['copilot'], paths);
}

export class CopilotCliProvider implements OrchestratorProvider {
  readonly id = 'copilot-cli' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly shortName = 'GHCP';
  readonly badge = 'Beta';

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
      hooks: true,
      sessionResume: true,
      permissions: true,
    };
  }

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
    const makeCurl = (event: string) =>
      process.platform === 'win32'
        ? `curl -s -X POST ${hookUrl}/%CLUBHOUSE_AGENT_ID%/${event} -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)`
        : `cat | curl -s -X POST ${hookUrl}/\${CLUBHOUSE_AGENT_ID}/${event} -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true`;

    const ourHooks: Record<string, unknown[]> = {
      preToolUse: [{ type: 'command', bash: makeCurl('preToolUse'), timeoutSec: 5 }],
      postToolUse: [{ type: 'command', bash: makeCurl('postToolUse'), timeoutSec: 5 }],
      errorOccurred: [{ type: 'command', bash: makeCurl('errorOccurred'), timeoutSec: 5 }],
    };

    const githubDir = path.join(cwd, '.github');
    const hooksDir = path.join(githubDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const settingsPath = path.join(hooksDir, 'hooks.json');

    let existing: Record<string, unknown> = { version: 1 };
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
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

    fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, hooks: mergedHooks }, null, 2), 'utf-8');
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

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = findCopilotBinary();
    const parts: string[] = [];
    if (opts.systemPrompt) parts.push(opts.systemPrompt);
    parts.push(opts.mission);
    const args = ['-p', parts.join('\n\n'), '--allow-all', '--silent'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'text' };
  }

  async getModelOptions() {
    try {
      const binary = findCopilotBinary();
      const { stdout } = await execFileAsync(binary, ['--help'], {
        timeout: 5000,
        shell: process.platform === 'win32',
      });
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
