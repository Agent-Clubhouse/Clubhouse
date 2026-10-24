/** In-memory causal metadata, deliberately excluded from chat transcripts and payloads. */
import type { ChatEvent } from '../../shared/chat';
import { validatedTraceparent } from './trace-context';
import { getRecordingGeneration, isTelemetryActive } from './facade';
export interface ChatTraceContext { tc: string; expires: number; generation: number }
const contexts = new WeakMap<ChatEvent, ChatTraceContext>();
const MAX_AGE_MS = 60 * 60_000;
export function captureChatTrace(tc: unknown, now = Date.now()): ChatTraceContext | undefined {
  const valid = validatedTraceparent(tc);
  return valid ? { tc: valid, expires: now + MAX_AGE_MS, generation: getRecordingGeneration() } : undefined;
}
export function readChatTrace(context: ChatTraceContext | undefined, now = Date.now()): string | undefined {
  return isTelemetryActive() && context && context.expires > now && context.generation === getRecordingGeneration() ? context.tc : undefined;
}
export function stampChatTrace(event: ChatEvent, context: ChatTraceContext | undefined): void {
  const tc = readChatTrace(context);
  if (tc && context) contexts.set(event, context);
}
export function chatEventTraceparent(event: ChatEvent): string | undefined {
  return readChatTrace(contexts.get(event));
}
