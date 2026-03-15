import * as path from 'path';
import {
  OrchestratorConventions,
  ProviderCapabilities,
  SpawnOpts,
  SpawnCommandResult,
  HeadlessOpts,
  HeadlessCommandResult,
  HeadlessCapable,
} from './types';
import { BaseProvider } from './base-provider';
import { homePath, humanizeModelId } from './shared';

const TOOL_VERBS: Record<string, string> = {
  bash: 'Running command',
  edit: 'Editing file',
  write: 'Writing file',
  read: 'Reading file',
  glob: 'Searching files',
  grep: 'Searching code',
};

// OpenCode uses lowercase tool names
const DEFAULT_DURABLE_PERMISSIONS = ['bash(git:*)', 'bash(npm:*)', 'bash(npx:*)'];
const DEFAULT_QUICK_PERMISSIONS = [...DEFAULT_DURABLE_PERMISSIONS, 'read', 'edit', 'glob', 'grep'];

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

export class OpenCodeProvider extends BaseProvider implements HeadlessCapable {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly shortName = 'OC';
  readonly badge = 'Beta';

  readonly conventions: OrchestratorConventions = {
    configDir: '.opencode',
    localInstructionsFile: 'instructions.md',
    legacyInstructionsFile: 'instructions.md',
    mcpConfigFile: 'opencode.json',
    skillsDir: 'skills',
    agentTemplatesDir: 'agents',
    localSettingsFile: 'opencode.json',
  };

  // ── BaseProvider configuration ──────────────────────────────────────────

  protected readonly binaryNames = ['opencode'];

  protected getExtraBinaryPaths(): string[] {
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
    return paths;
  }

  protected getInstructionsPath(worktreePath: string): string {
    return path.join(worktreePath, '.opencode', 'instructions.md');
  }

  protected readonly toolVerbs = TOOL_VERBS;
  protected readonly durablePermissions = DEFAULT_DURABLE_PERMISSIONS;
  protected readonly quickPermissions = DEFAULT_QUICK_PERMISSIONS;
  protected readonly fallbackModelOptions = [{ id: 'default', label: 'Default' }];
  protected readonly configEnvKeys = ['OPENCODE_CONFIG_DIR'];

  protected readonly modelFetchConfig = {
    args: ['models'],
    parser: parseOpenCodeModels,
    timeout: 15000,
  };

  // ── Core interface ──────────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      headless: true,
      structuredOutput: false,
      hooks: false,
      sessionResume: true,
      permissions: false,
      structuredMode: false,
    };
  }

  async buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult> {
    const binary = this.findBinary();
    const args: string[] = [];

    // Session resume: --session <id> for specific session, --continue for most recent
    if (opts.resume) {
      if (opts.sessionId) {
        args.push('--session', opts.sessionId);
      } else {
        args.push('--continue');
      }
    }

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args };
  }

  // ── HeadlessCapable ─────────────────────────────────────────────────────

  async buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null> {
    if (!opts.mission) return null;

    const binary = this.findBinary();
    const args = ['run', opts.mission, '--format', 'json'];

    if (opts.model && opts.model !== 'default') {
      args.push('--model', opts.model);
    }

    return { binary, args, outputKind: 'text' };
  }
}
