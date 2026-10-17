import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-transcript-'));
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }));

import { appendChatEvent, readChatTranscript, lastSeqFor, transcriptPath } from './chat-transcript';

function ev(seq: number, sessionId = 's1', agentId = 'agent-1'): ChatEvent {
  return { v: CHAT_CONTRACT_VERSION, agentId, sessionId, seq, ts: seq, type: 'session_state', data: { state: 'idle' } };
}

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'agent-logs'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('chat transcript', () => {
  it('appends in order and reads back', async () => {
    await Promise.all([appendChatEvent(ev(1)), appendChatEvent(ev(2)), appendChatEvent(ev(3))]);
    const events = await readChatTranscript('agent-1');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('filters by session, afterSeq and tail', async () => {
    for (const e of [ev(1, 'a'), ev(2, 'a'), ev(1, 'b'), ev(3, 'a'), ev(2, 'b')]) await appendChatEvent(e);
    expect((await readChatTranscript('agent-1', { sessionId: 'a', afterSeq: 1 })).map((e) => e.seq)).toEqual([2, 3]);
    expect((await readChatTranscript('agent-1', { tail: 2 })).map((e) => `${e.sessionId}${e.seq}`)).toEqual(['a3', 'b2']);
    expect(await lastSeqFor('agent-1', 'a')).toBe(3);
    expect(await lastSeqFor('agent-1', 'missing')).toBe(0);
  });

  it('returns nothing for an agent without a transcript', async () => {
    expect(await readChatTranscript('nobody')).toEqual([]);
  });

  it('skips a torn final line and foreign records', async () => {
    await appendChatEvent(ev(1));
    fs.appendFileSync(transcriptPath('agent-1'), '{"v":2,"agentId":"agent-1","sess\n{"not":"an event"}\n');
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1]);
  });

  it('never lets an agent id escape the transcript directory', () => {
    const p = transcriptPath('../../etc/passwd');
    expect(path.dirname(p)).toBe(path.join(tmpRoot, 'agent-logs', 'chat'));
  });
});
