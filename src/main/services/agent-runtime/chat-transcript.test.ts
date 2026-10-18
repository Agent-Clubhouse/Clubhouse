import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChatEvent } from '../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES, CHAT_CONTRACT_VERSION } from '../../../shared/chat';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-transcript-'));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }));
vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile), open: vi.fn(actual.open), stat: vi.fn(actual.stat), writeFile: vi.fn(actual.writeFile) };
});

import { appendChatEvent, flushAllTranscripts, readChatTranscript, lastSeqFor, transcriptPath, listChatSessions, resetTranscriptCache, flushTranscript, transcriptExists, cleanupTranscriptStaging } from './chat-transcript';

function ev(seq: number, sessionId = 's1', agentId = 'agent-1'): ChatEvent {
  return { v: CHAT_CONTRACT_VERSION, agentId, sessionId, seq, ts: seq, type: 'session_state', data: { state: 'idle' } };
}

beforeEach(() => {
  resetTranscriptCache();
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
    expect((await readChatTranscript('agent-1', { tail: 2 })).map((e) => `${e.sessionId}${e.seq}`)).toEqual(['b1', 'b2']);
    expect(await lastSeqFor('agent-1', 'a')).toBe(3);
    expect(await lastSeqFor('agent-1', 'missing')).toBe(0);
  });

  it('returns nothing for an agent without a transcript', async () => {
    expect(await readChatTranscript('nobody')).toEqual([]);
  });

  it('skips a torn final line and foreign records', async () => {
    await appendChatEvent(ev(1));
    fs.appendFileSync(transcriptPath('agent-1', 's1'), '{"v":2,"agentId":"agent-1","sess\n{"not":"an event"}\n');
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1]);
  });

  it('starts a fresh line after a crash-torn last line instead of losing the next event', async () => {
    fs.mkdirSync(path.dirname(transcriptPath('agent-torn')), { recursive: true });
    fs.writeFileSync(transcriptPath('agent-torn'), JSON.stringify(ev(1, 's1', 'agent-torn')) + '\n{"v":2,"agentId":"agent-torn","se');
    await appendChatEvent(ev(2, 's1', 'agent-torn'));
    await appendChatEvent(ev(3, 's1', 'agent-torn'));
    expect((await readChatTranscript('agent-torn')).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('reads a tail from the end of a large transcript', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => ev(i + 1, 's1', 'agent-big'));
    fs.mkdirSync(path.dirname(transcriptPath('agent-big')), { recursive: true });
    fs.writeFileSync(transcriptPath('agent-big'), big.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const tail = await readChatTranscript('agent-big', { tail: 5 });
    expect(tail.map((e) => e.seq)).toEqual([2996, 2997, 2998, 2999, 3000]);
  });

  it('never lets an agent id escape the transcript directory', () => {
    const p = transcriptPath('../../etc/passwd');
    expect(path.dirname(p)).toBe(path.join(tmpRoot, 'agent-logs', 'chat'));
  });
});


describe('session storage and migration', () => {
  it('distinguishes migrated sessions without user messages from attachment-only conversations in the index', async () => {
    const original: ChatEvent[] = [
      start(1, 'empty', 1),
      { ...ev(2, 'empty'), type: 'session_info', data: { nativeSessionId: 'native-empty' } },
      start(1, 'attachment', 3),
      { ...ev(2, 'attachment'), type: 'user_message', data: {
        messageId: 'image', content: [{ type: 'image', mimeType: 'image/png', path: '/image.png' }], source: 'user', delivery: 'prompt',
      } },
    ];
    const legacy = transcriptPath('agent-1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, original.map((event) => JSON.stringify(event) + '\n').join(''));
    const migrated = await listChatSessions('agent-1');
    expect(migrated.find((session) => session.sessionId === 'empty')).not.toHaveProperty('title');
    expect(migrated.find((session) => session.sessionId === 'attachment')).toHaveProperty('title', '');
    resetTranscriptCache();
    expect(await listChatSessions('agent-1')).toEqual(migrated);
  });

  it('writes separate files, lists sessions, and reads only the current session by default', async () => {
    await appendChatEvent(ev(1, 'old'));
    await appendChatEvent(ev(2, 'old'));
    await appendChatEvent(ev(1, 'new'));
    await flushTranscript('agent-1');
    expect(fs.existsSync(transcriptPath('agent-1'))).toBe(false);
    expect(transcriptExists('agent-1')).toBe(true);
    expect(await readChatTranscript('agent-1')).toEqual([ev(1, 'new')]);
    expect(await readChatTranscript('agent-1', { sessionId: 'old' })).toEqual([ev(1, 'old'), ev(2, 'old')]);
    expect((await listChatSessions('agent-1')).map((s) => s.sessionId).sort()).toEqual(['new', 'old']);
  });

  it('splits interleaved legacy sessions without changing the backup or duplicating events', async () => {
    const original = [ev(1, 'old'), ev(1, 'new'), ev(2, 'old'), ev(2, 'new')];
    const legacy = transcriptPath('agent-1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const content = original.map((e) => JSON.stringify(e) + '\n').join('') + '{"torn":';
    fs.writeFileSync(legacy, content);
    expect(await readChatTranscript('agent-1')).toEqual([original[1], original[3]]);
    expect(await readChatTranscript('agent-1', { sessionId: 'old' })).toEqual([original[0], original[2]]);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(content);
    resetTranscriptCache();
    const resumed = start(3, 'old', 5);
    await appendChatEvent(resumed);
    expect(await readChatTranscript('agent-1')).toEqual([original[0], original[2], resumed]);
    expect(await lastSeqFor('agent-1', 'old')).toBe(3);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(content);
  });

  it('indexes late native ids, first prompts and end times for resume and history', async () => {
    await appendChatEvent(ev(1));
    await appendChatEvent({ ...ev(2), type: 'session_info', data: { nativeSessionId: 'native-late' } });
    await appendChatEvent({ ...ev(3), type: 'user_message', data: { messageId: 'm1', content: [{ type: 'text', text: 'First task' }], source: 'user', delivery: 'prompt' } });
    await appendChatEvent({ ...ev(4), type: 'session_ended', data: { reason: 'stopped' } });
    resetTranscriptCache();
    expect(await listChatSessions('agent-1')).toEqual([expect.objectContaining({ sessionId: 's1', nativeSessionId: 'native-late', title: 'First task', startedAt: 1, endedAt: 4, lastSeq: 4 })]);
  });

  it('recovers an append that reached disk before its index update', async () => {
    await appendChatEvent(ev(1));
    fs.appendFileSync(transcriptPath('agent-1', 's1'), JSON.stringify(ev(2)) + '\n');
    resetTranscriptCache();
    expect(await lastSeqFor('agent-1', 's1')).toBe(2);
    await appendChatEvent(ev(3));
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('recovers a new session file omitted by an interrupted index update', async () => {
    await appendChatEvent(ev(1));
    fs.writeFileSync(transcriptPath('agent-1', 'new'), JSON.stringify({ ...ev(1, 'new'), ts: 10 }) + '\n');
    resetTranscriptCache();
    expect((await readChatTranscript('agent-1'))[0].sessionId).toBe('new');
    expect((await listChatSessions('agent-1'))[0].sessionId).toBe('new');
  });

  it('repairs a torn session file before appending', async () => {
    await appendChatEvent(ev(1));
    fs.appendFileSync(transcriptPath('agent-1', 's1'), '{"torn":');
    resetTranscriptCache();
    await appendChatEvent(ev(2));
    expect(await readChatTranscript('agent-1')).toEqual([ev(1), ev(2)]);
  });

  it('preserves the legacy log and retries if publishing the migration fails', async () => {
    const legacy = transcriptPath('agent-1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const content = JSON.stringify(ev(1)) + '\n';
    fs.writeFileSync(legacy, content);
    const rename = vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(readChatTranscript('agent-1')).rejects.toThrow('disk unavailable');
    rename.mockReset();
    expect(fs.readFileSync(legacy, 'utf8')).toBe(content);
    expect(await readChatTranscript('agent-1')).toEqual([ev(1)]);
    expect(await readChatTranscript('agent-1')).toEqual([ev(1)]);
  });

  it('uses the index for sequence and session lookup without rereading transcript files', async () => {
    await appendChatEvent(ev(1));
    resetTranscriptCache();
    const read = vi.mocked(fsp.readFile).mockClear();
    expect(await lastSeqFor('agent-1', 's1')).toBe(1);
    await listChatSessions('agent-1');
    expect(read.mock.calls.some(([file]) => String(file).endsWith('.jsonl'))).toBe(false);
  });

  it('rebuilds malformed index entries from intact session files', async () => {
    await appendChatEvent(ev(1));
    fs.writeFileSync(path.join(path.dirname(transcriptPath('agent-1', 's1')), 'index.json'), '{"version":1,"sessions":[null]}');
    resetTranscriptCache();
    expect(await readChatTranscript('agent-1')).toEqual([ev(1)]);
    expect(await lastSeqFor('agent-1', 's1')).toBe(1);
  });

  it('preserves multibyte text across tail read chunks', async () => {
    const text = '🍀'.repeat(40_000);
    const large: ChatEvent = { ...ev(1), type: 'agent_message', data: { messageId: 'large', text } };
    await appendChatEvent(large);
    await appendChatEvent(ev(2));
    expect(await readChatTranscript('agent-1', { sessionId: 's1', tail: 2 })).toEqual([large, ev(2)]);
  });

  it('contains agent and session path segments, including dot and traversal ids', () => {
    for (const id of ['..', '../escape', '/tmp/escape', 'a/b']) {
      const file = transcriptPath(id, id);
      expect(path.relative(path.join(tmpRoot, 'agent-logs', 'chat'), file).split(path.sep)).toHaveLength(2);
      expect(file).toMatch(/\.jsonl$/);
    }
  });
});

function start(seq: number, sessionId: string, ts: number): ChatEvent {
  return { ...ev(seq, sessionId), ts, type: 'session_started', data: {
    driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/project', resumed: seq > 1, capabilities: MINIMAL_CHAT_CAPABILITIES,
  } };
}

describe('migration and append failure recovery', () => {
  it('persists appends when the staging FOLDER rename fails, then retries the complete migration', async () => {
    const legacy = transcriptPath('agent-1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify(ev(1)) + '\n');
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const rename = vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.migrating-') && !String(from).endsWith('index.json.tmp')) {
        throw Object.assign(new Error('folder locked'), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    });
    await expect(appendChatEvent(ev(2))).resolves.toBeUndefined();
    await expect(appendChatEvent(ev(3))).resolves.toBeUndefined();
    expect(fs.readFileSync(legacy, 'utf8').trim().split('\n').map((line) => JSON.parse(line).seq)).toEqual([1, 2, 3]);
    rename.mockReset();
    expect(await readChatTranscript('agent-1')).toEqual([ev(1), ev(2), ev(3)]);
    expect(await lastSeqFor('agent-1', 's1')).toBe(3);
  });

  it.each(['read', 'verify'])('persists appends when migration fails during %s', async (failure) => {
    const legacy = transcriptPath('agent-1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify(ev(1)) + '\n');
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fsp.readFile).mockImplementation(async (...args) => {
      if (failure === 'read' && String(args[0]) === legacy) throw new Error('read denied');
      if (failure === 'verify' && String(args[0]).includes('.migrating-')) return 'incomplete';
      return actual.readFile(...args);
    });
    await expect(appendChatEvent(ev(2))).resolves.toBeUndefined();
    vi.mocked(fsp.readFile).mockReset();
    expect(await readChatTranscript('agent-1')).toEqual([ev(1), ev(2)]);
  });

  it('does not fail a durable append when replacing its index fails', async () => {
    await appendChatEvent(ev(1));
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('index locked'));
    await expect(appendChatEvent(ev(2))).resolves.toBeUndefined();
    // The index is saved lazily; saving it is where the failure surfaces.
    await expect(flushTranscript('agent-1')).resolves.toBeUndefined();
    expect(fs.readFileSync(transcriptPath('agent-1', 's1'), 'utf8')).toContain(JSON.stringify(ev(2)));
    resetTranscriptCache({ crash: true });
    expect(await lastSeqFor('agent-1', 's1')).toBe(2);
    expect(await readChatTranscript('agent-1')).toEqual([ev(1), ev(2)]);
  });

  it('cleans crash-left staging folders at startup and migrates again from the untouched original', async () => {
    const legacy = transcriptPath('agent-1');
    const staging = path.join(path.dirname(legacy), 'agent-1.migrating-12345678-1234-1234-1234-123456789abc');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 's1.jsonl'), 'incomplete split');
    fs.writeFileSync(legacy, JSON.stringify(ev(1)) + '\n');
    await cleanupTranscriptStaging();
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(await readChatTranscript('agent-1')).toEqual([ev(1)]);
  });

  it('migrates realistic sessions with late ids and endings without selecting a retired session', async () => {
    const oldStart = start(1, 'old', 100);
    const newStart = start(1, 'new', 200);
    const lateId: ChatEvent = { ...ev(2, 'old'), ts: 210, type: 'session_info', data: { nativeSessionId: 'native-old' } };
    const newId: ChatEvent = { ...ev(2, 'new'), ts: 220, type: 'session_info', data: { nativeSessionId: 'native-new' } };
    const newMessage: ChatEvent = { ...ev(3, 'new'), ts: 230, type: 'user_message', data: { messageId: 'm1', content: [{ type: 'text', text: 'New task' }], source: 'user', delivery: 'prompt' } };
    const lateEnd: ChatEvent = { ...ev(3, 'old'), ts: 300, type: 'session_ended', data: { reason: 'stopped' } };
    const events = [oldStart, newStart, lateId, newId, newMessage, lateEnd];
    const legacy = transcriptPath('agent-1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const content = events.map((event) => JSON.stringify(event) + '\n').join('');
    fs.writeFileSync(legacy, content);
    expect(await readChatTranscript('agent-1')).toEqual([newStart, newId, newMessage]);
    expect(await readChatTranscript('agent-1', { sessionId: 'old' })).toEqual([oldStart, lateId, lateEnd]);
    expect(await listChatSessions('agent-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'old', nativeSessionId: 'native-old', endedAt: 300 }),
      expect.objectContaining({ sessionId: 'new', nativeSessionId: 'native-new', title: 'New task' }),
    ]));
    expect(fs.readFileSync(legacy, 'utf8')).toBe(content);
    resetTranscriptCache();
    expect((await readChatTranscript('agent-1'))[0]).toEqual(newStart);
    const resumed = start(4, 'old', 400);
    await appendChatEvent(resumed);
    expect(await readChatTranscript('agent-1')).toEqual([oldStart, lateId, lateEnd, resumed]);
  });
});

describe('flushAllTranscripts (#2053)', () => {
  it('resolves once every agent\'s appends are on disk, even ones queued while flushing', async () => {
    void appendChatEvent(ev(1, 's1', 'agent-a'));
    void appendChatEvent(ev(1, 's1', 'agent-b')).then(() => appendChatEvent(ev(2, 's1', 'agent-c')));
    await flushAllTranscripts();
    const read = (id: string) => fs.readFileSync(transcriptPath(id, 's1'), 'utf-8').trim().split('\n').length;
    expect([read('agent-a'), read('agent-b'), read('agent-c')]).toEqual([1, 1, 1]);
  });
});

describe('transcript hardening (#2198)', () => {
  const legacyLines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).seq);
  function writeLegacy(events: ChatEvent[], agentId = 'agent-1'): string {
    const legacy = transcriptPath(agentId);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, events.map((e) => JSON.stringify(e) + '\n').join(''));
    return legacy;
  }
  async function failFolderRename(): Promise<{ attempts: () => number }> {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    let attempts = 0;
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.migrating-') && !String(from).endsWith('index.json.tmp')) {
        attempts++;
        throw Object.assign(new Error('folder locked'), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    });
    return { attempts: () => attempts };
  }
  // Lets queued filesystem work settle without saving the index (flushTranscript would save it).
  const flushTranscriptQueueOnly = () => new Promise<void>((resolve) => setImmediate(resolve));
  const indexOnDisk = () => JSON.parse(fs.readFileSync(path.join(path.dirname(transcriptPath('agent-1', 's1')), 'index.json'), 'utf8')) as { sessions: { sessionId: string; lastSeq: number; bytes: number }[]; legacyBytes?: number };

  afterEach(() => {
    vi.mocked(fsp.rename).mockReset();
    vi.mocked(fsp.readFile).mockReset();
    vi.mocked(fsp.open).mockReset();
    vi.mocked(fsp.stat).mockReset();
    vi.mocked(fsp.writeFile).mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backs off a persistently failing migration while every append still lands in the legacy log', async () => {
    const legacy = writeLegacy([ev(1)]);
    const { attempts } = await failFolderRename();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let seq = 2; seq <= 51; seq++) await expect(appendChatEvent(ev(seq))).resolves.toBeUndefined();
    expect(attempts()).toBe(1);
    expect(legacyLines(legacy)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    expect(fs.existsSync(path.dirname(transcriptPath('agent-1', 's1')))).toBe(false);

    now += 10_000;
    await appendChatEvent(ev(52));
    expect(attempts()).toBe(2);
    await appendChatEvent(ev(53));
    expect(attempts()).toBe(2);

    vi.mocked(fsp.rename).mockReset();
    now += 10_000;
    await appendChatEvent(ev(54));
    expect(legacyLines(legacy)).toHaveLength(53);
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual(Array.from({ length: 54 }, (_, i) => i + 1));
    expect(await lastSeqFor('agent-1', 's1')).toBe(54);
  });

  it('a successful read ends the backoff so appends move to the session files', async () => {
    const legacy = writeLegacy([ev(1)]);
    await failFolderRename();
    await appendChatEvent(ev(2));
    vi.mocked(fsp.rename).mockReset();
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2]);
    await appendChatEvent(ev(3));
    expect(legacyLines(legacy)).toEqual([1, 2]);
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('syncs every migrated file and the staging folder before publishing it', async () => {
    writeLegacy([ev(1, 'a'), ev(1, 'b'), ev(2, 'a')]);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const log: string[] = [];
    vi.mocked(fsp.open).mockImplementation(async (file, ...rest) => {
      const handle = await actual.open(file, ...rest);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { log.push(`sync ${path.basename(String(file))}`); return sync(); };
      return handle;
    });
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      log.push(`rename ${path.basename(String(from))}`);
      return actual.rename(from, to);
    });
    expect((await readChatTranscript('agent-1', { sessionId: 'a' })).map((e) => e.seq)).toEqual([1, 2]);
    const publish = log.findIndex((entry) => /^rename agent-1\.migrating-/.test(entry));
    expect(publish).toBeGreaterThan(0);
    const before = log.slice(0, publish);
    expect(before).toEqual(expect.arrayContaining(['sync a.jsonl', 'sync b.jsonl', 'sync index.json']));
    if (process.platform !== 'win32') expect(before.at(-1)).toMatch(/^sync agent-1\.migrating-/);
  });

  it('does not publish when syncing a migrated file fails, and keeps appends in the legacy log', async () => {
    const legacy = writeLegacy([ev(1)]);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fsp.open).mockImplementation(async (file, ...rest) => {
      const handle = await actual.open(file, ...rest);
      if (String(file).includes('.migrating-') && String(file).endsWith('.jsonl')) handle.sync = async () => { throw new Error('EIO'); };
      return handle;
    });
    await appendChatEvent(ev(2));
    expect(fs.existsSync(path.dirname(transcriptPath('agent-1', 's1')))).toBe(false);
    expect(legacyLines(legacy)).toEqual([1, 2]);
    vi.mocked(fsp.open).mockReset();
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('imports events an older build appended to the legacy log after migration', async () => {
    const legacy = writeLegacy([start(1, 'old', 1), ev(2, 'old')]);
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2]);
    expect(indexOnDisk().legacyBytes).toBe(fs.statSync(legacy).size);
    await appendChatEvent(ev(3, 'old'));
    await flushAllTranscripts();
    const before = fs.readFileSync(legacy, 'utf8');
    // A downgraded build keeps writing to the legacy log, including a new session.
    const downgrade = [ev(4, 'old'), start(1, 'down', 50), ev(2, 'down')];
    fs.appendFileSync(legacy, downgrade.map((e) => JSON.stringify(e) + '\n').join(''));
    const grown = fs.readFileSync(legacy, 'utf8');
    resetTranscriptCache();
    expect(await readChatTranscript('agent-1')).toEqual([downgrade[1], downgrade[2]]);
    expect((await readChatTranscript('agent-1', { sessionId: 'old' })).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await lastSeqFor('agent-1', 'old')).toBe(4);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(grown);
    expect(grown.startsWith(before)).toBe(true);
    // Imported once: another restart adds nothing.
    resetTranscriptCache();
    expect((await readChatTranscript('agent-1', { sessionId: 'old' })).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await readChatTranscript('agent-1', { sessionId: 'down' })).toEqual([downgrade[1], downgrade[2]]);
  });

  it('reconciles a legacy log split by a build that did not record its size, without duplicates', async () => {
    const legacy = writeLegacy([ev(1), ev(2)]);
    await readChatTranscript('agent-1');
    const indexFile = path.join(path.dirname(transcriptPath('agent-1', 's1')), 'index.json');
    const { legacyBytes: _legacyBytes, ...older } = indexOnDisk();
    fs.writeFileSync(indexFile, JSON.stringify(older));
    fs.appendFileSync(legacy, JSON.stringify(ev(3)) + '\n');
    resetTranscriptCache();
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(indexOnDisk().legacyBytes).toBe(fs.statSync(legacy).size);
  });

  it('does not duplicate imported events when the index was not saved after an import', async () => {
    const legacy = writeLegacy([ev(1)]);
    await readChatTranscript('agent-1');
    fs.appendFileSync(legacy, JSON.stringify(ev(2)) + '\n');
    resetTranscriptCache();
    // The import lands, then the index save fails (a crash at that point).
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('index locked'));
    await expect(readChatTranscript('agent-1')).rejects.toThrow('index locked');
    expect(fs.readFileSync(transcriptPath('agent-1', 's1'), 'utf8').trim().split('\n')).toHaveLength(2);
    resetTranscriptCache({ crash: true });
    expect((await readChatTranscript('agent-1')).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('appends without rewriting the index or re-checking the file each time', async () => {
    await appendChatEvent(ev(1));
    vi.mocked(fsp.rename).mockClear();
    vi.mocked(fsp.writeFile).mockClear();
    vi.mocked(fsp.open).mockClear();
    vi.mocked(fsp.stat).mockClear();
    for (let seq = 2; seq <= 50; seq++) await appendChatEvent(ev(seq));
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled();
    expect(vi.mocked(fsp.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(fsp.open)).not.toHaveBeenCalled();
    expect(vi.mocked(fsp.stat)).not.toHaveBeenCalled();
    expect(await lastSeqFor('agent-1', 's1')).toBe(50);
  });

  it('saves the index shortly after appends stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await appendChatEvent(ev(1));
    await appendChatEvent(ev(2));
    expect(indexOnDisk().sessions).toEqual([]);
    vi.advanceTimersByTime(999);
    await flushTranscriptQueueOnly();
    expect(indexOnDisk().sessions).toEqual([]);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(indexOnDisk().sessions).toEqual([expect.objectContaining({ sessionId: 's1', lastSeq: 2 })]));
    expect(indexOnDisk().sessions[0].bytes).toBe(fs.statSync(transcriptPath('agent-1', 's1')).size);
  });

  it('keeps a lazily written index correct after a simulated crash', async () => {
    await appendChatEvent(start(1, 'old', 1));
    await appendChatEvent(ev(2, 'old'));
    await flushAllTranscripts();
    const saved = indexOnDisk();
    await appendChatEvent(ev(3, 'old'));
    await appendChatEvent(start(1, 'new', 10));
    await appendChatEvent({ ...ev(2, 'new'), ts: 11, type: 'user_message', data: { messageId: 'm', content: [{ type: 'text', text: 'After the save' }], source: 'user', delivery: 'prompt' } });
    // The crash loses the pending index update.
    resetTranscriptCache({ crash: true });
    expect(indexOnDisk()).toEqual(saved);
    expect(await lastSeqFor('agent-1', 'old')).toBe(3);
    expect(await lastSeqFor('agent-1', 'new')).toBe(2);
    expect((await readChatTranscript('agent-1')).map((e) => `${e.sessionId}${e.seq}`)).toEqual(['new1', 'new2']);
    expect((await listChatSessions('agent-1')).find((s) => s.sessionId === 'new')).toHaveProperty('title', 'After the save');
    await appendChatEvent(ev(4, 'old'));
    expect((await readChatTranscript('agent-1', { sessionId: 'old' })).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    await flushAllTranscripts();
    expect(indexOnDisk().sessions.find((s) => s.sessionId === 'old')).toEqual(expect.objectContaining({ lastSeq: 4, bytes: fs.statSync(transcriptPath('agent-1', 'old')).size }));
  });

  it('flushAllTranscripts saves pending index changes', async () => {
    await appendChatEvent(ev(1));
    await appendChatEvent(ev(2));
    await flushAllTranscripts();
    expect(indexOnDisk().sessions).toEqual([expect.objectContaining({ sessionId: 's1', lastSeq: 2 })]);
  });
});
