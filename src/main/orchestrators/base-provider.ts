import * as fsp from 'fs/promises';
import * as os from 'os';
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
  ListModelsOptions,
  ModelInfo,
  ModelList,
} from './types';
import { findBinaryInPath, testBinaryOverride, testModelProbesDisabled } from './shared';
import { getShellEnvironment } from '../util/shell';
import type { ModelProbeContext } from './model-probes';
import type { ContextWindowOptions } from '../../shared/context-window';
import { appLog } from '../services/log-service';

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

/** How long a live model list is reused before the CLI is asked again. */
export const MODEL_LIST_TTL_MS = 10 * 60_000;
/** A fallback list is retried sooner: the live source may have been briefly unavailable. */
export const FALLBACK_MODEL_LIST_TTL_MS = 60_000;
/** Deadline for a live model handshake, after which the probe is killed. */
export const MODEL_PROBE_TIMEOUT_MS = 10_000;

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

  /**
   * Optional live model source: the CLI's own handshake (model-probes.ts).
   * Must never send a prompt. Return null when the CLI listed nothing.
   */
  protected probeLiveModels?(ctx: ModelProbeContext): Promise<ModelInfo[] | null>;

  private readonly modelCache = new Map<string, { list: ModelList; expires: number }>();
  private readonly modelLoads = new Map<string, Promise<ModelList>>();
  private readonly contextCatalogCache = new Map<string, { value: unknown; expires: number }>();
  private readonly contextCatalogLoads = new Map<string, Promise<unknown>>();

  // ── Abstract: must be implemented by each provider ────────────────────

  abstract getCapabilities(): ProviderCapabilities;
  abstract buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult>;

  // ── Common implementations ────────────────────────────────────────────

  /** Find the CLI binary using well-known paths and PATH scan (or the test override, in unpackaged builds). */
  protected findBinary(): string {
    return testBinaryOverride(this.id) ?? findBinaryInPath(this.binaryNames, this.getExtraBinaryPaths());
  }

  /** Absolute path of the user's installed CLI. Used by chat drivers, which never bundle a binary. */
  getBinaryPath(): string {
    return this.findBinary();
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
  async readInstructions(worktreePath: string): Promise<string> {
    const filePath = this.getInstructionsPath(worktreePath);
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  /** Write project instructions to the conventional file location */
  async writeInstructions(worktreePath: string, content: string): Promise<void> {
    const filePath = this.getInstructionsPath(worktreePath);
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, content, 'utf-8');
  }

  /** Model options for the pickers: listModels without hidden models, as `{ id, label }`. */
  async getModelOptions(opts?: ListModelsOptions): Promise<Array<{ id: string; label: string }>> {
    const { models } = await this.listModels(opts);
    return models.filter((m) => !m.hidden).map(({ id, label }) => ({ id, label }));
  }

  /**
   * The models this CLI accepts: its live handshake, else the older command
   * probe, else the static list. Cached per profile env; concurrent
   * callers share one probe.
   */
  async listModels(opts: ListModelsOptions = {}): Promise<ModelList> {
    const key = JSON.stringify(Object.entries(opts.env ?? {}).sort());
    const cached = this.modelCache.get(key);
    if (cached && !opts.refresh && cached.expires > Date.now()) return copyModelList(cached.list);
    let load = this.modelLoads.get(key);
    if (!load) {
      load = this.loadModels(opts).finally(() => this.modelLoads.delete(key));
      this.modelLoads.set(key, load);
    }
    const list = await load;
    const ttl = list.source === 'live' ? MODEL_LIST_TTL_MS : FALLBACK_MODEL_LIST_TTL_MS;
    this.modelCache.set(key, { list, expires: list.fetchedAt + ttl });
    return copyModelList(list);
  }

  /** No context setting unless the provider has one (#2660). */
  async getContextWindowOptions(_model: string | undefined, _opts?: ListModelsOptions): Promise<ContextWindowOptions> {
    return { configurable: false, state: 'unsupported', label: 'Context', reason: `${this.displayName} has no context setting.` };
  }

  /**
   * A catalog read that needs a process, cached per profile env with one read
   * shared by concurrent callers. A failed read is remembered too, for less
   * time, so a CLI that can't answer isn't spawned on every look.
   */
  protected cachedContextCatalog<T>(opts: ListModelsOptions | undefined, read: () => Promise<T | null>): Promise<T | null> {
    const key = JSON.stringify(Object.entries(opts?.env ?? {}).sort());
    const cached = this.contextCatalogCache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value as T | null);
    let load = this.contextCatalogLoads.get(key);
    if (!load) {
      load = read().catch((err: unknown): null => {
        appLog('core:orchestrator', 'info', 'Context catalog unavailable', { meta: { provider: this.id, error: err instanceof Error ? err.message : String(err) } });
        return null;
      }).then((value) => {
        this.contextCatalogCache.set(key, { value, expires: Date.now() + (value ? MODEL_LIST_TTL_MS : FALLBACK_MODEL_LIST_TTL_MS) });
        return value;
      }).finally(() => this.contextCatalogLoads.delete(key));
      this.contextCatalogLoads.set(key, load);
    }
    return load as Promise<T | null>;
  }

  /** Whether the CLI accepts `model`: a listed id, or `default`. Providers add their own aliases. */
  acceptsModel(model: string, list: ModelList): boolean {
    return model === 'default' || list.models.some((m) => m.id === model);
  }

  private async loadModels(opts: ListModelsOptions): Promise<ModelList> {
    let liveError: string | undefined;
    if (this.probeLiveModels && !testModelProbesDisabled()) {
      try {
        const models = await this.runLiveProbe(opts);
        if (models?.length) return { models, source: 'live', via: 'handshake', fetchedAt: Date.now() };
        liveError = 'the CLI listed no models';
      } catch (err) {
        liveError = err instanceof Error ? err.message : String(err);
      }
      appLog('core:orchestrator', 'warn', 'Live model list unavailable; using the fallback', {
        meta: { provider: this.id, error: liveError },
      });
    }
    const fallback = (via: ModelList['via'], models: ModelInfo[]): ModelList => ({
      models, source: 'fallback', via, fetchedAt: Date.now(), ...(liveError && { liveError }),
    });
    if (this.modelFetchConfig) {
      try {
        const binary = this.findBinary();
        const { stdout } = await execFileAsync(binary, this.modelFetchConfig.args, {
          timeout: this.modelFetchConfig.timeout ?? 5000,
          shell: process.platform === 'win32',
          env: { ...getShellEnvironment(), ...opts.env },
        });
        const parsed = this.modelFetchConfig.parser(stdout);
        if (parsed) return fallback('command', parsed);
      } catch {
        // Fall back to static list
      }
    }
    return fallback('static', this.fallbackModelOptions.map((m) => ({ ...m })));
  }

  /**
   * Run the probe in a fresh empty temp dir, removed once the probe has
   * settled: a project or the home dir could carry a CLAUDE.md, .claude,
   * .codex or hooks that load as if it were a project. User-level settings
   * still apply.
   */
  private async runLiveProbe(opts: ListModelsOptions): Promise<ModelInfo[] | null> {
    const binary = this.findBinary();
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-models-'));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`model handshake timed out after ${MODEL_PROBE_TIMEOUT_MS}ms`));
      }, MODEL_PROBE_TIMEOUT_MS);
    });
    const probe = this.probeLiveModels!({
      binary,
      cwd,
      env: opts.env,
      signal: controller.signal,
      timeoutMs: MODEL_PROBE_TIMEOUT_MS,
      log: (level, message, meta) => appLog('core:orchestrator', level === 'info' ? 'debug' : level, `[models:${this.id}] ${message}`, { meta }),
    });
    // After a timeout the killed probe may still be exiting; remove the dir once it has.
    void probe.catch((): null => null).finally(() => fsp.rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err: unknown) => {
      // telemetry-exempt: an empty temp dir left behind; logged
      appLog('core:orchestrator', 'debug', 'Could not remove the model probe dir', { meta: { provider: this.id, error: err instanceof Error ? err.message : String(err) } });
    }));
    try {
      return await Promise.race([probe, deadline]);
    } finally {
      clearTimeout(timer);
    }
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
    return {
      initialDelayMs: 500,
      retryDelayMs: 300,
      finalCheckDelayMs: 250,
      chunkSize: 512,
      chunkDelayMs: 50,
      postEndMarkerDelayMs: 150,
    };
  }
}

function copyModelList(list: ModelList): ModelList {
  return { ...list, models: list.models.map((m) => ({ ...m, ...(m.efforts && { efforts: [...m.efforts] }) })) };
}
