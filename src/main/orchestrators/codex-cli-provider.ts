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
import { getShellEnvironment, invalidateShellEnvironmentCache } from '../util/shell';

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
      // NVM installs — nvm creates a `current` symlink to the active version
      homePath('.nvm', 'current', 'bin', 'codex'),
      // Bun global installs
      homePath('.bun', 'bin', 'codex'),
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
    let binary: string;
    try {
      binary = findCodexBinary();
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : 'Could not find Codex CLI',
      };
    }

    // Re-source the shell environment so env vars added after app launch are picked up.
    invalidateShellEnvironmentCache();

    // Binary found — verify it actually runs (catches broken installs / wrong arch)
    try {
      await execFileAsync(binary, ['--version'], {
        timeout: 10000,
        shell: process.platform === 'win32',
        env: getShellEnvironment(),
      });
    } catch {
      return {
        available: false,
        error: `Found Codex at ${binary} but it failed to execute. Reinstall with: npm install -g @openai/codex`,
      };
    }

    // Don't hard-block on OPENAI_API_KEY here — the key may be available in the
    // user's shell profile (.zshrc etc.) which the PTY login shell will source,
    // or it may be injected via a Clubhouse Profile.  Blocking here produces
    // false negatives when getShellEnvironment() can't capture the full env
    // (e.g. Electron launched from Dock, env set by direnv/1Password/mise).
    // The Codex binary will report a clear auth error if the key is truly absent.

    return { available: true };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[]; env?: Record<string, string> }> {
    const binary = findCodexBinary();
    const args: string[] = [];

    // Session resume: --continue for most recent session
    if (opts.resume) {
      args.push('--continue');
    }

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

    // Explicitly pass through API keys so they reach the spawned process even
    // when Electron's own process.env doesn't have them (Dock launch, stale cache).
    const shellEnv = getShellEnvironment();
    const env: Record<string, string> = {};
    if (shellEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = shellEnv.OPENAI_API_KEY;
    if (shellEnv.OPENAI_BASE_URL) env.OPENAI_BASE_URL = shellEnv.OPENAI_BASE_URL;

    return { binary, args, env };
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

    const shellEnv = getShellEnvironment();
    const env: Record<string, string> = {};
    if (shellEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = shellEnv.OPENAI_API_KEY;
    if (shellEnv.OPENAI_BASE_URL) env.OPENAI_BASE_URL = shellEnv.OPENAI_BASE_URL;

    return { binary, args, env, outputKind: 'text' };
  }

  async getModelOptions() {
    try {
      const binary = findCodexBinary();
      const { stdout } = await execFileAsync(binary, ['--help'], {
        timeout: 5000,
        shell: process.platform === 'win32',
        env: getShellEnvironment(),
      });
      const parsed = parseModelChoicesFromHelp(stdout);
      if (parsed) return parsed;
    } catch {
      // Fall back to static list
    }
    return FALLBACK_MODEL_OPTIONS;
  }

  getProfileEnvKeys(): string[] {
    return ['OPENAI_API_KEY', 'OPENAI_BASE_URL'];
  }

  getDefaultPermissions(kind: 'durable' | 'quick') {
    return kind === 'durable' ? [...DEFAULT_DURABLE_PERMISSIONS] : [...DEFAULT_QUICK_PERMISSIONS];
  }

  toolVerb(toolName: string) { return TOOL_VERBS[toolName]; }
  buildSummaryInstruction(agentId: string) { return buildSummaryInstruction(agentId); }
  readQuickSummary(agentId: string) { return readQuickSummary(agentId); }
}
