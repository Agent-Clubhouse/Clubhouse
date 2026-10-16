import type { StructuredAdapter, StructuredSessionOpts } from '../types';
import type { StructuredEvent } from '../../../shared/structured-events';
import { AsyncQueue } from './async-queue';
import { AcpClient, RpcError } from './acp-client';
import { getShellEnvironment, cleanSpawnEnv } from '../../util/shell';
import { appLog } from '../../services/log-service';
import { resolveStructuredSpawn } from './structured-spawn';

/** JSON-RPC "Method not found" — the standard reply for a request we can't serve. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

/** ACP v1 `PermissionOption` (see session/request_permission). */
interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

interface PendingPermission {
  rpcId: string | number;
  options: AcpPermissionOption[];
}

export interface AcpAdapterOpts {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  toolVerbs?: Record<string, string>;
}

/**
 * StructuredAdapter implementation for ACP (Agent Client Protocol).
 *
 * Protocol flow (ACP v1):
 *   1. initialize (handshake with protocolVersion)
 *   2. session/new (create session, get sessionId)
 *   3. session/prompt — streams `session/update` notifications and answers
 *      only when the turn is over, with a `stopReason`
 *
 * Translates ACP JSON-RPC notifications/requests into StructuredEvents.
 * Agent output arrives as `session/update` notifications whose `update`
 * object is discriminated by `update.sessionUpdate`.
 */
export class AcpAdapter implements StructuredAdapter {
  private client: AcpClient | null = null;
  private queue: AsyncQueue<StructuredEvent> | null = null;
  private pendingApprovals = new Map<string, PendingPermission>();
  /** Tool names by toolCallId — `tool_call_update` usually omits the name. */
  private toolNames = new Map<string, string>();
  private sessionId: string | null = null;
  private turnEnded = false;
  private opts: AcpAdapterOpts;

  constructor(opts: AcpAdapterOpts) {
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

    const args = [...this.opts.args];
    if (sessionOpts.model) {
      args.push('--model', sessionOpts.model);
    }
    if (sessionOpts.allowedTools) {
      for (const tool of sessionOpts.allowedTools) {
        args.push('--allow-tool', tool);
      }
    }
    if (sessionOpts.disallowedTools) {
      for (const tool of sessionOpts.disallowedTools) {
        args.push('--deny-tool', tool);
      }
    }
    if (sessionOpts.permissionMode === 'skip-all') {
      args.push('--allow-all-tools');
    }
    // Append extra CLI args (e.g. MCP server config flags from the spawn path)
    if (sessionOpts.extraArgs) {
      args.push(...sessionOpts.extraArgs);
    }

    // Command prefix → shell wrapper; Windows .cmd/.bat shims → cmd.exe
    const spawn = resolveStructuredSpawn(this.opts.binary, args, sessionOpts.commandPrefix);

    appLog('core:structured', 'info', 'AcpAdapter spawning', {
      meta: { binary: spawn.binary, cwd: sessionOpts.cwd, model: sessionOpts.model },
    });

    this.client = new AcpClient({
      binary: spawn.binary,
      args: spawn.args,
      windowsVerbatimArguments: spawn.windowsVerbatimArguments,
      cwd: sessionOpts.cwd,
      env,
      onNotification: (method, params) => {
        for (const event of this.mapNotification(method, params)) queue.push(event);
      },
      onServerRequest: (id, method, params) => {
        const event = this.mapServerRequest(id, method, params);
        if (event) {
          queue.push(event);
          return;
        }
        // Nothing will ever answer this id, and the agent blocks its turn on
        // it — reject now rather than stall silently.
        this.client?.respondWithError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `Clubhouse does not handle the '${method}' request`,
        );
        queue.push(this.makeEvent('error', {
          code: 'unhandled_server_request',
          message: `The agent asked for '${method}', which Clubhouse cannot answer. That step was declined.`,
        }));
      },
      onExit: (code) => {
        const stderr = this.client?.getStderr()?.trim();
        if (stderr) {
          appLog('core:structured', 'warn', 'AcpAdapter process stderr on exit', {
            meta: { stderr: stderr.length > 2000 ? stderr.substring(0, 2000) + '…' : stderr },
          });
        }
        if (!this.turnEnded) {
          this.turnEnded = true;
          queue.push(this.makeEvent('end', {
            reason: code === 0 ? 'complete' : 'error',
            summary: code === 0 ? undefined : `Process exited with code ${code}`,
          }));
        }
        queue.finish();
      },
      onLog: (level, message, meta) => {
        appLog('core:structured:acp', level, message, { meta });
      },
    });

    // Start client (spawns process + init handshake) then create session + prompt
    this.client.start()
      .then(() => this.startSession(sessionOpts))
      .catch((err) => {
        const isRpcError = err instanceof RpcError;
        appLog('core:structured', 'error', 'AcpAdapter startup failed', {
          meta: {
            error: err instanceof Error ? err.message : String(err),
            ...(isRpcError ? { rpcCode: err.code, rpcData: err.data } : {}),
          },
        });
        queue.push(this.makeEvent('error', {
          code: 'session_start_failed',
          message: err instanceof Error ? err.message : String(err),
        }));
        queue.push(this.makeEvent('end', {
          reason: 'error',
          summary: err instanceof Error ? err.message : String(err),
        }));
        this.turnEnded = true;
        queue.finish();
      });

    return queue;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error('Adapter not started');
    if (!this.sessionId) throw new Error('No active session');
    // The prompt's reply arrives only when the turn ends, possibly minutes
    // from now; its outcome is reported through the event stream.
    void this.runPrompt([{ type: 'text', text: message }]);
  }

  async respondToPermission(
    requestId: string,
    approved: boolean,
    _reason?: string,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) {
      throw new Error(`No pending approval for request ${requestId}`);
    }
    this.pendingApprovals.delete(requestId);

    // ACP answers with one of the offered options.  Prefer the one-shot kind
    // so a single decision is never remembered beyond this call.
    const kinds = approved ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    const option = kinds
      .map((kind) => pending.options.find((o) => o.kind === kind))
      .find((o): o is AcpPermissionOption => o !== undefined);

    if (!option) {
      appLog('core:structured:acp', 'warn', 'No matching permission option; answering cancelled', {
        meta: { requestId, approved, kinds: pending.options.map((o) => o.kind) },
      });
    }

    this.client?.respond(pending.rpcId, {
      outcome: option
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' },
    });
  }

  /**
   * Cancel the running turn with ACP's `session/cancel`.  The agent then
   * answers the in-flight prompt with stopReason `cancelled`, which ends the
   * turn.  Falls back to killing when there is no turn to cancel.
   */
  async cancel(): Promise<void> {
    if (!this.client) return;

    if (this.sessionId && !this.turnEnded && this.client.alive) {
      // The spec requires every pending permission request to be answered
      // `cancelled` once the client cancels.
      for (const { rpcId } of this.pendingApprovals.values()) {
        this.client.respond(rpcId, { outcome: { outcome: 'cancelled' } });
      }
      this.pendingApprovals.clear();
      this.client.notify('session/cancel', { sessionId: this.sessionId });
      return;
    }

    this.client.kill();
  }

  dispose(): void {
    this.client?.kill();
    this.queue?.finish();
    this.client = null;
    this.queue = null;
    this.sessionId = null;
    this.pendingApprovals.clear();
    this.toolNames.clear();
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  private async startSession(sessionOpts: StructuredSessionOpts): Promise<void> {
    if (!this.client) return;

    // Create a new session
    const sessionResult = await this.client.request('session/new', {
      cwd: sessionOpts.cwd,
      mcpServers: [],
    }) as { sessionId?: string } | undefined;

    this.sessionId = sessionResult?.sessionId ?? null;

    if (!this.sessionId) {
      appLog('core:structured:acp', 'error', 'session/new returned no session ID', {
        meta: { result: sessionResult },
      });
      throw new Error('Failed to create session: no session ID returned');
    }

    appLog('core:structured:acp', 'info', 'ACP session created', {
      meta: { sessionId: this.sessionId },
    });

    // Build prompt parts from system prompt + mission
    const parts: Array<{ type: string; text: string }> = [];
    if (sessionOpts.systemPrompt) {
      parts.push({ type: 'text', text: sessionOpts.systemPrompt });
    }
    if (sessionOpts.mission) {
      parts.push({ type: 'text', text: sessionOpts.mission });
    }

    if (parts.length === 0) return;

    // Send the initial prompt
    await this.runPrompt(parts);
  }

  /**
   * Send `session/prompt` and end the turn from its reply.  Never rejects:
   * the outcome is reported as events.  No RPC timeout — the reply arrives
   * only when the whole turn is over, which can take many minutes.
   */
  private async runPrompt(prompt: Array<{ type: string; text: string }>): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.turnEnded = false;

    let result: { stopReason?: unknown } | undefined;
    try {
      result = await client.request('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      }, { timeoutMs: null }) as { stopReason?: unknown } | undefined;
    } catch (err) {
      // A process exit has already ended the turn; anything else is a failure.
      if (this.turnEnded || this.client !== client) return;
      const message = err instanceof Error ? err.message : String(err);
      this.endTurn('error', message, { code: 'prompt_failed', message });
      return;
    }

    if (this.turnEnded || this.client !== client) return;
    this.completeTurn(result?.stopReason);
  }

  /** End the turn according to the ACP `StopReason` of the prompt reply. */
  private completeTurn(stopReason: unknown): void {
    switch (stopReason) {
      case 'end_turn':
        this.endTurn('complete');
        return;
      case 'cancelled':
        this.endTurn('cancelled', 'Turn cancelled');
        return;
      case 'max_tokens':
        this.endTurn('error', 'The agent reached its maximum token limit', {
          code: 'max_tokens',
          message: 'The agent reached its maximum token limit',
        });
        return;
      case 'max_turn_requests':
        this.endTurn('error', 'The agent reached its maximum number of requests for this turn', {
          code: 'max_turn_requests',
          message: 'The agent reached its maximum number of requests for this turn',
        });
        return;
      case 'refusal':
        this.endTurn('error', 'The agent refused to continue', {
          code: 'refusal',
          message: 'The agent refused to continue',
        });
        return;
      default:
        appLog('core:structured:acp', 'warn', 'session/prompt returned an unknown stopReason', {
          meta: { stopReason },
        });
        this.endTurn('complete');
    }
  }

  private endTurn(
    reason: 'complete' | 'error' | 'cancelled',
    summary?: string,
    error?: { code: string; message: string },
  ): void {
    this.turnEnded = true;
    this.pendingApprovals.clear();
    if (error) this.queue?.push(this.makeEvent('error', error));
    this.queue?.push(this.makeEvent('end', { reason, summary }));
    this.queue?.finish();
  }

  // ── Event mapping ─────────────────────────────────────────────────────────

  private mapNotification(method: string, params: unknown): StructuredEvent[] {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method !== 'session/update') {
      appLog('core:structured:acp', 'debug', `Unmapped ACP notification: ${method}`, {
        meta: { method, paramsKeys: Object.keys(p) },
      });
      return [];
    }

    const update = (p.update ?? {}) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? '');

    switch (kind) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = this.contentText(update.content);
        if (text === null) return [];
        return [kind === 'agent_message_chunk'
          ? this.makeEvent('text_delta', { text })
          : this.makeEvent('thinking', { text, isPartial: true })];
      }

      case 'tool_call': {
        const id = String(update.toolCallId ?? '');
        const name = this.toolName(update);
        this.toolNames.set(id, name);
        const events = [this.makeEvent('tool_start', {
          id,
          name,
          displayVerb: this.resolveToolVerb(name),
          input: this.asRecord(update.rawInput),
        })];
        // A tool call may be reported already finished.
        const end = this.toolEnd(id, update);
        if (end) events.push(end);
        return events;
      }

      case 'tool_call_update': {
        const id = String(update.toolCallId ?? '');
        if (typeof update.name === 'string' && update.name) this.toolNames.set(id, update.name);
        const end = this.toolEnd(id, update);
        return end ? [end] : [];
      }

      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries as Array<Record<string, unknown>> : [];
        return [this.makeEvent('plan_update', {
          steps: entries.map((e) => ({
            description: String(e.content ?? ''),
            status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
          })),
        })];
      }

      default:
        // user_message_chunk, available_commands_update, current_mode_update,
        // usage_update (context-window size, not per-turn tokens), …
        appLog('core:structured:acp', 'debug', `Unmapped ACP session update: ${kind}`, {
          meta: { sessionUpdate: kind, keys: Object.keys(update) },
        });
        return [];
    }
  }

  /** tool_end for a tool call whose status is terminal, else null. */
  private toolEnd(id: string, update: Record<string, unknown>): StructuredEvent | null {
    if (update.status !== 'completed' && update.status !== 'failed') return null;
    const name = this.toolNames.get(id) ?? this.toolName(update);
    this.toolNames.delete(id);
    return this.makeEvent('tool_end', {
      id,
      name,
      result: this.toolResult(update),
      durationMs: 0,
      status: update.status === 'completed' ? 'success' : 'error',
    });
  }

  private mapServerRequest(
    rpcId: number | string,
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    if (method !== 'session/request_permission') return null;

    const p = (params ?? {}) as Record<string, unknown>;
    const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
    const options = Array.isArray(p.options)
      ? (p.options as AcpPermissionOption[]).filter((o) => typeof o?.optionId === 'string')
      : [];
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '';
    const requestId = toolCallId && !this.pendingApprovals.has(toolCallId)
      ? toolCallId
      : `perm-${rpcId}`;

    this.pendingApprovals.set(requestId, { rpcId, options });

    const toolName = (typeof toolCall.name === 'string' && toolCall.name)
      || this.toolNames.get(toolCallId)
      || this.toolName(toolCall);
    return this.makeEvent('permission_request', {
      id: requestId,
      toolName,
      toolInput: this.asRecord(toolCall.rawInput),
      description: typeof toolCall.title === 'string' && toolCall.title
        ? toolCall.title
        : `${this.resolveToolVerb(toolName)} ${toolName}`,
    });
  }

  // ── Payload helpers ───────────────────────────────────────────────────────

  /** Programmatic tool name, falling back to the ACP tool kind. */
  private toolName(toolCall: Record<string, unknown>): string {
    if (typeof toolCall.name === 'string' && toolCall.name) return toolCall.name;
    if (typeof toolCall.kind === 'string' && toolCall.kind) return toolCall.kind;
    return 'tool';
  }

  /** Text of a ContentBlock, or null for non-text content. */
  private contentText(block: unknown): string | null {
    const b = (block ?? {}) as Record<string, unknown>;
    return b.type === 'text' && typeof b.text === 'string' ? b.text : null;
  }

  /** Readable result of a tool call: its text content, else its raw output. */
  private toolResult(update: Record<string, unknown>): string {
    const content = Array.isArray(update.content) ? update.content as Array<Record<string, unknown>> : [];
    const texts = content
      .filter((c) => c?.type === 'content')
      .map((c) => this.contentText(c.content))
      .filter((t): t is string => t !== null);
    if (texts.length > 0) return texts.join('\n');
    if (update.rawOutput == null) return '';
    return typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
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
