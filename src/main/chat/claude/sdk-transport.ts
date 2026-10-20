import type { ChildProcess } from 'child_process';
import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../../orchestrators/adapters/async-queue';
import type { ClaudePermissionMode } from './events';
import { initializedFromWire, type ClaudeWireMessage } from './normalizer';
import { loadClaudeAgentSdk } from './sdk-loader';
import { killStructuredChild } from '../../orchestrators/adapters/structured-spawn';
import { buildClaudeEnv, spawnClaude } from './spawn';
import {
  appliedSettingsFromWire,
  ClaudeStartupTimeoutError,
  ClaudeTransportBase,
  toWireUserMessage,
  type ClaudeAppliedSettings,
  type ClaudeEffort,
  type ClaudeTransportLog,
  type ClaudeTransportOptions,
  type ClaudeUserInput,
} from './transport';

type ClaudeAgentSdk = Awaited<ReturnType<typeof loadClaudeAgentSdk>>;

/** How long close() waits for the CLI to exit on its own after stdin ends. */
const CLOSE_GRACE_MS = 5_000;

/**
 * Clubhouse's own budget for the SDK's `initialize` handshake
 * (`query.initializationResult()`), independent of anything the SDK enforces.
 * The same as stream-json's control timeout for the same request: it covers
 * real starts too (resume, MCP servers, a command prefix), not just the probe.
 * Past it, start() closes the query (which kills the CLI) and throws
 * ClaudeStartupTimeoutError, so preflight fails and the fallback chain moves
 * on to stream-json, then the terminal. Model turns have no such deadline.
 */
export const SDK_INIT_TIMEOUT_MS = 30_000;

/**
 * Default Claude chat transport: the Claude Agent SDK's `query()` with
 * streaming input, pointed at the user's own `claude`
 * (docs/structured-chat-research.md §7 "SdkTransport").
 *
 * The SDK is loaded lazily from its own webpack chunk. Its bundled CLI binary
 * is never used: `pathToClaudeCodeExecutable` is always the user's install,
 * and the process is spawned through Clubhouse's own spawn rules.
 */
export class ClaudeSdkTransport extends ClaudeTransportBase {
  readonly kind = 'sdk' as const;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private query: Query | null = null;
  private child: ChildProcess | null = null;
  private pump: Promise<void> | null = null;

  constructor(
    opts: ClaudeTransportOptions,
    /** Injectable for tests. */
    private readonly loadSdk: () => Promise<Pick<ClaudeAgentSdk, 'query'>> = loadClaudeAgentSdk,
  ) {
    super(opts);
  }

  async start(): Promise<void> {
    if (this.query) throw new Error('Claude SDK transport already started');
    const sdk = await this.loadSdk();
    const { opts } = this;
    const options: Options = {
      cwd: opts.cwd,
      pathToClaudeCodeExecutable: opts.binary,
      env: buildClaudeEnv(opts.env),
      permissionMode: opts.permissionMode,
      allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions' || undefined,
      model: opts.model,
      effort: opts.effort,
      mcpServers: opts.mcpServers as Options['mcpServers'],
      resume: opts.resume,
      forkSession: opts.forkSession,
      resumeSessionAt: opts.resumeSessionAt,
      includePartialMessages: opts.includePartialMessages ?? true,
      // Keep Claude Code's own prompt, as the TUI does; omitting it gives an empty prompt.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt },
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      additionalDirectories: opts.additionalDirectories,
      canUseTool: async (toolName, input, o) => {
        const requestId = (o as { requestId?: string }).requestId ?? o.toolUseID;
        const result = await this.awaitPermission({
          kind: 'permission_request',
          requestId,
          toolName,
          input,
          toolCallId: o.toolUseID,
          suggestions: o.suggestions ?? [],
          title: o.title,
          description: o.description,
          displayName: o.displayName,
          blockedPath: o.blockedPath,
          decisionReason: o.decisionReason,
          agentId: o.agentID,
        }, o.signal);
        // Cancelled by the CLI: the SDK drops this answer, but canUseTool must return one.
        return (result ?? { behavior: 'deny', message: 'Request cancelled', toolUseID: o.toolUseID }) as PermissionResult;
      },
      spawnClaudeCodeProcess: (so) => {
        const child = sdkSpawnHook(so, opts.commandPrefix, (level, message, meta) => this.log(level, message, meta));
        this.child = child;
        return child as unknown as SpawnedProcess;
      },
    };

    this.log('info', 'Starting Claude SDK session', {
      binary: opts.binary, cwd: opts.cwd, permissionMode: opts.permissionMode, resume: opts.resume,
    });
    const query = sdk.query({ prompt: this.input, options });
    this.query = query;
    this.pump = this.drain(query);
    const init = await this.initialized(query);
    this.pushEvent(initializedFromWire(init as unknown as Record<string, unknown>));
  }

  /** `initializationResult()` under SDK_INIT_TIMEOUT_MS; on timeout, closes the query and its CLI first. */
  private async initialized(query: Query): ReturnType<Query['initializationResult']> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ClaudeStartupTimeoutError(SDK_INIT_TIMEOUT_MS)), SDK_INIT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([query.initializationResult(), deadline]);
    } catch (err) {
      if (err instanceof ClaudeStartupTimeoutError) {
        this.log('warn', 'Claude SDK initialization timed out; closing query', { timeoutMs: SDK_INIT_TIMEOUT_MS });
        try {
          query.close();
        } catch (closeErr) {
          this.log('warn', 'Claude SDK query close failed', { error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
        }
        // query.close() aborts the spawn signal, which kills the CLI; kill it directly too in case it didn't.
        if (this.child) void killStructuredChild(this.child, { endStdin: false });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async drain(query: Query): Promise<void> {
    let reason: string | undefined;
    try {
      for await (const msg of query) this.pushWire(msg as unknown as ClaudeWireMessage);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      this.log('error', 'Claude SDK stream failed', { error: reason });
      this.pushEvent({ kind: 'error', message: reason, fatal: true });
    } finally {
      const status = await this.childExit();
      this.end(status.code, status.signal, reason);
    }
  }

  /** The CLI's exit status; the stream can end a moment before the process does. */
  private async childExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const child = this.child;
    if (!child) return { code: null, signal: null };
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    return { code: child.exitCode, signal: child.signalCode };
  }

  send(input: ClaudeUserInput): void {
    if (!this.query || this.isEnded) throw new Error('Claude SDK session is not running');
    this.input.push(toWireUserMessage(input, this.sessionId) as unknown as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    await this.requireQuery().interrupt();
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    await this.requireQuery().setPermissionMode(mode);
  }

  async setModel(model?: string): Promise<void> {
    await this.requireQuery().setModel(model);
  }

  async setEffort(effort: ClaudeEffort | null): Promise<void> {
    await this.requireQuery().applyFlagSettings({ effortLevel: effort });
  }

  async appliedSettings(): Promise<ClaudeAppliedSettings> {
    // getSettings is on the SDK's Query at runtime but not in its published types.
    const query = this.requireQuery() as Query & { getSettings?: () => Promise<unknown> };
    if (!query.getSettings) return {};
    return appliedSettingsFromWire(await query.getSettings());
  }

  async planUsage(): Promise<unknown> {
    // Experimental in the SDK: absent from older versions, so the driver treats it as optional.
    const query = this.requireQuery() as Query & { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors?: boolean }) => Promise<unknown> };
    if (!query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return null;
    return query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  }

  async close(): Promise<void> {
    if (!this.query) return;
    this.input.finish();
    const exited = await Promise.race([
      this.pump?.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), CLOSE_GRACE_MS).unref?.()),
    ]);
    if (!exited) {
      this.log('warn', 'Claude did not exit after stdin closed; closing query');
      this.query.close();
      // Bounded too: a query that doesn't end on close must not hang close() (#2274).
      await Promise.race([
        this.pump,
        new Promise<void>((r) => setTimeout(r, CLOSE_GRACE_MS).unref?.()),
      ]);
    }
  }

  private requireQuery(): Query {
    if (!this.query || this.isEnded) throw new Error('Claude SDK session is not running');
    return this.query;
  }
}

/**
 * Session helpers over the CLI's on-disk JSONL (SDK `listSessions` / `getSessionMessages`).
 *
 * `includeWorktrees` defaults to false here (the SDK defaults to true): each
 * Clubhouse agent runs in its own worktree, so its sessions are the ones for
 * that cwd. Including worktrees also makes the SDK resolve and run
 * `git worktree list`, which can take seconds on Windows.
 */
export async function listClaudeSessions(cwd: string, opts?: { limit?: number; offset?: number; includeWorktrees?: boolean }) {
  const sdk = await loadClaudeAgentSdk();
  return sdk.listSessions({ dir: cwd, limit: opts?.limit, offset: opts?.offset, includeWorktrees: opts?.includeWorktrees ?? false });
}

export async function readClaudeSession(sessionId: string, cwd: string, opts?: { limit?: number; offset?: number }) {
  const sdk = await loadClaudeAgentSdk();
  return sdk.getSessionMessages(sessionId, { dir: cwd, limit: opts?.limit, offset: opts?.offset });
}

/**
 * The Agent SDK's `spawnClaudeCodeProcess` hook: the user's `claude` under
 * the structured spawn rules. The SDK owns the child's stdin, so:
 * - an 'error' listener keeps a late SDK write (EPIPE, write-after-end once
 *   the process is gone) from becoming an uncaught exception in main;
 * - abort kills the process tree without ending stdin itself.
 */
export function sdkSpawnHook(
  so: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal },
  commandPrefix: string | undefined,
  log: ClaudeTransportLog,
): ChildProcess {
  const child = spawnClaude({ binary: so.command, args: so.args, cwd: so.cwd, env: so.env, commandPrefix });
  child.stdin?.on('error', (err) => log('warn', 'claude stdin error', { error: err.message }));
  child.stderr?.on('data', (d: Buffer) => log('warn', 'claude stderr', { data: d.toString().slice(0, 2000) }));
  so.signal.addEventListener('abort', () => { void killStructuredChild(child, { endStdin: false }); }, { once: true });
  return child;
}
