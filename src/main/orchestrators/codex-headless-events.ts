import type { StreamJsonEvent } from '../services/jsonl-parser';

/**
 * Translate `codex exec --json` output into the stream-json shape the shared
 * headless pipeline understands.
 *
 * Codex emits its own event vocabulary, which shares no type names with Claude
 * Code's:
 *
 *   {"type":"thread.started","thread_id":"01a07466-…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}
 *   {"type":"turn.completed","usage":{"input_tokens":15599,…}}
 *
 * `headless-manager` and `transcript-parser` match on `assistant`, `user`,
 * `result` and `content_block_*`, so none of these ever matched: a headless
 * Codex run produced no transcript, no tool history, no completion signal and
 * no token usage.
 *
 * Normalising into the existing shape — rather than teaching every consumer a
 * second vocabulary — keeps one transcript format across providers. The same
 * seam is what Copilot's own JSONL needs (#1534 §1).
 */

/** Tool names Codex items map onto, matching the provider's TOOL_VERBS keys. */
const SHELL_TOOL = 'shell';
const PATCH_TOOL = 'apply_patch';

interface CodexItem {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function assistantText(text: string): StreamJsonEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): StreamJsonEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResult(id: string, content: string, isError = false): StreamJsonEvent {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}

/** Describe a Codex item as a (toolName, input) pair, or null if it isn't a tool. */
function toolFor(item: CodexItem): { name: string; input: Record<string, unknown> } | null {
  const details = (item.details ?? item) as Record<string, unknown>;
  switch (str(item.type)) {
    case 'command_execution':
      return { name: SHELL_TOOL, input: { command: str(details.command) } };
    case 'file_change':
      return { name: PATCH_TOOL, input: { path: str(details.path) } };
    case 'mcp_tool_call':
      return {
        name: str(details.tool, str(details.name, 'mcp_tool')),
        input: (details.arguments as Record<string, unknown>) ?? {},
      };
    default:
      return null;
  }
}

/**
 * Stateful normaliser — one per headless session.
 *
 * Codex reports the final assistant text as an `item.completed` well before
 * `turn.completed`, while the shared pipeline expects the terminal `result`
 * event to carry it, so the last agent message has to be remembered.
 */
export function createCodexHeadlessNormalizer(): (raw: StreamJsonEvent) => StreamJsonEvent[] {
  let lastAgentText = '';

  return (raw: StreamJsonEvent): StreamJsonEvent[] => {
    const type = str(raw.type);

    switch (type) {
      case 'thread.started':
        // Carries the id needed to resume this thread later.
        return [{ type: 'system', subtype: 'init', session_id: str(raw.thread_id) }];

      case 'turn.started':
        return [];

      case 'item.started': {
        const item = (raw.item ?? {}) as CodexItem;
        const tool = toolFor(item);
        return tool ? [toolUse(str(item.id), tool.name, tool.input)] : [];
      }

      case 'item.completed': {
        const item = (raw.item ?? {}) as CodexItem;
        const itemType = str(item.type);

        if (itemType === 'agent_message') {
          lastAgentText = str(item.text);
          return [assistantText(lastAgentText)];
        }

        const tool = toolFor(item);
        if (!tool) return [];

        const details = (item.details ?? item) as Record<string, unknown>;
        const exitCode = details.exit_code ?? details.exitCode;
        const failed = typeof exitCode === 'number' ? exitCode !== 0 : Boolean(details.error);
        const output = str(
          details.aggregated_output ?? details.output ?? details.result ?? details.path,
        );

        // Codex reports some tools only on completion, so emit the matching
        // tool_use as well — a bare tool_result would leave the transcript
        // showing a result for a call that never appeared.
        const events: StreamJsonEvent[] = [];
        if (itemType !== 'command_execution') {
          events.push(toolUse(str(item.id), tool.name, tool.input));
        }
        events.push(toolResult(str(item.id), output, failed));
        return events;
      }

      case 'turn.completed': {
        const usage = (raw.usage ?? {}) as Record<string, unknown>;
        return [{
          type: 'result',
          subtype: 'success',
          result: lastAgentText,
          is_error: false,
          message: {
            usage: {
              input_tokens: Number(usage.input_tokens ?? 0),
              output_tokens: Number(usage.output_tokens ?? 0),
            },
          },
        }];
      }

      case 'turn.failed':
      case 'error': {
        const error = (raw.error ?? raw) as Record<string, unknown>;
        const message = str(error.message, 'Codex reported an error');
        return [{ type: 'result', subtype: 'error', result: message, is_error: true }];
      }

      default:
        // Unknown Codex events are dropped rather than passed through: the
        // downstream consumers would ignore them anyway, and letting them into
        // the transcript inflates it with entries nothing can render.
        return [];
    }
  };
}
