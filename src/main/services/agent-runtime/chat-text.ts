/**
 * Plain-text rendering of chat events, for consumers that expect terminal-like
 * output (MCP read_output, which other agents poll for TASK_RESULT markers).
 */

import type { ChatEvent } from '../../../shared/chat';

export function chatEventsToText(events: ChatEvent[], maxLines: number): string {
  const lines: string[] = [];
  const partial = new Map<string, string>();
  for (const e of events) {
    switch (e.type) {
      case 'user_message': {
        const text = e.data.content.map((c) => (c.type === 'text' ? c.text : c.type === 'file' ? c.path : '')).join('\n');
        lines.push(...`> ${text}`.split('\n'));
        break;
      }
      case 'agent_message_chunk':
        partial.set(e.data.messageId, (partial.get(e.data.messageId) ?? '') + e.data.text);
        break;
      case 'agent_message':
        partial.delete(e.data.messageId);
        lines.push(...e.data.text.split('\n'));
        break;
      case 'tool_call':
        lines.push(`[tool] ${e.data.title} (${e.data.status})`);
        break;
      case 'tool_call_update':
        if (e.data.status === 'completed' || e.data.status === 'failed') {
          lines.push(`[tool] ${e.data.title ?? e.data.toolCallId} ${e.data.status}${e.data.error ? `: ${e.data.error}` : ''}`);
        }
        break;
      case 'permission_request':
        lines.push(`[needs permission] ${e.data.title}`);
        break;
      case 'error':
        lines.push(`[error] ${e.data.message}`);
        break;
    }
  }
  // A message still streaming is shown as it stands.
  for (const text of partial.values()) lines.push(...text.split('\n'));
  return lines.slice(-maxLines).join('\n');
}
