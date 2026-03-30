import type { StructuredAdapter, StructuredSessionOpts } from '../types';
import type { StructuredEvent } from '../../../shared/structured-events';
import { AsyncQueue } from './async-queue';
import { AcpClient, RpcError } from './acp-client';
import { getShellEnvironment, cleanSpawnEnv } from '../../util/shell';
import { appLog } from '../../services/log-service';

export interface AcpAdapterOpts {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  toolVerbs?: Record<string, string>;
}

/**
 * StructuredAdapter implementation for ACP (Agent Client Protocol).
 *
 * Protocol flow:
 *   1. initialize (handshake with protocolVersion)
 *   2. initialized (notification)
 *   3. session/new (create session, get sessionId)
 *   4. session/prompt (send prompt to session)
 *
 * Translates ACP JSON-RPC notifications/requests into StructuredEvents.
 */
export class AcpAdapter implements StructuredAdapter {
  private client: AcpClient | null = null;
  private queue: AsyncQueue<StructuredEvent> | null = null;
  private pendingApprovals = new Map<string, string | number>();
  private sessionId: string | null = null;
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

    // When a command prefix is set, wrap via shell so the prefix runs first
    const spawnBinary = sessionOpts.commandPrefix ? 'sh' : this.opts.binary;
    const spawnArgs = sessionOpts.commandPrefix
      ? ['-c', `${sessionOpts.commandPrefix} && exec "$@"`, '_', this.opts.binary, ...args]
      : args;

    appLog('core:structured', 'info', 'AcpAdapter spawning', {
      meta: { binary: spawnBinary, cwd: sessionOpts.cwd, model: sessionOpts.model },
    });

    this.client = new AcpClient({
      binary: spawnBinary,
      args: spawnArgs,
      cwd: sessionOpts.cwd,
      env,
      onNotification: (method, params) => {
        const event = this.mapNotification(method, params);
        if (event) queue.push(event);
      },
      onServerRequest: (id, method, params) => {
        const event = this.mapServerRequest(id, method, params);
        if (event) queue.push(event);
      },
      onExit: (code) => {
        const stderr = this.client?.getStderr()?.trim();
        if (stderr) {
          appLog('core:structured', 'warn', 'AcpAdapter process stderr on exit', {
            meta: { stderr: stderr.length > 2000 ? stderr.substring(0, 2000) + '…' : stderr },
          });
        }
        queue.push(this.makeEvent('end', {
          reason: code === 0 ? 'complete' : 'error',
          summary: code === 0 ? undefined : `Process exited with code ${code}`,
        }));
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
        queue.finish();
      });

    return queue;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error('Adapter not started');
    if (!this.sessionId) throw new Error('No active session');
    await this.client.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: message }],
    });
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
    this.client?.respond(rpcId, { approved });
  }

  async cancel(): Promise<void> {
    if (!this.client) return;
    this.client.kill();
  }

  dispose(): void {
    this.client?.kill();
    this.queue?.finish();
    this.client = null;
    this.queue = null;
    this.sessionId = null;
    this.pendingApprovals.clear();
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
    await this.client.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: parts,
    });
  }

  // ── Event mapping ─────────────────────────────────────────────────────────

  private mapNotification(
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'agent_message_chunk':
        return this.makeEvent('text_delta', {
          text: String(p.text ?? ''),
        });

      case 'agent_thought_chunk':
        return this.makeEvent('thinking', {
          text: String(p.text ?? ''),
          isPartial: true,
        });

      case 'tool_call': {
        if (p.requires_approval) {
          return this.makeEvent('permission_request', {
            id: String(p.id ?? ''),
            toolName: String(p.name ?? ''),
            toolInput: (p.input as Record<string, unknown>) ?? {},
            description: this.resolveToolVerb(String(p.name ?? ''))
              + ' ' + String(p.name ?? ''),
          });
        }
        return this.makeEvent('tool_start', {
          id: String(p.id ?? ''),
          name: String(p.name ?? ''),
          displayVerb: this.resolveToolVerb(String(p.name ?? '')),
          input: (p.input as Record<string, unknown>) ?? {},
        });
      }

      case 'tool_result':
        return this.makeEvent('tool_end', {
          id: String(p.id ?? ''),
          name: String(p.name ?? ''),
          result: String(p.result ?? ''),
          durationMs: Number(p.duration_ms ?? 0),
          status: p.error ? 'error' : 'success',
        });

      case 'file_change':
        return this.makeEvent('file_diff', {
          path: String(p.path ?? ''),
          changeType: (p.change_type as 'create' | 'modify' | 'delete') ?? 'modify',
          diff: String(p.diff ?? ''),
        });

      case 'command_execution':
        return this.makeEvent('command_output', {
          id: String(p.id ?? ''),
          command: String(p.command ?? ''),
          status: (p.status as 'running' | 'completed' | 'failed') ?? 'running',
          output: String(p.output ?? ''),
          exitCode: p.exit_code != null ? Number(p.exit_code) : undefined,
        });

      case 'plan':
        return this.makeEvent('plan_update', {
          steps: Array.isArray(p.steps)
            ? p.steps.map((s: Record<string, unknown>) => ({
                description: String(s.description ?? ''),
                status: (s.status as 'pending' | 'in_progress' | 'completed' | 'failed') ?? 'pending',
              }))
            : [],
        });

      case 'usage':
        return this.makeEvent('usage', {
          inputTokens: Number(p.input_tokens ?? 0),
          outputTokens: Number(p.output_tokens ?? 0),
          cacheReadTokens: p.cache_read_tokens != null ? Number(p.cache_read_tokens) : undefined,
          cacheWriteTokens: p.cache_write_tokens != null ? Number(p.cache_write_tokens) : undefined,
          costUsd: p.cost_usd != null ? Number(p.cost_usd) : undefined,
        });

      case 'error':
        return this.makeEvent('error', {
          code: String(p.code ?? 'unknown'),
          message: String(p.message ?? ''),
          toolId: p.tool_id != null ? String(p.tool_id) : undefined,
        });

      // GHCP sends session/update during streaming with token counts and status.
      // Map to usage events when token data is present, otherwise suppress.
      case 'session/update': {
        const inputTokens = p.input_tokens ?? p.inputTokens;
        const outputTokens = p.output_tokens ?? p.outputTokens;
        if (inputTokens != null || outputTokens != null) {
          return this.makeEvent('usage', {
            inputTokens: Number(inputTokens ?? 0),
            outputTokens: Number(outputTokens ?? 0),
            cacheReadTokens: p.cache_read_tokens != null ? Number(p.cache_read_tokens) : undefined,
            cacheWriteTokens: undefined,
            costUsd: p.cost_usd != null ? Number(p.cost_usd) : undefined,
          });
        }
        // Status-only updates (no token data) — silently ignore
        return null;
      }

      default:
        appLog('core:structured:acp', 'debug', `Unmapped ACP notification: ${method}`, {
          meta: { method, paramsKeys: Object.keys(p) },
        });
        return null;
    }
  }

  private mapServerRequest(
    rpcId: number | string,
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    if (method !== 'session/request_permission') return null;

    const p = (params ?? {}) as Record<string, unknown>;
    const requestId = String(p.id ?? `perm-${rpcId}`);

    this.pendingApprovals.set(requestId, rpcId);

    return this.makeEvent('permission_request', {
      id: requestId,
      toolName: String(p.tool ?? ''),
      toolInput: (p.args as Record<string, unknown>) ?? {},
      description: String(p.description ?? ''),
    });
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
