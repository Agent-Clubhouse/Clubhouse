import type { StructuredAdapter, StructuredSessionOpts } from '../types';
import type { StructuredEvent } from '../../../shared/structured-events';
import { AsyncQueue } from './async-queue';
import { CodexAppServerClient } from './codex-app-server-client';
import { getShellEnvironment, cleanSpawnEnv } from '../../util/shell';
import { appLog } from '../../services/log-service';
import { resolveStructuredSpawn } from './structured-spawn';

/** JSON-RPC "Method not found" — the standard reply for a request we can't serve. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

export interface CodexAppServerAdapterOpts {
  binary: string;
  env?: Record<string, string>;
  toolVerbs?: Record<string, string>;
}

/**
 * StructuredAdapter for the Codex CLI app-server protocol.
 *
 * Spawns `codex app-server --listen stdio://` and communicates via JSON-RPC 2.0
 * over stdin/stdout. Supports multi-turn conversations, streaming text deltas,
 * tool tracking, and bidirectional permission approval flows.
 */
export class CodexAppServerAdapter implements StructuredAdapter {
  private client: CodexAppServerClient | null = null;
  private queue: AsyncQueue<StructuredEvent> | null = null;
  private pendingApprovals = new Map<string, number | string>();
  private threadId: string | null = null;
  /** Id of the turn currently in flight; `turn/interrupt` requires it. */
  private turnId: string | null = null;
  private turnEnded = false;
  /** File paths of in-flight fileChange items — their approval requests omit them. */
  private fileChangeItems = new Map<string, string[]>();
  private opts: CodexAppServerAdapterOpts;

  constructor(opts: CodexAppServerAdapterOpts) {
    this.opts = opts;
  }

  start(sessionOpts: StructuredSessionOpts): AsyncIterable<StructuredEvent> {
    const queue = new AsyncQueue<StructuredEvent>();
    this.queue = queue;

    // Build clean environment
    const env = cleanSpawnEnv({
      ...getShellEnvironment(),
      ...this.opts.env,
      ...sessionOpts.env,
    });

    const args = ['app-server', '--listen', 'stdio://'];

    // Append extra CLI args (e.g. MCP server config flags from the spawn path)
    if (sessionOpts.extraArgs) {
      args.push(...sessionOpts.extraArgs);
    }

    // Command prefix → shell wrapper; Windows .cmd/.bat shims → cmd.exe
    const spawn = resolveStructuredSpawn(this.opts.binary, args, sessionOpts.commandPrefix);

    appLog('core:structured', 'info', 'CodexAppServerAdapter starting session', {
      meta: {
        binary: spawn.binary,
        args: spawn.args,
        cwd: sessionOpts.cwd,
        model: sessionOpts.model,
        hasMission: !!sessionOpts.mission,
        hasSystemPrompt: !!sessionOpts.systemPrompt,
        freeAgentMode: sessionOpts.freeAgentMode,
        commandPrefix: sessionOpts.commandPrefix || 'none',
      },
    });

    this.client = new CodexAppServerClient({
      binary: spawn.binary,
      args: spawn.args,
      windowsVerbatimArguments: spawn.windowsVerbatimArguments,
      cwd: sessionOpts.cwd,
      env,
      onNotification: (method, params) => {
        const event = this.mapNotification(method, params);
        if (event) queue.push(event);
      },
      onServerRequest: (id, method, params) => {
        const event = this.mapServerRequest(id, method, params);
        if (event) {
          queue.push(event);
          return;
        }
        // No mapping produced a pending decision, so nothing will ever call
        // respondToPermission for this id.  Answer now: Codex blocks the turn
        // until a server request is resolved, and a silent stall is much harder
        // to diagnose than a rejected call.
        this.client?.respondWithError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `Clubhouse does not handle the '${method}' request`,
        );
        queue.push(this.makeEvent('error', {
          code: 'unhandled_server_request',
          message: `Codex asked for '${method}', which Clubhouse cannot answer. The turn continues, but that step was declined.`,
        }));
      },
      onExit: (code) => {
        const stderr = this.client?.getStderr()?.trim();
        if (stderr) {
          appLog('core:structured', 'warn', 'CodexAppServerAdapter process stderr on exit', {
            meta: { stderr: stderr.length > 2000 ? stderr.substring(0, 2000) + '…' : stderr },
          });
        }
        if (!this.turnEnded) {
          queue.push(this.makeEvent('end', {
            reason: code === 0 ? 'complete' : 'error',
            summary: code === 0 ? undefined : `Process exited with code ${code}`,
          }));
        }
        queue.finish();
      },
      onLog: (level, message, meta) => {
        appLog('core:structured:codex', level, message, { meta });
      },
    });

    // Start client (spawns process + init handshake) then create thread + turn
    this.client.start()
      .then(() => this.startThread(sessionOpts))
      .catch((err) => {
        appLog('core:structured', 'error', 'CodexAppServerAdapter startup failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        queue.push(this.makeEvent('error', {
          code: 'startup_failed',
          message: err instanceof Error ? err.message : String(err),
        }));
        queue.push(this.makeEvent('end', {
          reason: 'error',
          summary: err instanceof Error ? err.message : String(err),
        }));
        queue.finish();
      });

    return queue;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error('Adapter not started');
    if (!this.threadId) throw new Error('No active thread');

    this.turnEnded = false;

    await this.startTurn(message);
  }

  async respondToPermission(
    requestId: string,
    approved: boolean,
    _reason?: string,
  ): Promise<void> {
    const rpcId = this.pendingApprovals.get(requestId);
    if (rpcId === undefined) {
      throw new Error(`No pending approval for request ${requestId}`);
    }
    this.pendingApprovals.delete(requestId);
    this.client?.respond(rpcId, {
      decision: approved ? 'accept' : 'decline',
    });
  }

  /**
   * Stop the current turn, keeping the thread alive.
   *
   * This used to kill the process, which forfeited the thread and made the
   * session unresumable.  `turn/interrupt` is the protocol's own stop: the
   * thread survives and can be resumed, which is what pressing stop means.
   * Falls back to killing only if the interrupt can't be delivered.
   */
  async cancel(): Promise<void> {
    if (!this.client) return;

    // `turn/interrupt` requires both ids; with no turn in flight there is
    // nothing to interrupt, so fall through to killing the process.
    if (this.threadId && this.turnId && this.client.alive) {
      try {
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId,
        });
        return;
      } catch (err) {
        appLog('core:structured:codex', 'warn', 'turn/interrupt failed; killing the process', {
          meta: { threadId: this.threadId, turnId: this.turnId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    this.client.kill();
  }

  dispose(): void {
    this.client?.kill();
    this.queue?.finish();
    this.client = null;
    this.queue = null;
    this.threadId = null;
    this.turnId = null;
    this.pendingApprovals.clear();
    this.fileChangeItems.clear();
  }

  // ── Thread lifecycle ────────────────────────────────────────────────────────

  private async startThread(sessionOpts: StructuredSessionOpts): Promise<void> {
    if (!this.client) return;

    // Resume an existing thread if sessionId is provided
    if (sessionOpts.sessionId) {
      appLog('core:structured:codex', 'info', 'Resuming thread', {
        meta: { threadId: sessionOpts.sessionId, cwd: sessionOpts.cwd },
      });

      const resumeResult = await this.client.request('thread/resume', {
        threadId: sessionOpts.sessionId,
        cwd: sessionOpts.cwd,
      }) as { thread?: { id?: string } } | undefined;

      this.threadId = resumeResult?.thread?.id ?? sessionOpts.sessionId;

      appLog('core:structured:codex', 'info', 'Thread resumed', { meta: { threadId: this.threadId } });

      // Start a new turn if there's a prompt
      const parts: string[] = [];
      if (sessionOpts.systemPrompt) parts.push(sessionOpts.systemPrompt);
      if (sessionOpts.mission) parts.push(sessionOpts.mission);
      const prompt = parts.join('\n\n');

      if (prompt) {
        await this.startTurn(prompt);
      }

      return;
    }

    appLog('core:structured:codex', 'info', 'Creating thread', {
      meta: { model: sessionOpts.model, cwd: sessionOpts.cwd, freeAgentMode: sessionOpts.freeAgentMode },
    });

    // Create thread
    const threadResult = await this.client.request('thread/start', {
      model: sessionOpts.model,
      cwd: sessionOpts.cwd,
      ...(sessionOpts.freeAgentMode && { sandbox: 'workspace-write' }),
    }) as { thread?: { id?: string } } | undefined;

    this.threadId = threadResult?.thread?.id ?? null;

    if (!this.threadId) {
      appLog('core:structured:codex', 'error', 'thread/start returned no thread ID', {
        meta: { result: threadResult },
      });
      throw new Error('Failed to create thread: no thread ID returned');
    }

    appLog('core:structured:codex', 'info', 'Thread created', { meta: { threadId: this.threadId } });

    // Build the prompt
    const parts: string[] = [];
    if (sessionOpts.systemPrompt) parts.push(sessionOpts.systemPrompt);
    if (sessionOpts.mission) parts.push(sessionOpts.mission);
    const prompt = parts.join('\n\n');

    if (!prompt) return;

    // Start turn
    await this.startTurn(prompt);
  }

  /** Start a turn and record its id for a later `turn/interrupt`. */
  private async startTurn(prompt: string): Promise<void> {
    const result = await this.client!.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
    }) as { turn?: { id?: string } } | undefined;

    if (typeof result?.turn?.id === 'string') {
      this.turnId = result.turn.id;
    }
  }

  // ── Event mapping ─────────────────────────────────────────────────────────
  //
  // Shapes follow the app-server v2 protocol of the CI-pinned Codex CLI
  // (`codex app-server generate-ts`): camelCase item types and fields,
  // string deltas, and the turn's status/error nested under `turn`.

  private mapNotification(
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'turn/started': {
        // Remember the turn so cancel() can interrupt it — `turn/interrupt`
        // requires both threadId and turnId.
        const turn = (p.turn as Record<string, unknown>) ?? {};
        this.turnId = typeof turn.id === 'string' ? turn.id : null;
        return null;
      }

      // { threadId, turnId, itemId, delta: string }
      case 'item/agentMessage/delta':
        return this.makeEvent('text_delta', { text: String(p.delta ?? '') });

      // { threadId, turnId, itemId, delta: string, summaryIndex }
      case 'item/reasoning/summaryTextDelta':
        return this.makeEvent('thinking', {
          text: String(p.delta ?? ''),
          isPartial: true,
        });

      case 'item/started': {
        const item = (p.item as Record<string, unknown>) ?? {};
        return this.mapItemStarted(item);
      }

      case 'item/completed': {
        const item = (p.item as Record<string, unknown>) ?? {};
        for (const event of this.mapItemCompleted(item)) this.queue?.push(event);
        return null; // Already pushed events directly
      }

      // { threadId, turnId, itemId, delta: string }
      case 'item/commandExecution/outputDelta':
        return this.makeEvent('command_output', {
          id: String(p.itemId ?? ''),
          command: '',
          status: 'running' as const,
          output: String(p.delta ?? ''),
          exitCode: undefined,
        });

      // { threadId, turnId, explanation, plan: [{ step, status }] }
      case 'turn/plan/updated': {
        const plan = Array.isArray(p.plan) ? p.plan as Array<Record<string, unknown>> : [];
        return this.makeEvent('plan_update', {
          steps: plan.map((s) => ({
            description: String(s.step ?? ''),
            status: s.status === 'completed' ? 'completed' as const
              : s.status === 'inProgress' ? 'in_progress' as const
                : 'pending' as const,
          })),
        });
      }

      // { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
      // The renderer sums usage events, so report the latest increment.
      case 'thread/tokenUsage/updated': {
        const tokenUsage = (p.tokenUsage as Record<string, unknown>) ?? {};
        const last = (tokenUsage.last as Record<string, unknown>) ?? {};
        return this.makeEvent('usage', {
          inputTokens: Number(last.inputTokens ?? 0),
          outputTokens: Number(last.outputTokens ?? 0),
          cacheReadTokens: last.cachedInputTokens != null ? Number(last.cachedInputTokens) : undefined,
          cacheWriteTokens: last.cacheWriteInputTokens != null ? Number(last.cacheWriteInputTokens) : undefined,
          costUsd: undefined,
        });
      }

      // { threadId, turn: { id, status, error, … } } — usage arrives
      // separately via thread/tokenUsage/updated.
      case 'turn/completed': {
        this.turnEnded = true;
        this.turnId = null;
        const turn = (p.turn as Record<string, unknown>) ?? {};

        if (turn.status === 'failed') {
          const error = (turn.error as Record<string, unknown>) ?? {};
          const message = String(error.message ?? 'Turn failed');
          this.queue?.push(this.makeEvent('error', {
            code: this.codexErrorCode(error.codexErrorInfo),
            message,
          }));
          this.queue?.push(this.makeEvent('end', { reason: 'error', summary: message }));
        } else if (turn.status === 'interrupted') {
          this.queue?.push(this.makeEvent('end', { reason: 'cancelled', summary: 'Turn interrupted' }));
        } else {
          this.queue?.push(this.makeEvent('end', { reason: 'complete', summary: undefined }));
        }
        this.queue?.finish();

        return null; // Already pushed events directly
      }

      // Codex sends configWarning during init — informational, not actionable.
      // Log it and suppress from the UI event stream.
      case 'configWarning': {
        appLog('core:structured:codex', 'info', 'Codex config warning', {
          meta: { message: String(p.summary ?? ''), details: p.details, path: p.path },
        });
        return null;
      }

      default:
        appLog('core:structured:codex', 'info', `Unmapped Codex notification: ${method}`, {
          meta: { method, paramsKeys: Object.keys(p) },
        });
        return null;
    }
  }

  private mapItemStarted(item: Record<string, unknown>): StructuredEvent | null {
    const id = String(item.id ?? '');

    switch (item.type) {
      case 'commandExecution':
        return this.makeEvent('tool_start', {
          id,
          name: 'shell',
          displayVerb: this.resolveToolVerb('shell'),
          input: { command: String(item.command ?? '') },
        });

      case 'fileChange': {
        const paths = this.fileChangePaths(item);
        // The approval request for this item carries no paths; remember them.
        this.fileChangeItems.set(id, paths);
        return this.makeEvent('tool_start', {
          id,
          name: 'apply_patch',
          displayVerb: this.resolveToolVerb('apply_patch'),
          input: { path: paths.join(', ') },
        });
      }

      case 'mcpToolCall': {
        const toolName = String(item.tool ?? 'mcp_tool');
        return this.makeEvent('tool_start', {
          id,
          name: toolName,
          displayVerb: this.resolveToolVerb(toolName),
          input: this.asRecord(item.arguments),
        });
      }

      default:
        return null;
    }
  }

  private mapItemCompleted(item: Record<string, unknown>): StructuredEvent[] {
    const id = String(item.id ?? '');

    switch (item.type) {
      case 'agentMessage':
        return [this.makeEvent('text_done', { text: String(item.text ?? '') })];

      // status: inProgress | completed | failed | declined
      case 'commandExecution':
        return [this.makeEvent('tool_end', {
          id,
          name: 'shell',
          result: String(item.aggregatedOutput ?? ''),
          durationMs: Number(item.durationMs ?? 0),
          status: item.status === 'completed' ? 'success' : 'error',
        })];

      // changes: [{ path, kind: { type: add | delete | update }, diff }]
      case 'fileChange': {
        this.fileChangeItems.delete(id);
        const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : [];
        const events: StructuredEvent[] = [];
        if (item.status === 'completed') {
          for (const change of changes) {
            const kind = (change.kind as Record<string, unknown>) ?? {};
            events.push(this.makeEvent('file_diff', {
              path: String(change.path ?? ''),
              changeType: this.mapFileChangeKind(String(kind.type ?? 'update')),
              diff: String(change.diff ?? ''),
            }));
          }
        }
        events.push(this.makeEvent('tool_end', {
          id,
          name: 'apply_patch',
          result: this.fileChangePaths(item).join(', '),
          durationMs: 0,
          status: item.status === 'completed' ? 'success' : 'error',
        }));
        return events;
      }

      // result: { content, structuredContent } | null, error: { message } | null
      case 'mcpToolCall': {
        const toolName = String(item.tool ?? 'mcp_tool');
        const error = item.error as Record<string, unknown> | null | undefined;
        return [this.makeEvent('tool_end', {
          id,
          name: toolName,
          result: error ? String(error.message ?? '') : this.mcpResultText(item.result),
          durationMs: Number(item.durationMs ?? 0),
          status: error || item.status === 'failed' ? 'error' : 'success',
        })];
      }

      default:
        return [];
    }
  }

  private mapServerRequest(
    rpcId: number | string,
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    const p = (params ?? {}) as Record<string, unknown>;
    // Several approval callbacks can share one itemId (zsh-exec-bridge
    // subcommands); `approvalId` tells them apart when present.
    const approvalKey = typeof p.approvalId === 'string' && p.approvalId
      ? p.approvalId
      : p.itemId;

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const requestId = String(approvalKey ?? `cmd-${rpcId}`);
        this.pendingApprovals.set(requestId, rpcId);
        const command = String(p.command ?? '');
        return this.makeEvent('permission_request', {
          id: requestId,
          toolName: 'shell',
          toolInput: { command },
          description: `Run command: ${command}`,
        });
      }

      // { threadId, turnId, itemId, reason?, grantRoot? } — the paths are on
      // the fileChange item announced by item/started.
      case 'item/fileChange/requestApproval': {
        const requestId = String(approvalKey ?? `file-${rpcId}`);
        this.pendingApprovals.set(requestId, rpcId);
        const path = (this.fileChangeItems.get(String(p.itemId ?? '')) ?? []).join(', ');
        return this.makeEvent('permission_request', {
          id: requestId,
          toolName: 'apply_patch',
          toolInput: { path },
          description: path
            ? `Modify file: ${path}`
            : String(p.reason ?? 'Modify files'),
        });
      }

      default:
        // Deliberately unmapped — the caller answers with a JSON-RPC error so
        // the turn is never left hanging.  The two cases above are the only
        // ones decidable from a yes/no; the rest
        // (item/permissions/requestApproval, item/tool/requestUserInput,
        // item/tool/call, mcpServer/elicitation/request, openai/form, …) need
        // response payloads Clubhouse has no UI to produce yet.
        return null;
    }
  }

  // ── Payload helpers ───────────────────────────────────────────────────────

  private fileChangePaths(item: Record<string, unknown>): string[] {
    const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : [];
    return changes.map((c) => String(c.path ?? '')).filter(Boolean);
  }

  /** `CodexErrorInfo` is either a string or a single-key object variant. */
  private codexErrorCode(info: unknown): string {
    if (typeof info === 'string' && info) return info;
    if (info && typeof info === 'object') {
      const [key] = Object.keys(info);
      if (key) return key;
    }
    return 'turn_failed';
  }

  /** Text blocks of an MCP CallToolResult, else its raw JSON. */
  private mcpResultText(result: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
        .map((c) => String(c.text ?? ''));
      if (texts.length > 0) return texts.join('\n');
    }
    return JSON.stringify(result);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  /** PatchChangeKind.type: add | delete | update. */
  private mapFileChangeKind(kind: string): 'create' | 'modify' | 'delete' {
    switch (kind) {
      case 'add': return 'create';
      case 'delete': return 'delete';
      default: return 'modify';
    }
  }

  private resolveToolVerb(toolName: string): string {
    return this.opts.toolVerbs?.[toolName] ?? 'Using tool';
  }

  private makeEvent(
    type: StructuredEvent['type'],
    data: StructuredEvent['data'],
  ): StructuredEvent {
    return { type, timestamp: Date.now(), data };
  }
}
