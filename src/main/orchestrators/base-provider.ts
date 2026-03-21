import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  OrchestratorProvider,
  OrchestratorConventions,
  ProviderCapabilities,
  PasteSubmitTiming,
  SpawnOpts,
  SpawnCommandResult,
} from './types';
import { findBinaryInPath } from './shared';
import { getShellEnvironment } from '../util/shell';

const execFileAsync = promisify(execFile);

/**
 * Optional configuration for dynamic model option fetching.
 * When provided, `getModelOptions()` will attempt to run the CLI binary
 * with the given args and parse the output before falling back to the
 * static fallback list.
 */
export interface ModelFetchConfig {
  /** CLI arguments to invoke (e.g. ['--help'] or ['models']) */
  args: string[];
  /** Parse stdout into model options. Return null to fall back to static list. */
  parser: (stdout: string) => Array<{ id: string; label: string }> | null;
  /** Timeout in ms (default: 5000) */
  timeout?: number;
}

/**
 * Abstract base class for orchestrator providers.
 *
 * Handles common patterns shared across all providers:
 * - Binary discovery and availability checking
 * - Instructions file read/write
 * - Exit command, tool verbs, permissions, model options, profile env keys
 *
 * Concrete providers extend this class and supply their unique configuration
 * via abstract properties, then only override methods where their behavior
 * diverges from the common pattern.
 */
export abstract class BaseProvider implements OrchestratorProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly shortName: string;
  readonly badge?: string;

  abstract readonly conventions: OrchestratorConventions;

  // ── Binary discovery (subclasses provide) ─────────────────────────────

  /** Binary names to search for on PATH (e.g. ['claude']) */
  protected abstract readonly binaryNames: string[];

  /** Well-known absolute paths where this binary may be installed */
  protected abstract getExtraBinaryPaths(): string[];

  // ── Instructions ──────────────────────────────────────────────────────

  /** Absolute path to the instructions file for a given worktree */
  protected abstract getInstructionsPath(worktreePath: string): string;

  // ── Provider-specific data (subclasses provide) ───────────────────────

  /** Map of tool names to human-readable activity verbs */
  protected abstract readonly toolVerbs: Record<string, string>;

  /** Default permissions for long-running (durable) agent sessions */
  protected abstract readonly durablePermissions: readonly string[];

  /** Default permissions for quick one-shot agent sessions */
  protected abstract readonly quickPermissions: readonly string[];

  /** Static model option list used when dynamic fetching is unavailable */
  protected abstract readonly fallbackModelOptions: ReadonlyArray<{ id: string; label: string }>;

  /** Env var keys used for config/profile isolation */
  protected abstract readonly configEnvKeys: readonly string[];

  /**
   * Optional config for dynamic model fetching.
   * When set, `getModelOptions()` will try running the binary to discover
   * models before falling back to the static list.
   */
  protected readonly modelFetchConfig?: ModelFetchConfig;

  // ── Abstract: must be implemented by each provider ────────────────────

  abstract getCapabilities(): ProviderCapabilities;
  abstract buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult>;

  // ── Common implementations ────────────────────────────────────────────

  /** Find the CLI binary using well-known paths and PATH scan */
  protected findBinary(): string {
    return findBinaryInPath(this.binaryNames, this.getExtraBinaryPaths());
  }

  /** Check if the CLI binary is available */
  async checkAvailability(_envOverride?: Record<string, string>): Promise<{ available: boolean; error?: string }> {
    try {
      this.findBinary();
      return { available: true };
    } catch (err: unknown) {
      return {
        available: false,
        error: err instanceof Error ? err.message : `Could not find ${this.displayName}`,
      };
    }
  }

  /** Command to send to the PTY to exit the CLI */
  getExitCommand(): string {
    return '/exit\r';
  }

  /** Read project instructions from the conventional file location */
  readInstructions(worktreePath: string): string {
    const filePath = this.getInstructionsPath(worktreePath);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  /** Write project instructions to the conventional file location */
  writeInstructions(worktreePath: string, content: string): void {
    const filePath = this.getInstructionsPath(worktreePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /** Get available model options, with optional dynamic fetching */
  async getModelOptions(): Promise<Array<{ id: string; label: string }>> {
    if (this.modelFetchConfig) {
      try {
        const binary = this.findBinary();
        const { stdout } = await execFileAsync(binary, this.modelFetchConfig.args, {
          timeout: this.modelFetchConfig.timeout ?? 5000,
          shell: process.platform === 'win32',
          env: getShellEnvironment(),
        });
        const parsed = this.modelFetchConfig.parser(stdout);
        if (parsed) return parsed;
      } catch {
        // Fall back to static list
      }
    }
    return [...this.fallbackModelOptions];
  }

  /** Get default permission sets */
  getDefaultPermissions(kind: 'durable' | 'quick'): string[] {
    return kind === 'durable' ? [...this.durablePermissions] : [...this.quickPermissions];
  }

  /** Map tool name to a human-readable verb */
  toolVerb(toolName: string): string | undefined {
    return this.toolVerbs[toolName];
  }

  /** Environment variable keys used for config isolation */
  getProfileEnvKeys(): string[] {
    return [...this.configEnvKeys];
  }

  /** Default paste submit timing — works for Claude Code's paste preview flow */
  getPasteSubmitTiming(): PasteSubmitTiming {
    return { initialDelayMs: 200, retryDelayMs: 200, finalCheckDelayMs: 200 };
  }
}
