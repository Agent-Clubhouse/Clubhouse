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
  shell: 'Running command',
  shell_command: 'Running command',
  apply_patch: 'Editing file',
};

const FALLBACK_MODEL_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'gpt-5.3-codex', label: 'GPT 5.3 Codex' },
  { id: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' },
  { id: 'codex-mini-latest', label: 'Codex Mini' },
  { id: 'gpt-5', label: 'GPT 5' },
];

function humanizeModelId(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parse model choices from `codex --help` output */
function parseModelChoicesFromHelp(helpText: string): Array<{ id: string; label: string }> | null {
  // Codex --help lists models in a choices-like format
  const match = helpText.match(/--model\s+(?:<\w+>)?\s*.*?\(choices:\s*([\s\S]*?)\)/);
  if (!match) return null;
  const raw = match[1].replace(/\n/g, ' ');
  const ids = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 0) return null;
  return [
    { id: 'default', label: 'Default' },
    ...ids.map((id) => ({ id, label: humanizeModelId(id) })),
  ];
}

// Codex uses sandbox-based permissions rather than per-tool permissions.
// These map to general categories for compatibility with the permission UI.
const DEFAULT_DURABLE_PERMISSIONS = ['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = [...DEFAULT_DURABLE_PERMISSIONS, 'shell(*)', 'apply_patch'];

function findCodexBinary(): string {
  const paths = [
    homePath('.local', 'bin', 'codex'),
    homePath('.npm-global', 'bin', 'codex'),
  ];
  if (process.platform === 'win32') {
    paths.push(
      homePath('AppData', 'Roaming', 'npm', 'codex.cmd'),
      homePath('AppData', 'Roaming', 'npm', 'codex'),
    );
  } else {
    paths.push(
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      // Node version manager locations — common when codex is installed via npm
      homePath('.volta', 'bin', 'codex'),
      homePath('.local', 'share', 'pnpm', 'codex'),
      homePath('.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'codex'),
    );
  }
  return findBinaryInPath(['codex'], paths);
}

export class CodexCliProvider implements OrchestratorProvider {
  readonly id = 'codex-cli' as const;
  readonly displayName = 'Codex CLI';
  readonly shortName = 'CX';
  readonly badge = 'Beta';

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
      hooks: false,
      sessionResume: true,
      permissions: true,
    };
  }

  readonly conventions: OrchestratorConventions = {
    configDir: '.codex',
    localInstructionsFile: 'AGENTS.md',
    legacyInstructionsFile: 'AGENTS.md',
    mcpConfigFile: '.codex/config.toml',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'config.toml',
  };

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    try {
      findCodexBinary();
      return { available: true };
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Could not find Codex CLI',
      };
    }
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[]; env?: Record<string, string> }> {
    const binary = findCodexBinary();
    const args: string[] = [];

    if (opts.freeAgentMode) {
      args.push('--full-auto');
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      args.push(parts.join('\n\n'));
    }

    return { binary, args };
  }

  getExitCommand(): string {
    return '/exit\r';
  }

  async writeHooksConfig(_cwd: string, _hookUrl: string): Promise<void> {
    // Codex CLI only supports a notify hook for agent-turn-complete events,
    // which is not granular enough for pre_tool/post_tool — no-op.
  }

  parseHookEvent(raw: unknown): NormalizedHookEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    // Codex notify events use a "type" field
    const eventType = obj.type as string | undefined;
    if (eventType === 'agent-turn-complete') {
      return {
        kind: 'stop',
        toolName: undefined,
        toolInput: undefined,
        message: obj['last-assistant-message'] as string | undefined,
      };
    }

    return null;
  }

  readInstructions(worktreePath: string): string {
    // Codex uses AGENTS.md at the project root
    const instructionsPath = path.join(worktreePath, 'AGENTS.md');
    try {
      return fs.readFileSync(instructionsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  writeInstructions(worktreePath: string, content: string): void {
    const filePath = path.join(worktreePath, 'AGENTS.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = findCodexBinary();
    const parts: string[] = [];
    if (opts.systemPrompt) parts.push(opts.systemPrompt);
    parts.push(opts.mission);
    const prompt = parts.join('\n\n');

    const args = ['exec', prompt, '--json', '--full-auto'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'text' };
  }

  async getModelOptions() {
    try {
      const binary = findCodexBinary();
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
