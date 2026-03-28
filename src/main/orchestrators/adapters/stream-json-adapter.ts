import { spawn as cpSpawn, ChildProcess } from 'child_process';
import type { StructuredAdapter, StructuredSessionOpts } from '../types';
import type { StructuredEvent } from '../../../shared/structured-events';
import { AsyncQueue } from './async-queue';
import { JsonlParser, StreamJsonEvent } from '../../services/jsonl-parser';
import { getShellEnvironment, cleanSpawnEnv } from '../../util/shell';
import { appLog } from '../../services/log-service';

export interface StreamJsonAdapterOpts {
  binary: string;
  baseArgs?: string[];
  env?: Record<string, string>;
  toolVerbs?: Record<string, string>;
}

/**
 * StructuredAdapter for Claude Code using `--output-format stream-json`.
 *
 * Spawns the CLI in print mode with `--verbose --include-partial-messages`
 * and translates stream-json NDJSON events into StructuredEvents. This
 * gives the structured UI streaming text deltas, tool tracking, thinking,
 * and usage information — all without requiring ACP protocol support.
 *
 * Limitations:
 * - Single-turn only (`-p` mode): sendMessage() is not supported
 * - Uses autonomous permission mode (auto or bypass): respondToPermission() is not supported
 */
export class StreamJsonAdapter implements StructuredAdapter {
  private proc: ChildProcess | null = null;
  private queue: AsyncQueue<StructuredEvent> | null = null;
  private parser: JsonlParser | null = null;
  private opts: StreamJsonAdapterOpts;

  /** Track content_block indices → type info for mapping stop events */
  private activeBlocks = new Map<number, { type: string; name?: string; id?: string; text?: string }>();

  constructor(opts: StreamJsonAdapterOpts) {
    this.opts = opts;
  }

  start(sessionOpts: StructuredSessionOpts): AsyncIterable<StructuredEvent> {
    if (!sessionOpts.mission || sessionOpts.mission.trim() === '') {
      throw new Error('StreamJsonAdapter requires a non-empty mission for -p mode');
    }

    const queue = new AsyncQueue<StructuredEvent>();
    this.queue = queue;

    // Build clean environment
    const env = cleanSpawnEnv({
      ...getShellEnvironment(),
      ...this.opts.env,
      ...sessionOpts.env,
    });

    // Build args: -p <mission> --output-format stream-json --verbose --include-partial-messages
    const args = [...(this.opts.baseArgs || [])];
    args.push('-p', sessionOpts.mission);
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
    args.push('--include-partial-messages');
    // Structured agents need autonomous permission handling
    if (sessionOpts.permissionMode === 'skip-all') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'auto');
    }

    if (sessionOpts.model && sessionOpts.model !== 'default') {
      args.push('--model', sessionOpts.model);
    }

    if (sessionOpts.allowedTools && sessionOpts.allowedTools.length > 0) {
      for (const tool of sessionOpts.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    if (sessionOpts.disallowedTools && sessionOpts.disallowedTools.length > 0) {
      for (const tool of sessionOpts.disallowedTools) {
        args.push('--disallowedTools', tool);
      }
    }

    if (sessionOpts.systemPrompt) {
      args.push('--append-system-prompt', sessionOpts.systemPrompt);
    }

    if (sessionOpts.freeAgentMode) {
      // Permission handling already applied above via permissionMode
    }

    const spawnBinary = sessionOpts.commandPrefix ? 'sh' : this.opts.binary;
    const spawnArgs = sessionOpts.commandPrefix
      ? ['-c', `${sessionOpts.commandPrefix} && exec "$@"`, '_', this.opts.binary, ...args]
      : args;

    appLog('core:structured', 'info', 'StreamJsonAdapter spawning', {
      meta: { binary: spawnBinary, cwd: sessionOpts.cwd, model: sessionOpts.model },
    });

    const proc = cpSpawn(spawnBinary, spawnArgs, {
      cwd: sessionOpts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    // Close stdin immediately — -p mode uses CLI arg, not stdin
    proc.stdin?.end();

    // Set up NDJSON parser
    const parser = new JsonlParser();
    this.parser = parser;

    parser.on('line', (event: StreamJsonEvent) => {
      const mapped = this.mapEvent(event);
      for (const se of mapped) {
        queue.push(se);
      }
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    // Accumulate stderr for logging; only emit as error on non-zero exit.
    // CLI tools write diagnostic info (progress, warnings) to stderr which
    // is not an error condition and should not flood the UI.
    let stderrBuffer = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    let exited = false;
    const handleExit = (code: number | null) => {
      if (exited) return;
      exited = true;

      appLog('core:structured', code === 0 ? 'info' : 'error', 'StreamJsonAdapter process exited', {
        meta: { code, stderr: stderrBuffer.length > 0 ? stderrBuffer.slice(-500) : undefined },
      });

      parser.flush();

      // Surface stderr as an error event only on non-zero exit
      if (code !== 0 && stderrBuffer.trim()) {
        queue.push(this.makeEvent('error', {
          code: 'stderr',
          message: stderrBuffer.trim().slice(-1000),
        }));
      }

      queue.push(this.makeEvent('end', {
        reason: code === 0 ? 'complete' : 'error',
        summary: code === 0 ? undefined : `Process exited with code ${code}`,
      }));
      queue.finish();
    };

    proc.on('close', (code) => handleExit(code));
    proc.on('error', (err) => {
      appLog('core:structured', 'error', 'StreamJsonAdapter process spawn error', {
        meta: { error: err.message },
      });
      handleExit(1);
    });

    return queue;
  }

  async sendMessage(_message: string): Promise<void> {
    throw new Error('sendMessage is not supported in stream-json single-turn mode');
  }

  async respondToPermission(
    _requestId: string,
    _approved: boolean,
    _reason?: string,
  ): Promise<void> {
    throw new Error('respondToPermission is not supported — permissions are auto-skipped');
  }

  async cancel(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // Already dead
    }
  }

  dispose(): void {
    try {
      this.proc?.kill('SIGKILL');
    } catch {
      // Already dead
    }
    this.queue?.finish();
    this.proc = null;
    this.queue = null;
    this.parser = null;
    this.activeBlocks.clear();
  }

  // ── Event mapping ─────────────────────────────────────────────────────────

  /**
   * Map a single stream-json event to zero or more StructuredEvents.
   *
   * Stream-json with --verbose --include-partial-messages emits:
   *   - content_block_start/delta/stop (token-level streaming)
   *   - assistant (full turn message — used for usage extraction)
   *   - user (tool results)
   *   - result (session complete)
   */
  private mapEvent(event: StreamJsonEvent): StructuredEvent[] {
    switch (event.type) {
      case 'content_block_start':
        return this.handleBlockStart(event);
      case 'content_block_delta':
        return this.handleBlockDelta(event);
      case 'content_block_stop':
        return this.handleBlockStop(event);
      case 'assistant':
        return this.handleAssistant(event);
      case 'user':
        return this.handleUser(event);
      case 'result':
        return this.handleResult(event);
      default:
        return [];
    }
  }

  private handleBlockStart(event: StreamJsonEvent): StructuredEvent[] {
    const index = typeof event.index === 'number' ? event.index : -1;
    const block = event.content_block;
    if (!block || index < 0) return [];

    this.activeBlocks.set(index, {
      type: block.type,
      name: block.name,
      id: block.id,
      text: '',
    });

    if (block.type === 'tool_use' && block.name) {
      return [this.makeEvent('tool_start', {
        id: block.id || String(index),
        name: block.name,
        displayVerb: this.resolveToolVerb(block.name),
        input: {},
      })];
    }

    return [];
  }

  private handleBlockDelta(event: StreamJsonEvent): StructuredEvent[] {
    const index = typeof event.index === 'number' ? event.index : -1;
    const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
    if (!delta) return [];

    const block = index >= 0 ? this.activeBlocks.get(index) : undefined;

    if (delta.type === 'text_delta' && delta.text) {
      // Accumulate text for text_done
      if (block) {
        block.text = (block.text || '') + delta.text;
      }
      return [this.makeEvent('text_delta', { text: delta.text })];
    }

    if (delta.type === 'thinking_delta' && delta.thinking) {
      return [this.makeEvent('thinking', { text: delta.thinking, isPartial: true })];
    }

    // input_json_delta — tool input being streamed, accumulate silently
    return [];
  }

  private handleBlockStop(event: StreamJsonEvent): StructuredEvent[] {
    const index = typeof event.index === 'number' ? event.index : -1;
    const block = index >= 0 ? this.activeBlocks.get(index) : undefined;
    if (!block) return [];

    this.activeBlocks.delete(index);

    // Emit text_done when a text block finishes
    if (block.type === 'text' && block.text) {
      return [this.makeEvent('text_done', { text: block.text })];
    }

    return [];
  }

  private handleAssistant(event: StreamJsonEvent): StructuredEvent[] {
    // Extract usage from assistant message
    const msg = event.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
    if (!msg?.usage) return [];

    return [this.makeEvent('usage', {
      inputTokens: msg.usage.input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens,
    })];
  }

  private handleUser(event: StreamJsonEvent): StructuredEvent[] {
    const msg = event.message as { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } | undefined;
    if (!msg?.content || !Array.isArray(msg.content)) return [];

    const results: StructuredEvent[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map(c => c.text || '').join('\n')
            : '';

        results.push(this.makeEvent('tool_end', {
          id: block.tool_use_id || '',
          name: '', // tool name not available in tool_result
          result: resultText,
          durationMs: 0,
          status: block.is_error ? 'error' : 'success',
        }));
      }
    }
    return results;
  }

  private handleResult(event: StreamJsonEvent): StructuredEvent[] {
    const results: StructuredEvent[] = [];

    if (event.cost_usd != null || event.duration_ms != null) {
      results.push(this.makeEvent('usage', {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: event.cost_usd != null ? Number(event.cost_usd) : undefined,
      }));
    }

    return results;
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
