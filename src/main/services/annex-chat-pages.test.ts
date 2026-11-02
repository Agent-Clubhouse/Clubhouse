import { beforeEach, describe, expect, it } from 'vitest';
import { _forgetAppendedNotesForTest, isIncompletePermission } from './annex-chat-bounds';
import { CHAT_PAGE_MAX_BYTES, PENDING_MINIMAL_MAX_BYTES, buildChatPage } from './annex-chat-pages';

const MIB = 1024 * 1024;
const envelope = (seq: number, type: string, data: object) => ({ v: 1, type, agentId: 'a', sessionId: 's', seq, ts: Date.now() + 1000, data }) as any;
const notice = (seq: number, bytes: number) => envelope(seq, 'notice', { level: 'info', message: 'n'.repeat(bytes) });
const allow = { optionId: 'a', kind: 'allow_once', label: 'Allow' };
const deny = { optionId: 'd', kind: 'reject_once', label: 'Deny' };
const permission = (i: number, options: object[] = [allow, deny], input = 300 * 1024) => envelope(i, 'permission_request', {
  requestId: `perm_${i}`, title: `Write ${i}`, toolName: 'Write', toolCallId: `t${i}`, options, rawInput: { file_path: `/x/${i}`, content: 'c'.repeat(input) },
});
const question = (i: number, prompt: string) => envelope(i, 'question', { requestId: `q_${i}`, questions: [{ id: 'which', prompt, header: 'H', options: [] }] });

function page(parts: { eligible?: any[]; limit?: number; pendingPermissions?: any[]; pendingQuestions?: any[] }) {
  const result = buildChatPage({ metadata: { version: 1 }, eligible: [], limit: 2000, pendingPermissions: [], pendingQuestions: [], ...parts });
  if (result.ok === false) return { result, body: null as any };
  expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(CHAT_PAGE_MAX_BYTES);
  return { result, body: JSON.parse(result.body) };
}

describe('a chat page', () => {
  beforeEach(() => _forgetAppendedNotesForTest());

  it('is all of it when it fits', () => {
    const eligible = [notice(1, 10), notice(2, 10)];
    const { body } = page({ eligible });
    expect(body.events).toEqual(eligible);
    expect(body.truncated).toBe(false);
    expect(body.nextBeforeSeq).toBeNull();
  });

  it('still honors limit', () => {
    const { body } = page({ eligible: [notice(1, 10), notice(2, 10), notice(3, 10)], limit: 2 });
    expect(body.events.map((e: any) => e.seq)).toEqual([2, 3]);
    expect(body.truncated).toBe(true);
    expect(body.nextBeforeSeq).toBe(2);
  });

  it('stops at 8 MiB on encoded bytes, newest kept, with where to go next', () => {
    const eligible = Array.from({ length: 40 }, (_, i) => notice(i + 1, 512 * 1024));
    const { body } = page({ eligible });
    expect(body.events.at(-1).seq).toBe(40);
    expect(body.events.length).toBeLessThan(40);
    expect(body.truncated).toBe(true);
    expect(body.nextBeforeSeq).toBe(body.events[0].seq);
  });

  it('counts multi-byte text and JSON escaping, not characters', () => {
    const eligible = Array.from({ length: 40 }, (_, i) => envelope(i + 1, 'notice', { level: 'info', message: '€\n'.repeat(120 * 1024) }));
    const { body, result } = page({ eligible });
    expect(result.ok).toBe(true);
    expect(body.events.length).toBeLessThan(40);
  });

  it('walks a whole history by nextBeforeSeq, with no event seen twice', () => {
    const all = Array.from({ length: 60 }, (_, i) => notice(i + 1, 400 * 1024));
    const seen: number[] = [];
    let eligible = all;
    for (let round = 0; round < 20; round++) {
      const { body } = page({ eligible });
      seen.unshift(...body.events.map((e: any) => e.seq));
      if (!body.truncated) break;
      eligible = all.filter((e) => e.seq < body.nextBeforeSeq);
    }
    expect(seen).toEqual(all.map((e) => e.seq));
  });

  it('previews a single event too large for it', () => {
    const { body } = page({ eligible: [notice(1, 20 * MIB)] });
    expect(body.events).toHaveLength(1);
    expect(body.events[0].data.message).toMatch(/\[Clubhouse: \d+ bytes/);
    expect(body.truncated).toBe(false);
  });

  it('previews large tool output, keeping id and final status, with no appended note', () => {
    const update = envelope(1, 'tool_call_update', { toolCallId: 't', status: 'completed', content: [{ type: 'text', text: 't'.repeat(20 * MIB) }], rawOutput: { s: 'r'.repeat(20 * MIB) } });
    const rawOnly = envelope(2, 'tool_call_update', { toolCallId: 't', rawOutput: { s: 'r'.repeat(2 * MIB) } });
    const { body } = page({ eligible: [update, rawOnly] });
    expect(body.events[0].data).toMatchObject({ toolCallId: 't', status: 'completed', contentMode: 'replace' });
    expect(body.events[0].data).not.toHaveProperty('rawOutput');
    expect(body.events[1].data).not.toHaveProperty('content');
    expect(body.events[1].data).not.toHaveProperty('rawOutput');
  });

  it('gives the same event the same text however often it is read', () => {
    const eligible = [envelope(1, 'tool_call_update', { toolCallId: 't', rawOutput: { s: 'r'.repeat(2 * MIB) } })];
    expect(page({ eligible }).body).toEqual(page({ eligible }).body);
  });

  it('never changes a question in history, and steps past one no page can hold', () => {
    const small = question(1, 'exact text');
    expect(page({ eligible: [small] }).body.events[0]).toEqual(small);
    const { body } = page({ eligible: [notice(1, 10), question(2, 'q'.repeat(9 * MIB))] });
    expect(body.events).toEqual([]);
    expect(body.truncated).toBe(true);
    expect(body.nextBeforeSeq).toBe(2);
  });

  describe('pending permissions', () => {
    it('stay whole when they fit', () => {
      const pendingPermissions = [permission(1, undefined, 100)];
      const { body, result } = page({ pendingPermissions });
      expect(result.stage).toBe('whole');
      expect(body.pendingPermissions).toEqual(pendingPermissions);
    });

    it('go minimal together past 1 MiB, with none missing and approve refused for each', () => {
      const pendingPermissions = Array.from({ length: 300 }, (_, i) => permission(i + 1));
      const { body, result } = page({ pendingPermissions });
      expect(result.stage).toBe('minimal');
      expect(body.pendingPermissions.map((e: any) => e.data.requestId)).toEqual(pendingPermissions.map((e) => e.data.requestId));
      const [row] = body.pendingPermissions;
      expect(row.data).toEqual({
        requestId: 'perm_1', title: 'Write 1', toolName: 'Write', toolCallId: 't1',
        description: expect.stringMatching(/^Incomplete input: .*Write 1$/), options: [deny], truncated: { originalBytes: expect.any(Number) },
      });
      expect(isIncompletePermission(pendingPermissions[0])).toBe(true);
    });

    it('offers only denies it supports, and says desktop only when there are none', () => {
      const always = { optionId: 'r', kind: 'reject_always', label: 'Never' };
      const odd = { optionId: 'o', kind: 'reject_session', label: 'Odd' };
      const { body } = page({ pendingPermissions: [
        ...Array.from({ length: 300 }, (_, i) => permission(i + 1, [allow, deny, always, odd])),
        permission(999, [allow]),
      ] });
      expect(body.pendingPermissions[0].data.options.map((o: any) => o.kind)).toEqual(['reject_once', 'reject_always']);
      const none = body.pendingPermissions.at(-1).data;
      expect(none.options).toEqual([]);
      expect(none.description).not.toMatch(/deny/i);
    });

    it('never invent an option', () => {
      const { body } = page({ pendingPermissions: Array.from({ length: 300 }, (_, i) => permission(i + 1, [])) });
      expect(body.pendingPermissions[0].data.options).toEqual([]);
    });

    it('make the tail say the same as the list, with no duplicate reading', () => {
      const pendingPermissions = Array.from({ length: 300 }, (_, i) => permission(i + 1));
      const { body } = page({ pendingPermissions, eligible: pendingPermissions.slice(-2) });
      expect(body.events.at(-1).data).toEqual(body.pendingPermissions.at(-1).data);
    });

    it('answer 503 past the minimal limit, with no partial list', () => {
      const title = 't'.repeat(200);
      const rows = Math.ceil(PENDING_MINIMAL_MAX_BYTES / 500) + 1000;
      const pendingPermissions = Array.from({ length: rows }, (_, i) => ({ ...permission(i + 1, [deny], 1), data: { ...permission(i + 1, [deny], 1).data, title } }));
      const { result } = page({ pendingPermissions });
      expect(result).toMatchObject({ ok: false, stage: 'error', failure: { error: 'pending_overflow', pendingCount: rows } });
    });
  });

  describe('pending questions', () => {
    it('are sent exactly', () => {
      const pendingQuestions = [question(1, 'p'.repeat(MIB))];
      expect(page({ pendingQuestions }).body.pendingQuestions).toEqual(pendingQuestions);
    });

    it('answer 503 rather than be shortened, when one can not fit', () => {
      const { result } = page({ pendingQuestions: [question(1, 'p'.repeat(9 * MIB))] });
      expect(result).toMatchObject({ ok: false, failure: { error: 'pending_overflow', pendingCount: 1 } });
    });

    it('leave what room there is for events', () => {
      const { body } = page({ pendingQuestions: [question(1, 'p'.repeat(7 * MIB))], eligible: Array.from({ length: 10 }, (_, i) => notice(i + 1, 512 * 1024)) });
      expect(body.events.length).toBeLessThan(10);
      expect(body.events.length).toBeGreaterThan(0);
    });
  });
});
