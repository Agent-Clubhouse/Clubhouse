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

const execFileAsync = promisify(execFile);

const TOOL_VERBS: Record<string, string> = {
  bash: 'Running command',
  edit: 'Editing file',
  write: 'Writing file',
  read: 'Reading file',
  glob: 'Searching files',
  grep: 'Searching code',
};

const MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

// OpenCode uses lowercase tool names
const DEFAULT_DURABLE_PERMISSIONS = ['bash(git:*)', 'bash(npm:*)', 'bash(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = [...DEFAULT_DURABLE_PERMISSIONS, 'read', 'edit', 'glob', 'grep'];

function findOpenCodeBinary(): string {
  const paths = [
    homePath('.local', 'bin', 'opencode'),
    homePath('.bun', 'bin', 'opencode'),
  ];
  if (process.platform === 'win32') {
    paths.push(
      homePath('AppData', 'Roaming', 'npm', 'opencode.cmd'),
      homePath('AppData', 'Roaming', 'npm', 'opencode'),
    );
  } else {
    paths.push('/usr/local/bin/opencode', '/opt/homebrew/bin/opencode');
  }
  return findBinaryInPath(['opencode'], paths);
}

function humanizeModelId(raw: string): string {
  // Strip provider prefix (e.g. "github-copilot/gpt-5" → "gpt-5")
  const id = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parse output of `opencode models` into options */
function parseOpenCodeModels(stdout: string): Array<{ id: string; label: string }> | null {
  const lines = stdout.trim().split('\n').filter((l) => l.trim() && !l.includes('migration'));
  if (lines.length === 0) return null;
  return [
    { id: 'default', label: 'Default' },
    ...lines.map((line) => {
      const id = line.trim();
      return { id, label: humanizeModelId(id) };
    }),
  ];
}

export class OpenCodeProvider implements OrchestratorProvider {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly shortName = 'OC';
  readonly badge = 'Beta';

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
      hooks: false,
      sessionResume: true,
      permissions: false,
    };
  }

  readonly conventions: OrchestratorConventions = {
    configDir: '.opencode',
    localInstructionsFile: 'instructions.md',
    legacyInstructionsFile: 'instructions.md',
    mcpConfigFile: 'opencode.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'opencode.json',
  };

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    try {
      findOpenCodeBinary();
      return { available: true };
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Could not find OpenCode CLI',
      };
    }
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[] }> {
    const binary = findOpenCodeBinary();
    const args: string[] = [];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

  async writeHooksConfig(_cwd: string, _hookUrl: string): Promise<void> {
    // OpenCode uses TypeScript plugins for hooks, not config-level shell scripts — no-op
  }

  parseHookEvent(raw: unknown): NormalizedHookEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    // OpenCode structured output provides tool events directly
    const toolName = (obj.tool_name ?? obj.toolName) as string | undefined;
    const kind = obj.kind as NormalizedHookEvent['kind'] | undefined;
    if (!kind) return null;

    return {
      kind,
      toolName,
      toolInput: obj.tool_input as Record<string, unknown> | undefined,
      message: obj.message as string | undefined,
    };
  }

  readInstructions(worktreePath: string): string {
    const instructionsPath = path.join(worktreePath, '.opencode', 'instructions.md');
    try {
      return fs.readFileSync(instructionsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  writeInstructions(worktreePath: string, content: string): void {
    const dir = path.join(worktreePath, '.opencode');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'instructions.md'), content, 'utf-8');
  }

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = findOpenCodeBinary();
    const args = ['run', opts.mission, '--format', 'json'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'text' };
  }

  async getModelOptions() {
    try {
      const binary = findOpenCodeBinary();
      const { stdout } = await execFileAsync(binary, ['models'], {
        timeout: 15000,
        shell: process.platform === 'win32',
      });
      const parsed = parseOpenCodeModels(stdout);
      if (parsed) return parsed;
    } catch {
      // Fall back to default only
    }
    return [{ id: 'default', label: 'Default' }];
  }
  getDefaultPermissions(kind: 'durable' | 'quick') {
    return kind === 'durable' ? [...DEFAULT_DURABLE_PERMISSIONS] : [...DEFAULT_QUICK_PERMISSIONS];
  }
  toolVerb(toolName: string) { return TOOL_VERBS[toolName]; }
  buildSummaryInstruction(agentId: string) { return buildSummaryInstruction(agentId); }
  readQuickSummary(agentId: string) { return readQuickSummary(agentId); }
}
