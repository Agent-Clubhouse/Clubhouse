/**
 * Antigravity CLI (`agy`) as a terminal provider (#3789). Experimental: only
 * registered when its flag is on (registry.ts), never a default.
 *
 * Uses only the documented CLI (https://antigravity.google/docs/cli/reference/,
 * read 2026-11-23). Clubhouse never writes the person's `~/.gemini` files and
 * never sets credentials or API keys for the CLI; the CLI signs in on its own.
 */

import * as path from 'path';
import { execFile } from 'child_process';
import type {
  OrchestratorConventions,
  ProviderCapabilities,
  PasteSubmitTiming,
  SpawnOpts,
  SpawnCommandResult,
} from './types';
import { BaseProvider } from './base-provider';
import type { ModelProbeContext } from './model-probes';
import { homePath } from './shared';
import { assertExecutionPolicy } from '../../shared/execution-policy';
import { getShellEnvironment, invalidateShellEnvironmentCache } from '../util/shell';
import { resolveProcessLaunch } from '../util/process-launch';
import { ANTIGRAVITY_PATHS, ANTIGRAVITY_PROVIDER_ID } from '../../shared/providers/antigravity';
import { probeAgyModels } from './antigravity/models';
import { antigravityAccessArgs, antigravityStartLevel } from './antigravity/access';

/** stdout of a short command; rejects on a non-zero exit or timeout. */
function runForStdout(binary: string, args: string[], options: { env: Record<string, string>; windowsVerbatimArguments?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { ...options, timeout: 10_000, shell: false, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** Tool names the public hooks docs use in examples; others show no verb. */
const TOOL_VERBS: Record<string, string> = {
  run_command: 'Running command',
  view_file: 'Reading file',
};

/** The first `x.y.z` in `agy --version` output, or null. */
export function parseAgyVersion(stdout: string): string | null {
  return /(?:^|[^\d.])(\d+\.\d+\.\d+)(?![\d])/.exec(stdout)?.[1] ?? null;
}

export class AntigravityCliProvider extends BaseProvider {
  readonly id = ANTIGRAVITY_PROVIDER_ID;
  readonly displayName = 'Antigravity CLI';
  readonly shortName = 'AGY';
  readonly badge = 'Experimental';

  readonly conventions: OrchestratorConventions = {
    configDir: ANTIGRAVITY_PATHS.configDir,
    localInstructionsFile: ANTIGRAVITY_PATHS.instructions,
    legacyInstructionsFile: ANTIGRAVITY_PATHS.instructions,
    mcpConfigFile: ANTIGRAVITY_PATHS.mcpConfig,
    skillsDir: 'skills',
    skillsRoot: ANTIGRAVITY_PATHS.skillsRoot,
    agentTemplatesDir: 'agents',
    localSettingsFile: 'hooks.json',
    hooksFile: 'hooks.json',
    settingsFormat: 'json',
    permissionRules: false,
  };

  // ── BaseProvider configuration ──────────────────────────────────────────

  protected readonly binaryNames = ['agy'];

  /** The documented install locations (https://antigravity.google/docs/getting-started/). */
  protected getExtraBinaryPaths(): string[] {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || homePath('AppData', 'Local');
      return [path.join(localAppData, 'agy', 'bin', 'agy.exe')];
    }
    return [homePath('.local', 'bin', 'agy')];
  }

  protected getInstructionsPath(worktreePath: string): string {
    return path.join(worktreePath, ANTIGRAVITY_PATHS.instructions);
  }

  protected readonly toolVerbs = TOOL_VERBS;
  protected readonly durablePermissions: readonly string[] = [];
  protected readonly quickPermissions: readonly string[] = [];
  /** No shipped slugs: Antigravity retires models on dates, and an unknown `--model` fails the run. */
  protected readonly fallbackModelOptions = [{ id: 'default', label: 'Default' }] as const;

  /** `agy models`: the CLI's own list. Sends no prompt. */
  protected probeLiveModels(ctx: ModelProbeContext) {
    return probeAgyModels(ctx).then((models) => models && [{ id: 'default', label: 'Default' }, ...models]);
  }

  /**
   * Untuned (#3802 V9): starts from Copilot's quiescence profile, the most
   * conservative one Clubhouse has, until measured on a real session.
   */
  override getPasteSubmitTiming(): PasteSubmitTiming {
    return {
      initialDelayMs: 2500,
      retryDelayMs: 800,
      finalCheckDelayMs: 400,
      chunkSize: 256,
      chunkDelayMs: 120,
      postEndMarkerDelayMs: 300,
      quiescenceMs: 200,
      quiescencePollMs: 50,
    };
  }

  // ── Core interface ──────────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      // Off until the eligibility decision (#3786) names the auth types it may run under.
      headless: false,
      structuredOutput: false,
      // Status hooks and session capture land with #3795.
      hooks: false,
      sessionResume: false,
      supportsPositionalMission: false,
      supportsAutoResumeAfterUpdate: false,
      permissions: true,
      // Unmeasured (#3802 V10): assume the conservative case.
      ignoresToolListChanged: true,
    };
  }

  /** Finds the binary and checks that `agy --version` runs. */
  async checkAvailability(envOverride?: Record<string, string>): Promise<{ available: boolean; error?: string; version?: string }> {
    let binary: string;
    try {
      binary = this.findBinary();
    } catch (err: unknown) {
      return { available: false, error: err instanceof Error ? err.message : `Could not find ${this.displayName}` };
    }
    invalidateShellEnvironmentCache();
    try {
      const env = { ...getShellEnvironment(), ...envOverride };
      const launch = resolveProcessLaunch(binary, ['--version'], env);
      const stdout = await runForStdout(launch.binary, launch.args, { env, windowsVerbatimArguments: launch.windowsVerbatimArguments });
      const version = parseAgyVersion(stdout);
      return version ? { available: true, version } : { available: true };
    } catch {
      return { available: false, error: `Found Antigravity CLI at ${binary} but \`agy --version\` failed.` };
    }
  }

  /** No documented switch turns off the CLI's own browser control, so the Dispatcher can't use it (#3799). */
  async buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult> {
    if (opts.noDesktopControl) {
      throw new Error('Antigravity CLI has no documented way to start without its own browser control, so it cannot run here.');
    }
    // Clubhouse's sandbox and approval policies have no verified Antigravity mapping; refuse rather than drop them.
    assertExecutionPolicy(this.id, 'terminal', opts, opts.resume);

    const binary = this.findBinary();
    const args: string[] = [];

    if (opts.resume) {
      if (opts.sessionId) args.push('--conversation', opts.sessionId);
      else args.push('--continue');
    }

    args.push(...antigravityAccessArgs(antigravityStartLevel(opts)));

    if (opts.model && opts.model !== 'default') args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);

    if (opts.mission || opts.systemPrompt) {
      const parts: string[] = [];
      if (opts.systemPrompt) parts.push(opts.systemPrompt);
      if (opts.mission) parts.push(opts.mission);
      // -i runs the prompt and keeps the session open; this is always a terminal.
      args.push('--prompt-interactive', parts.join('\n\n'));
    }

    return { binary, args };
  }
}
