/** In-memory causal metadata, deliberately excluded from chat transcripts and payloads. */
import type { ChatEvent } from '../../shared/chat';
import { validatedTraceparent } from './trace-context';
import { isTelemetryActive } from './facade';
export interface ChatTraceContext { tc: string; expires: number }
const contexts = new WeakMap<ChatEvent, string>();
const MAX_AGE_MS = 60 * 60_000;
export function captureChatTrace(tc: unknown, now = Date.now()): ChatTraceContext | undefined {
  const valid = validatedTraceparent(tc);
  return valid ? { tc: valid, expires: now + MAX_AGE_MS } : undefined;
}
export function readChatTrace(context: ChatTraceContext | undefined, now = Date.now()): string | undefined {
  return isTelemetryActive() && context && context.expires > now ? context.tc : undefined;
}
export function stampChatTrace(event: ChatEvent, context: ChatTraceContext | undefined): void {
  const tc = readChatTrace(context);
  if (tc) contexts.set(event, tc);
}
export function chatEventTraceparent(event: ChatEvent): string | undefined {
  return isTelemetryActive() ? contexts.get(event) : undefined;
}
