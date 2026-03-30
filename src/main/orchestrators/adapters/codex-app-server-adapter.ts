import type { StructuredAdapter, StructuredSessionOpts } from '../types';
import type { StructuredEvent } from '../../../shared/structured-events';
import { AsyncQueue } from './async-queue';
import { CodexAppServerClient } from './codex-app-server-client';
import { getShellEnvironment, cleanSpawnEnv } from '../../util/shell';
import { appLog } from '../../services/log-service';

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
  private turnEnded = false;
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

    // When a command prefix is set, wrap via shell so the prefix runs first
    const spawnBinary = sessionOpts.commandPrefix ? 'sh' : this.opts.binary;
    const spawnArgs = sessionOpts.commandPrefix
      ? ['-c', `${sessionOpts.commandPrefix} && exec "$@"`, '_', this.opts.binary, ...args]
      : args;

    appLog('core:structured', 'info', 'CodexAppServerAdapter starting session', {
      meta: {
        binary: spawnBinary,
        args: spawnArgs,
        cwd: sessionOpts.cwd,
        model: sessionOpts.model,
        hasMission: !!sessionOpts.mission,
        hasSystemPrompt: !!sessionOpts.systemPrompt,
        freeAgentMode: sessionOpts.freeAgentMode,
        commandPrefix: sessionOpts.commandPrefix || 'none',
      },
    });

    this.client = new CodexAppServerClient({
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

    await this.client.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: message }],
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
    this.client?.respond(rpcId, {
      decision: approved ? 'accept' : 'decline',
    });
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
    this.threadId = null;
    this.pendingApprovals.clear();
  }

  // ── Thread lifecycle ────────────────────────────────────────────────────────

  private async startThread(sessionOpts: StructuredSessionOpts): Promise<void> {
    if (!this.client) return;

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
    await this.client.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
    });
  }

  // ── Event mapping ─────────────────────────────────────────────────────────

  private mapNotification(
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = (p.delta as Record<string, unknown>) ?? {};
        return this.makeEvent('text_delta', {
          text: String(delta.text ?? ''),
        });
      }

      case 'item/reasoning/summaryTextDelta': {
        const delta = (p.delta as Record<string, unknown>) ?? {};
        return this.makeEvent('thinking', {
          text: String(delta.text ?? ''),
          isPartial: true,
        });
      }

      case 'item/started': {
        const item = (p.item as Record<string, unknown>) ?? {};
        return this.mapItemStarted(item);
      }

      case 'item/completed': {
        const item = (p.item as Record<string, unknown>) ?? {};
        return this.mapItemCompleted(item);
      }

      case 'item/commandExecution/outputDelta': {
        const delta = (p.delta as Record<string, unknown>) ?? {};
        return this.makeEvent('command_output', {
          id: String(p.itemId ?? ''),
          command: '',
          status: 'running' as const,
          output: String(delta.output ?? ''),
          exitCode: undefined,
        });
      }

      case 'item/plan/delta': {
        const delta = (p.delta as Record<string, unknown>) ?? {};
        const items = (delta.items ?? p.items) as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items)) return null;
        return this.makeEvent('plan_update', {
          steps: items.map((s) => ({
            description: String(s.text ?? s.description ?? ''),
            status: s.completed ? 'completed' as const : 'pending' as const,
          })),
        });
      }

      case 'turn/diff/updated': {
        const files = (p.files as Array<Record<string, unknown>>) ?? [];
        if (files.length === 0) return null;
        const f = files[files.length - 1];
        return this.makeEvent('file_diff', {
          path: String(f.path ?? ''),
          changeType: this.mapFileChangeKind(String(f.kind ?? 'Update')),
          diff: String(f.diff ?? f.patch ?? ''),
        });
      }

      case 'thread/tokenUsage/updated': {
        const usage = (p.usage ?? p) as Record<string, unknown>;
        return this.makeEvent('usage', {
          inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
          cacheReadTokens: usage.cached_input_tokens != null
            ? Number(usage.cached_input_tokens) : undefined,
          cacheWriteTokens: undefined,
          costUsd: undefined,
        });
      }

      case 'turn/completed': {
        this.turnEnded = true;
        const usage = (p.usage as Record<string, unknown>) ?? {};

        // Emit usage event
        this.queue?.push(this.makeEvent('usage', {
          inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
          cacheReadTokens: usage.cached_input_tokens != null
            ? Number(usage.cached_input_tokens) : undefined,
          cacheWriteTokens: undefined,
          costUsd: undefined,
        }));

        // If failed, emit error before end
        if (p.status === 'failed') {
          const error = (p.error as Record<string, unknown>) ?? {};
          this.queue?.push(this.makeEvent('error', {
            code: String(error.type ?? 'turn_failed'),
            message: String(error.message ?? 'Turn failed'),
          }));
        }

        // Emit end event and finish queue
        this.queue?.push(this.makeEvent('end', {
          reason: p.status === 'failed' ? 'error' : 'complete',
          summary: p.status === 'failed'
            ? String((p.error as Record<string, unknown>)?.message ?? 'Turn failed')
            : undefined,
        }));
        this.queue?.finish();

        return null; // Already pushed events directly
      }

      // Codex sends configWarning during init — informational, not actionable.
      // Log at debug level and suppress from the UI event stream.
      case 'configWarning': {
        appLog('core:structured:codex', 'info', 'Codex config warning', {
          meta: { message: String(p.message ?? p.warning ?? ''), params: p },
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
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');

    switch (type) {
      case 'command_execution':
      case 'CommandExecution': {
        const details = (item.details ?? item) as Record<string, unknown>;
        return this.makeEvent('tool_start', {
          id,
          name: 'shell',
          displayVerb: this.resolveToolVerb('shell'),
          input: { command: String(details.command ?? '') },
        });
      }

      case 'file_change':
      case 'FileChange': {
        const details = (item.details ?? item) as Record<string, unknown>;
        return this.makeEvent('tool_start', {
          id,
          name: 'apply_patch',
          displayVerb: this.resolveToolVerb('apply_patch'),
          input: { path: String(details.path ?? '') },
        });
      }

      case 'mcp_tool_call':
      case 'McpToolCall': {
        const details = (item.details ?? item) as Record<string, unknown>;
        const toolName = String(details.tool ?? details.name ?? 'mcp_tool');
        return this.makeEvent('tool_start', {
          id,
          name: toolName,
          displayVerb: this.resolveToolVerb(toolName),
          input: (details.arguments as Record<string, unknown>) ?? {},
        });
      }

      default:
        return null;
    }
  }

  private mapItemCompleted(item: Record<string, unknown>): StructuredEvent | null {
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');

    switch (type) {
      case 'agent_message':
      case 'AgentMessage': {
        return this.makeEvent('text_done', {
          text: String(item.text ?? ''),
        });
      }

      case 'command_execution':
      case 'CommandExecution': {
        const details = (item.details ?? item) as Record<string, unknown>;
        const exitCode = details.exit_code ?? details.exitCode;
        return this.makeEvent('tool_end', {
          id,
          name: 'shell',
          result: String(details.aggregated_output ?? details.output ?? ''),
          durationMs: 0,
          status: exitCode === 0 || details.status === 'Completed' ? 'success' : 'error',
        });
      }

      case 'file_change':
      case 'FileChange': {
        return this.makeEvent('tool_end', {
          id,
          name: 'apply_patch',
          result: String((item.details as Record<string, unknown>)?.path ?? item.path ?? ''),
          durationMs: 0,
          status: 'success',
        });
      }

      case 'mcp_tool_call':
      case 'McpToolCall': {
        const details = (item.details ?? item) as Record<string, unknown>;
        const toolName = String(details.tool ?? details.name ?? 'mcp_tool');
        return this.makeEvent('tool_end', {
          id,
          name: toolName,
          result: String(details.result ?? ''),
          durationMs: 0,
          status: details.error ? 'error' : 'success',
        });
      }

      case 'todo_list':
      case 'TodoList': {
        const items = (item.items as Array<Record<string, unknown>>) ?? [];
        return this.makeEvent('plan_update', {
          steps: items.map((s) => ({
            description: String(s.text ?? ''),
            status: s.completed ? 'completed' as const : 'pending' as const,
          })),
        });
      }

      default:
        return null;
    }
  }

  private mapServerRequest(
    rpcId: number | string,
    method: string,
    params: unknown,
  ): StructuredEvent | null {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const requestId = String(p.itemId ?? `cmd-${rpcId}`);
        this.pendingApprovals.set(requestId, rpcId);
        return this.makeEvent('permission_request', {
          id: requestId,
          toolName: 'shell',
          toolInput: { command: String(p.command ?? '') },
          description: `Run command: ${String(p.command ?? '')}`,
        });
      }

      case 'item/fileChange/requestApproval': {
        const requestId = String(p.itemId ?? `file-${rpcId}`);
        this.pendingApprovals.set(requestId, rpcId);
        return this.makeEvent('permission_request', {
          id: requestId,
          toolName: 'apply_patch',
          toolInput: { path: String(p.path ?? '') },
          description: `Modify file: ${String(p.path ?? '')}`,
        });
      }

      default:
        return null;
    }
  }

  private mapFileChangeKind(kind: string): 'create' | 'modify' | 'delete' {
    switch (kind.toLowerCase()) {
      case 'add': case 'create': return 'create';
      case 'delete': case 'remove': return 'delete';
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
