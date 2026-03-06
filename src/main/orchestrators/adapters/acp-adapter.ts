import type { StructuredAdapter, StructuredSessionOpts } from '../types';
import type { StructuredEvent } from '../../../shared/structured-events';
import { AsyncQueue } from './async-queue';
import { AcpClient } from './acp-client';
import { getShellEnvironment } from '../../util/shell';

export interface AcpAdapterOpts {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  toolVerbs?: Record<string, string>;
}

/**
 * StructuredAdapter implementation for ACP (Agent Client Protocol).
 * Translates ACP JSON-RPC notifications/requests into StructuredEvents.
 */
export class AcpAdapter implements StructuredAdapter {
  private client: AcpClient | null = null;
  private queue: AsyncQueue<StructuredEvent> | null = null;
  private pendingApprovals = new Map<string, string | number>();
  private opts: AcpAdapterOpts;

  constructor(opts: AcpAdapterOpts) {
    this.opts = opts;
  }

  start(sessionOpts: StructuredSessionOpts): AsyncIterable<StructuredEvent> {
    const queue = new AsyncQueue<StructuredEvent>();
    this.queue = queue;

    // Build clean environment
    const env = {
      ...getShellEnvironment(),
      ...this.opts.env,
      ...sessionOpts.env,
    };
    // Prevent nested agent detection
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const args = [...this.opts.args];
    if (sessionOpts.model) {
      args.push('--model', sessionOpts.model);
    }

    // When a command prefix is set, wrap via shell so the prefix runs first
    const spawnBinary = sessionOpts.commandPrefix ? 'sh' : this.opts.binary;
    const spawnArgs = sessionOpts.commandPrefix
      ? ['-c', `${sessionOpts.commandPrefix} && exec "$@"`, '_', this.opts.binary, ...args]
      : args;

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
        queue.push(this.makeEvent('end', {
          reason: code === 0 ? 'complete' : 'error',
          summary: code === 0 ? undefined : `Process exited with code ${code}`,
        }));
        queue.finish();
      },
    });

    this.client.start();

    // Send the initial session/start request (fire and forget — responses
    // come back as notifications)
    this.client.request('session/start', {
      mission: sessionOpts.mission,
      systemPrompt: sessionOpts.systemPrompt,
      allowedTools: sessionOpts.allowedTools,
      disallowedTools: sessionOpts.disallowedTools,
    }).catch((err) => {
      queue.push(this.makeEvent('error', {
        code: 'session_start_failed',
        message: err instanceof Error ? err.message : String(err),
      }));
    });

    return queue;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error('Adapter not started');
    await this.client.request('session/send', { message });
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
    try {
      await this.client.request('session/cancel', {});
    } catch {
      // Process may already be dead
    }
    this.client.kill();
  }

  dispose(): void {
    this.client?.kill();
    this.queue?.finish();
    this.client = null;
    this.queue = null;
    this.pendingApprovals.clear();
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

      default:
        // Graceful degradation: unknown methods silently ignored
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
