import { afterEach, describe, expect, it } from 'vitest';
import { setLocalSink } from './facade';
import { captureChatTrace, readChatTrace, stampChatTrace, chatEventTraceparent } from './chat-trace-context';
import type { LocalTelemetrySink } from './types';
import type { ChatEvent } from '../../shared/chat';
const tc = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
afterEach(() => setLocalSink(null));
describe('asynchronous context lifetime', () => {
  it('expires and cannot survive recording being disabled and re-enabled', () => {
    setLocalSink({ level: 'standard' } as LocalTelemetrySink);
    const context = captureChatTrace(tc, 100)!;
    expect(readChatTrace(context, 101)).toBe(tc);
    expect(readChatTrace(context, context.expires)).toBeUndefined();
    const live = captureChatTrace(tc)!;
    const event = {} as ChatEvent;
    stampChatTrace(event, live);
    expect(chatEventTraceparent(event)).toBe(tc);
    setLocalSink(null);
    expect(chatEventTraceparent(event)).toBeUndefined();
    setLocalSink({ level: 'standard' } as LocalTelemetrySink);
    expect(readChatTrace(live)).toBeUndefined();
    expect(chatEventTraceparent(event)).toBeUndefined();
  });
});
