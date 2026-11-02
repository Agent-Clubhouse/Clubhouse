import { beforeEach, describe, expect, it } from 'vitest';
import { _forgetAppendedNotesForTest, _forgetSentPermissionsForTest, isIncompletePermission } from './annex-chat-bounds';
import { CHAT_PAGE_MAX_BYTES, PENDING_MINIMAL_MAX_BYTES, buildChatPage } from './annex-chat-pages';
import { remoteChatEvent } from './annex-chat-echo';

const MIB = 1024 * 1024;
const envelope = (seq: number, type: string, data: object) => ({ v: 1, type, agentId: 'a', sessionId: 's', seq, ts: Date.now() + 1000, data }) as any;
const notice = (seq: number, bytes: number) => envelope(seq, 'notice', { level: 'info', message: 'n'.repeat(bytes) });
const remote = remoteChatEvent;
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
  beforeEach(() => {
    _forgetAppendedNotesForTest();
    _forgetSentPermissionsForTest(0);
  });

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

  it('never changes a question in history, and marks one no page can hold', () => {
    const small = question(1, 'exact text');
    expect(page({ eligible: [small] }).body.events[0]).toEqual(small);
    const { body } = page({ eligible: [notice(1, 10), question(2, 'q'.repeat(9 * MIB))] });
    expect(body.events.map((e: any) => [e.seq, e.type])).toEqual([[1, 'notice'], [2, 'notice']]);
    expect(body.events[1].data).toMatchObject({ code: 'event_omitted', omitted: { type: 'question' } });
    expect(body.events[1].data.omitted.originalBytes).toBeGreaterThan(9 * MIB);
    expect(JSON.stringify(body.events[1])).not.toContain('qqqq');
    expect(body.truncated).toBe(false);
  });

  describe('with what is pending taking most of every page', () => {
    const big = question(90, 'p'.repeat(7.9 * MIB));
    const walk = (eligible: any[], pendingQuestions: any[]) => {
      const seen: any[] = [];
      let remaining = eligible;
      for (let guard = 0; guard < 50; guard++) {
        const { body } = page({ eligible: remaining, pendingQuestions });
        seen.unshift(...body.events);
        if (!body.truncated) return seen;
        remaining = eligible.filter((e) => e.seq < body.nextBeforeSeq);
      }
      throw new Error('paging did not finish');
    };

    it('marks an event that would have fit a page without it, rather than skipping it', () => {
      const { body } = page({ eligible: [notice(1, 200 * 1024)], pendingQuestions: [big] });
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({ seq: 1, type: 'notice', data: { code: 'event_omitted', omitted: { type: 'notice' } } });
    });

    it('shows a history question again once there is room', () => {
      const old = question(1, 'q'.repeat(200 * 1024));
      expect(page({ eligible: [old], pendingQuestions: [big] }).body.events[0].data.omitted.type).toBe('question');
      expect(page({ eligible: [old] }).body.events[0]).toEqual(old);
    });

    it('accounts for every event when walked to the start', () => {
      const eligible = Array.from({ length: 6 }, (_, i) => notice(i + 1, 200 * 1024));
      expect(walk(eligible, [big]).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('leaves out only the tail copy of the pending question itself, with the list keeping it whole', () => {
      const active = question(5, 'p'.repeat(5 * MIB));
      const { body } = page({ eligible: [notice(1, 10), active], pendingQuestions: [active] });
      expect(body.pendingQuestions[0]).toEqual(active);
      expect(body.events.map((e: any) => e.seq)).toEqual([1]);
      expect(body.events.some((e: any) => e.data.code === 'event_omitted')).toBe(false);
    });
  });

  describe('an event too large even as a preview', () => {
    it('falls back to a stub when many strings add up, re-measured after previewing', () => {
      const content = Array.from({ length: 60 }, () => ({ type: 'text', text: 't'.repeat(300 * 1024) }));
      const event = envelope(1, 'user_message', { messageId: 'm1', delivery: 'prompt', content });
      const { body } = page({ eligible: [event] });
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({ seq: 1, type: 'notice', data: { omitted: { type: 'user_message' } } });
    });

    it('keeps a tool update whose command is huge, with its id, status and exit code', () => {
      const event = envelope(1, 'tool_call_update', {
        toolCallId: 't1', status: 'completed', durationMs: 5,
        content: [{ type: 'terminal', command: 'c'.repeat(9 * MIB), output: '', exitCode: 3 }],
      });
      const { body } = page({ eligible: [event] });
      const [shown] = body.events;
      expect(shown.type).toBe('tool_call_update');
      expect(shown.data).toMatchObject({ toolCallId: 't1', status: 'completed', durationMs: 5, contentMode: 'replace' });
      expect(shown.data.content.find((b: any) => b.type === 'terminal').exitCode).toBe(3);
      expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThanOrEqual(MIB);
    });

    it('keeps a tool call as one', () => {
      const event = envelope(1, 'tool_call', { toolCallId: 't1', kind: 'other', title: 'x'.repeat(2 * MIB), status: 'pending', content: Array.from({ length: 60 }, () => ({ type: 'text', text: 't'.repeat(300 * 1024) })) });
      const [shown] = page({ eligible: [event] }).body.events;
      expect(shown).toMatchObject({ type: 'tool_call', data: { toolCallId: 't1', kind: 'other', status: 'pending' } });
      expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThanOrEqual(MIB);
    });
  });

  describe('what is pending or queued is never stubbed', () => {
    const blocks = () => Array.from({ length: 10 }, () => ({ type: 'text', text: 't'.repeat(300 * 1024) }));
    const row = (extra: object = {}) => envelope(4, 'user_message', { messageId: 'critical-queued', source: 'user', delivery: 'queued', content: blocks(), ...extra });
    const build = (eligible: any[], pendingQuestions: any[], pendingPermissions: any[] = []) => buildChatPage({ metadata: { version: 1, queuedMessageIds: ['critical-queued'] }, eligible, limit: 2000, pendingPermissions, pendingQuestions });

    it('keeps a queued row as itself when a question leaves it little room', () => {
      const result = build([row()], [question(9, 'p'.repeat(7.5 * MIB))]);
      expect(result.ok).toBe(true);
      expect(Buffer.byteLength((result as any).body)).toBeLessThanOrEqual(CHAT_PAGE_MAX_BYTES);
      const [shown] = JSON.parse((result as any).body).events;
      expect(shown).toMatchObject({ seq: 4, type: 'user_message', data: { messageId: 'critical-queued', source: 'user', delivery: 'queued', truncated: {} } });
      expect(shown.data.content).toHaveLength(10);
      expect(shown.data.content[0].text).toContain('omitted');
    });

    it('keeps queuedWith and routed parts on a shortened join', () => {
      const routed = [{ from: 'helper', text: 'r'.repeat(2 * MIB) }];
      const join = envelope(5, 'user_message', { messageId: 'join', source: 'mcp', delivery: 'queued', queuedWith: 'critical-queued', content: blocks(), routed });
      const result = build([row(), join], [question(9, 'p'.repeat(7.5 * MIB))]);
      const shown = JSON.parse((result as any).body).events.find((e: any) => e.seq === 5);
      expect(shown.data).toMatchObject({ messageId: 'join', queuedWith: 'critical-queued', routed: [{ from: 'helper' }] });
      expect(shown.data.routed[0].text.length).toBeLessThan(MIB);
    });

    it('answers 503 rather than losing a queued row', () => {
      const result = build([row()], [question(9, 'p'.repeat(8 * MIB - 8 * 1024))]);
      expect(result).toMatchObject({ ok: false, failure: { error: 'pending_overflow' } });
    });

    it('answers 503 if a row can not be made small, with what identifies it too large', () => {
      expect(build([row({ clientCommandId: 'c'.repeat(32 * 1024) })], [question(9, 'p'.repeat(7.5 * MIB))]).ok).toBe(false);
    });

    it('leaves out a pending permission\'s tail copy with no room, never a notice in its place', () => {
      const pending = permission(5, [allow, deny], 5 * 1024);
      const result = buildChatPage({ metadata: { version: 1 }, eligible: [pending], limit: 2000, pendingPermissions: [pending], pendingQuestions: [question(9, 'p'.repeat(8 * MIB - 10_750))] });
      expect(result.ok).toBe(true);
      const body = JSON.parse((result as any).body);
      expect(body.pendingPermissions).toHaveLength(1);
      expect(body.events).toEqual([]);
    });

    it('never makes a stub of any row, whatever the tail looks like', () => {
      const eligible = [row(), notice(5, 200 * 1024), notice(6, 200 * 1024)];
      const events = JSON.parse((build(eligible, [question(9, 'p'.repeat(7.5 * MIB))]) as any).body).events;
      expect(events[0].data.messageId).toBe('critical-queued');
      expect(events.filter((e: any) => e.data.omitted?.type === 'user_message')).toEqual([]);
    });

    it('keeps ids on a stub of anything else', () => {
      const { body } = page({ eligible: [envelope(1, 'question_resolved', { requestId: 'q1', answers: { a: 'x'.repeat(9 * MIB) } })] });
      expect(body.events[0].data.omitted).toMatchObject({ type: 'question_resolved', requestId: 'q1' });
    });
  });

  describe('queued rows', () => {
    const queued = (seq: number, messageId: string, extra: object = {}) => envelope(seq, 'user_message', {
      messageId, delivery: 'queued', content: [{ type: 'text', text: `prompt ${seq}` }], routed: { source: 'mcp' }, ...extra,
    });
    const metadata = (ids: string[]) => ({ version: 1, queuedMessageIds: ids });

    it('come on the tail however old, in order, without moving the cursor (a real capture: tail 15 to 29, row at 4)', () => {
      const tail = Array.from({ length: 15 }, (_, i) => notice(i + 15, 512 * 1024));
      const older = Array.from({ length: 10 }, (_, i) => notice(i + 5, 512 * 1024));
      const row = queued(4, 'm4');
      const eligible = [notice(1, 10), row, ...older, ...tail];
      const result = buildChatPage({ metadata: metadata(['m4']), eligible, limit: 2000, pendingPermissions: [], pendingQuestions: [] });
      if (result.ok === false) throw new Error('expected a page');
      expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(CHAT_PAGE_MAX_BYTES);
      const body = JSON.parse(result.body);
      expect(body.events[0]).toEqual(remote(row));
      expect(body.queuedMessageIds).toEqual(['m4']);
      expect(body.truncated).toBe(true);
      expect(body.nextBeforeSeq).toBe(body.events[1].seq);
      expect(body.nextBeforeSeq).toBeGreaterThan(4);
      expect(body.events.at(-1).seq).toBe(29);
    });

    it('include a join by queuedWith, with its source', () => {
      const join = queued(5, 'm5', { queuedWith: 'm4' });
      const eligible = [queued(4, 'm4'), join, ...Array.from({ length: 20 }, (_, i) => notice(i + 6, 512 * 1024))];
      const result = buildChatPage({ metadata: metadata(['m4']), eligible, limit: 2000, pendingPermissions: [], pendingQuestions: [] });
      const body = JSON.parse((result as any).body);
      expect(body.events.slice(0, 2).map((e: any) => e.data.messageId)).toEqual(['m4', 'm5']);
      expect(body.events[1].data).toMatchObject({ queuedWith: 'm4', routed: { source: 'mcp' } });
    });

    it('are not added once delivered, or from a list that does not name them', () => {
      const eligible = [queued(4, 'm4'), ...Array.from({ length: 20 }, (_, i) => notice(i + 5, 512 * 1024))];
      const result = buildChatPage({ metadata: metadata([]), eligible, limit: 2000, pendingPermissions: [], pendingQuestions: [] });
      expect(JSON.parse((result as any).body).events[0].seq).toBeGreaterThan(4);
    });

    it('appear once when the walk reaches them', () => {
      const result = buildChatPage({ metadata: metadata(['m4']), eligible: [notice(1, 10), queued(4, 'm4'), notice(5, 10)], limit: 2000, pendingPermissions: [], pendingQuestions: [] });
      expect(JSON.parse((result as any).body).events.map((e: any) => e.seq)).toEqual([1, 4, 5]);
    });

    it('go to a preview when whole they would not fit, keeping their ids, and to a 503 only past that', () => {
      const huge = (seq: number, id: string) => queued(seq, id, { content: [{ type: 'text', text: 'h'.repeat(5 * MIB) }] });
      const previewed = buildChatPage({ metadata: metadata(['a', 'b']), eligible: [huge(1, 'a'), huge(2, 'b')], limit: 2000, pendingPermissions: [], pendingQuestions: [] });
      const body = JSON.parse((previewed as any).body);
      expect(Buffer.byteLength((previewed as any).body)).toBeLessThanOrEqual(CHAT_PAGE_MAX_BYTES);
      expect(body.events.map((e: any) => e.data.messageId)).toEqual(['a', 'b']);
      expect(body.events[0].data).toMatchObject({ delivery: 'queued', routed: { source: 'mcp' } });

      const full = buildChatPage({ metadata: metadata(['a']), eligible: [huge(1, 'a')], limit: 2000, pendingPermissions: [], pendingQuestions: [question(2, 'p'.repeat(7.5 * MIB))] });
      expect(full.ok).toBe(true);
      expect(JSON.parse((full as any).body).events[0].data.messageId).toBe('a');

      const none = buildChatPage({ metadata: metadata(['a']), eligible: [huge(1, 'a')], limit: 2000, pendingPermissions: [], pendingQuestions: [question(2, 'p'.repeat(8 * MIB - 8 * 1024))] });
      expect(none.ok).toBe(false);
    });
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

    it('have no duplicate row when an old event reuses a pending request id', () => {
      const current = permission(50, [allow, deny], 10);
      const reused = { ...permission(3, [allow, deny], 10), data: { ...permission(3, [allow, deny], 10).data, requestId: current.data.requestId, title: 'Old' } };
      const { body } = page({ eligible: [reused, current], pendingPermissions: [current] });
      expect(body.events.map((e: any) => [e.seq, e.data.title])).toEqual([[3, 'Old'], [50, current.data.title]]);
    });

    it('go minimal rather than 503 when that is what lets a question fit', () => {
      const pendingPermissions = Array.from({ length: 4 }, (_, i) => permission(i, [allow, deny], 200 * 1024));
      const { result, body } = page({ pendingPermissions, pendingQuestions: [question(9, 'p'.repeat(7.5 * MIB))] });
      expect(result).toMatchObject({ ok: true, stage: 'minimal' });
      expect(body.pendingPermissions).toHaveLength(4);
      expect(body.pendingQuestions[0].data.questions[0].prompt).toHaveLength(7.5 * MIB);
    });

    it('do not lock approve when the answer was a 503, since nothing was shown', () => {
      const pendingPermissions = Array.from({ length: 4 }, (_, i) => permission(i, [allow, deny], 200 * 1024));
      const { result } = page({ pendingPermissions, pendingQuestions: [question(9, 'p'.repeat(9 * MIB))] });
      expect(result.ok).toBe(false);
      for (const event of pendingPermissions) expect(isIncompletePermission(event)).toBe(false);
    });

    it('do lock approve on a request a page did shorten', () => {
      const pendingPermissions = Array.from({ length: 12 }, (_, i) => permission(i, [allow, deny], 200 * 1024));
      expect(page({ pendingPermissions }).result.ok).toBe(true);
      for (const event of pendingPermissions) expect(isIncompletePermission(event)).toBe(true);
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
