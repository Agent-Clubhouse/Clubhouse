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
};

const EVENT_NAME_MAP: Record<string, NormalizedHookEvent['kind']> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  Stop: 'stop',
};

function findOpenCodeBinary(): string {
  return findBinaryInPath(['opencode'], [
    homePath('.local/bin/opencode'),
    homePath('go/bin/opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ]);
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
  readonly badge = 'Beta';

  readonly conventions: OrchestratorConventions = {
    configDir: '.opencode',
    localInstructionsFile: 'instructions.md',
    legacyInstructionsFile: 'instructions.md',
    mcpConfigFile: '.opencode/config.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'config.json',
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
    if (opts.mission) {
      args.push(opts.mission);
    }
    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

  async writeHooksConfig(_cwd: string, _hookUrl: string): Promise<void> {
    // OpenCode hook integration is TBD — no-op for now
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

  async getModelOptions() {
    try {
      const binary = findOpenCodeBinary();
      const { stdout } = await execFileAsync(binary, ['models'], { timeout: 15000 });
      const parsed = parseOpenCodeModels(stdout);
      if (parsed) return parsed;
    } catch {
      // Fall back to default only
    }
    return [{ id: 'default', label: 'Default' }];
  }
  getDefaultPermissions(): string[] { return []; }
  toolVerb(toolName: string) { return TOOL_VERBS[toolName]; }
  buildSummaryInstruction(agentId: string) { return buildSummaryInstruction(agentId); }
  readQuickSummary(agentId: string) { return readQuickSummary(agentId); }
}
