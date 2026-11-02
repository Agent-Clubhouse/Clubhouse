import { beforeEach, describe, expect, it } from 'vitest';
import {
  INCOMPLETE_INPUT_WARNING, INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY, OUTER_TOOL_INPUT_MAX_BYTES, PERMISSIONS_TOTAL_MAX_BYTES, PERMISSION_INPUT_MAX_BYTES,
  TOOL_EVENT_MAX_BYTES, _forgetAppendedNotesForTest, _forgetSentPermissionsForTest, forgetAppendedNotes, boundChatEvent, boundPendingPermissions, boundToolInput, incompleteInputWarning, isIncompletePermission, previewText, toolInputSizeBucket,
} from './annex-chat-bounds';

const update = (data: Record<string, unknown>) => ({ type: 'tool_call_update', agentId: 'a', seq: 1, ts: 0, sessionId: 's', data: { toolCallId: 't', ...data } }) as never;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('previewText', () => {
  it('leaves what fits', () => {
    expect(previewText('short', 100)).toBe('short');
  });

  it('keeps both ends within the limit, and says how much went', () => {
    const preview = previewText(`${'a\n'.repeat(50_000)}`, 4096);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(4096);
    expect(preview).toMatch(/\[Clubhouse: \d+ bytes of this output are omitted here/);
  });

  it('never splits a character', () => {
    const preview = previewText('🦊'.repeat(100_000), 4096);
    expect(preview).not.toContain('�');
    expect(Buffer.from(preview).toString()).toBe(preview);
    expect(preview).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('never ends the first part inside an escape sequence', () => {
    const preview = previewText('\x1b[38;2;1;2;3mx'.repeat(100_000), 4096);
    const head = preview.slice(0, preview.indexOf('\n[Clubhouse'));
    expect(head).toMatch(/(^|x)$/);
  });

  it('measures what is sent, so control characters count as their escapes', () => {
    const preview = previewText('\x01'.repeat(20 * 1024 * 1024), 256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(256 * 1024);
    expect(preview).toMatch(/\[Clubhouse: \d+ bytes/);
  });

  it('never starts the last part inside an escape sequence', () => {
    const sequence = '\x1b[38;2;10;20;30mA';
    for (let pad = 0; pad < sequence.length; pad++) {
      const preview = previewText(`${'y'.repeat(pad)}${sequence.repeat(100_000)}`, 4096);
      const tail = preview.slice(preview.lastIndexOf(']\n') + 2);
      // Whole sequences, after at most the one character that followed the one it skipped.
      expect(['', 'A']).toContain(tail.replaceAll(sequence, ''));
    }
  });

  it('cuts at a line when one is near', () => {
    const preview = previewText(`${'line of text\n'.repeat(100_000)}`, 4096);
    expect(preview.slice(0, preview.indexOf('\n[Clubhouse'))).toMatch(/line of text\n$/);
  });
});

describe('boundChatEvent', () => {
  const big = 'x'.repeat(5 * 1024 * 1024);

  it('previews a terminal block\'s command and cwd, not only its output', () => {
    const event = update({ content: [{ type: 'terminal', command: 'c'.repeat(20 * 1024 * 1024), cwd: 'd'.repeat(2 * 1024 * 1024), output: 'ok', exitCode: 2 }] });
    const bounded = boundChatEvent(event, bytes(event)) as any;
    expect(bytes(bounded)).toBeLessThan(64 * 1024);
    const [block] = bounded.data.content;
    expect(block).toMatchObject({ type: 'terminal', output: 'ok', exitCode: 2 });
    expect(block.command).toMatch(/\[Clubhouse: \d+ bytes/);
    expect(block.cwd).toMatch(/\[Clubhouse: \d+ bytes/);
  });

  it('previews a diff\'s path', () => {
    const event = update({ content: [{ type: 'diff', path: 'p'.repeat(2 * 1024 * 1024), newText: 'small' }] });
    expect(bytes(boundChatEvent(event, bytes(event)))).toBeLessThan(8 * 1024);
  });

  it('says so whenever a diff becomes text, even if what is left looks whole', () => {
    const event = update({ content: [{ type: 'diff', path: 'f', oldText: 'o'.repeat(3 * 1024 * 1024), newText: 'small' }] });
    const [block] = (boundChatEvent(event, bytes(event)) as any).data.content;
    expect(block.type).toBe('text');
    expect(block.text).toContain('too large to show as a diff');
    expect(block.text).toContain('small');
  });

  it('stays within its limit when the output is all control characters', () => {
    const one = update({ content: [{ type: 'terminal', output: '\x01'.repeat(20 * 1024 * 1024) }] });
    expect(bytes(boundChatEvent(one, bytes(one)))).toBeLessThanOrEqual(TOOL_EVENT_MAX_BYTES);
    const two = update({ content: [{ type: 'text', text: '\x01'.repeat(10 * 1024 * 1024) }, { type: 'text', text: '\x02'.repeat(10 * 1024 * 1024) }] });
    expect(bytes(boundChatEvent(two, bytes(two)))).toBeLessThanOrEqual(TOOL_EVENT_MAX_BYTES);
  });

  it('passes everything else through, however large', () => {
    const event = { type: 'assistant_message', data: { text: big } } as never;
    expect(boundChatEvent(event, bytes(event))).toBe(event);
  });

  it('passes a small tool update through', () => {
    const event = update({ status: 'completed', content: [{ type: 'text', text: 'small' }] });
    expect(boundChatEvent(event, bytes(event))).toBe(event);
  });

  it('keeps what the call is, and replaces content', () => {
    const event = update({ status: 'failed', durationMs: 5, error: 'it broke', contentMode: 'append', content: [{ type: 'terminal', command: 'c', cwd: '/x', output: big, exitCode: 2 }] });
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data).toMatchObject({ toolCallId: 't', status: 'failed', durationMs: 5, error: 'it broke', contentMode: 'replace', truncated: { originalBytes: bytes(event) } });
    expect(data.content[0]).toMatchObject({ type: 'terminal', command: 'c', cwd: '/x', exitCode: 2 });
    expect(bytes(data)).toBeLessThan(TOOL_EVENT_MAX_BYTES);
  });

  it('keeps a small rawOutput and drops a large one', () => {
    const small = boundChatEvent(update({ content: [{ type: 'text', text: big }], rawOutput: { ok: true } }), 6 * 1024 * 1024) as any;
    expect(small.data.rawOutput).toEqual({ ok: true });
    _forgetAppendedNotesForTest();
    const large = boundChatEvent(update({ rawOutput: { stdout: big } }), 6 * 1024 * 1024) as any;
    expect(large.data).not.toHaveProperty('rawOutput');
    // It had no content, so what the call already shows stays, with a note after it.
    expect(large.data.contentMode).toBe('append');
    expect(large.data.content[0].text).toMatch(/this is a preview/);
  });

  describe('the note appended when an update has no content', () => {
    const rawOnly = (seq: number, toolCallId = 't', sessionId = 's') => ({ ...update({ rawOutput: { stdout: big } }), seq, sessionId, data: { toolCallId, rawOutput: { stdout: big } } }) as any;
    const bound = (event: any) => boundChatEvent(event, 6 * 1024 * 1024) as any;

    beforeEach(() => _forgetAppendedNotesForTest());

    it('is appended once for a call, however many updates it gets', () => {
      const frames = Array.from({ length: 129 }, (_, i) => bound(rawOnly(i + 1)));
      const notes = frames.filter((f) => f.data.content);
      expect(notes).toHaveLength(1);
      expect(notes[0].seq).toBe(1);
      for (const frame of frames.slice(1)) {
        expect(frame.data).not.toHaveProperty('contentMode');
        expect(frame.data).not.toHaveProperty('rawOutput');
        expect(frame.data.toolCallId).toBe('t');
      }
    });

    it('gives the same event the same frame every time, so replay and history match', () => {
      const first = bound(rawOnly(5));
      const second = bound(rawOnly(6));
      expect(bound(rawOnly(5))).toEqual(first);
      expect(bound(rawOnly(6))).toEqual(second);
    });

    it('is per call and per session', () => {
      expect(bound(rawOnly(1, 't1')).data.content).toBeDefined();
      expect(bound(rawOnly(2, 't2')).data.content).toBeDefined();
      expect(bound(rawOnly(3, 't1', 'other')).data.content).toBeDefined();
      expect(bound(rawOnly(4, 't1')).data.content).toBeUndefined();
    });

    it('can show one more after a restart, and no more than that', () => {
      bound(rawOnly(1));
      _forgetAppendedNotesForTest();
      const after = [bound(rawOnly(2)), bound(rawOnly(3)), bound(rawOnly(4))];
      expect(after.filter((f) => f.data.content)).toHaveLength(1);
    });

    it('forgets a session once it ends, and only that session', () => {
      bound(rawOnly(1, 't', 's1'));
      bound(rawOnly(2, 't', 's2'));
      forgetAppendedNotes('a', 's1');
      expect(bound(rawOnly(3, 't', 's1')).data.content).toBeDefined();
      expect(bound(rawOnly(4, 't', 's2')).data.content).toBeUndefined();
    });

    it('stays bounded with very many calls', () => {
      // Small events told they're large: what's being tested is the cache, not the size.
      const small = (seq: number, toolCallId: string) => ({ ...update({}), seq, data: { toolCallId } }) as any;
      for (let i = 0; i < 5000; i++) boundChatEvent(small(i, `call_${i}`), 6 * 1024 * 1024);
      expect((boundChatEvent(small(5000, 'call_4999'), 6 * 1024 * 1024) as any).data.content).toBeUndefined();
      // The oldest has gone, so it can show one more. That's the bound working.
      expect((boundChatEvent(small(5001, 'call_0'), 6 * 1024 * 1024) as any).data.content).toBeDefined();
    });
  });

  it('says so in the text even when only rawOutput was large and the blocks are whole', () => {
    const { data } = boundChatEvent(update({ content: [{ type: 'text', text: 'small' }], rawOutput: { stdout: big } }), 6 * 1024 * 1024) as any;
    expect(data.contentMode).toBe('replace');
    expect(data.content[0].text).toMatch(/this is a preview/);
    expect(data.content[1].text).toBe('small');
  });

  it('turns a diff too large to send into text, so part of one can not read as the change', () => {
    const { data } = boundChatEvent(update({ content: [{ type: 'diff', path: 'a.ts', oldText: big, newText: big }] }), 11 * 1024 * 1024) as any;
    expect(data.content[0].type).toBe('text');
    expect(data.content[0].text.startsWith('a.ts\n')).toBe(true);
    expect(bytes(data)).toBeLessThan(TOOL_EVENT_MAX_BYTES);
  });

  it('stays bounded with very many blocks, and says some went', () => {
    const blocks = Array.from({ length: 5000 }, () => ({ type: 'text', text: 'y'.repeat(4096) }));
    const { data } = boundChatEvent(update({ content: blocks }), 20 * 1024 * 1024) as any;
    expect(bytes(data)).toBeLessThan(2 * TOOL_EVENT_MAX_BYTES);
    expect(data.content.at(-1).text).toMatch(/4936 more blocks/);
  });
});

describe('permission requests', () => {
  const big = 'c'.repeat(2 * 1024 * 1024);
  const options = [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }];
  let id = 0;
  const request = (data: Record<string, unknown> = {}) => ({
    type: 'permission_request', agentId: 'a', seq: 1, ts: Date.now() + 1000, sessionId: 's',
    data: { requestId: `perm_${++id}`, title: 'Write a.ts', toolName: 'Write', toolCallId: 't', options, rawInput: { file_path: '/x/a.ts', content: big }, ...data },
  }) as any;

  it('puts the warning first in description and in content, where 147 draws them', () => {
    const event = request({ description: '/x/a.ts' });
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data.description.startsWith(INCOMPLETE_INPUT_WARNING)).toBe(true);
    expect(data.description).toContain('/x/a.ts');
    expect(data.content).toHaveLength(1);
    expect(data.content[0].type).toBe('text');
    expect(data.content[0].text.startsWith(INCOMPLETE_INPUT_WARNING)).toBe(true);
    expect(data.content[0].text).toContain('ccc');
  });

  it('uses the title when there is no description', () => {
    const event = request();
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data.description).toBe(`${INCOMPLETE_INPUT_WARNING} Write a.ts`);
  });

  it('keeps what identifies and answers the request, within the cap', () => {
    const event = request();
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data).toMatchObject({ requestId: event.data.requestId, title: 'Write a.ts', toolName: 'Write', toolCallId: 't', options, truncated: { originalBytes: bytes(event) } });
    expect(data.rawInput).toEqual({ file_path: '/x/a.ts' });
    expect(bytes(data)).toBeLessThanOrEqual(PERMISSION_INPUT_MAX_BYTES + 4096);
  });

  it('previews the content it came with when it has some', () => {
    const event = request({ rawInput: undefined, content: [{ type: 'diff', path: 'a.ts', oldText: big, newText: 'new' }] });
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data.content[0].text.startsWith(INCOMPLETE_INPUT_WARNING)).toBe(true);
    expect(data.content[0].text).toContain('a.ts');
  });

  it('leaves one under the cap alone, and approvable', () => {
    _forgetSentPermissionsForTest(0);
    const event = request({ rawInput: { file_path: '/x/a.ts', content: 'small' } });
    expect(boundChatEvent(event, bytes(event))).toBe(event);
    expect(isIncompletePermission(event)).toBe(false);
  });

  it('never changes the event it was given', () => {
    const event = request();
    const copy = JSON.stringify(event);
    boundChatEvent(event, bytes(event));
    expect(JSON.stringify(event)).toBe(copy);
  });

  it('knows one over the cap is incomplete, from the event alone', () => {
    expect(isIncompletePermission(request())).toBe(true);
  });

  describe('what the warning promises', () => {
    const allow = { optionId: 'allow', kind: 'allow_once', label: 'Allow' };
    const withDeny = (kind: string) => [allow, { optionId: 'no', kind, label: 'No' }];

    it.each(['reject_once', 'cancel_turn', 'reject_always'])('offers deny when there is a %s option', (kind) => {
      expect(incompleteInputWarning(withDeny(kind))).toBe(INCOMPLETE_INPUT_WARNING);
    });

    it('is desktop only with no options, or only approve options', () => {
      expect(incompleteInputWarning([])).toBe(INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY);
      expect(incompleteInputWarning([allow])).toBe(INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY);
    });

    it('is desktop only for a reject kind a phone does not know', () => {
      expect(incompleteInputWarning(withDeny('reject_session'))).toBe(INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY);
    });

    it('is desktop only for a persistent deny with persistent approvals off', () => {
      expect(incompleteInputWarning(withDeny('reject_always'), false)).toBe(INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY);
      expect(incompleteInputWarning(withDeny('reject_once'), false)).toBe(INCOMPLETE_INPUT_WARNING);
    });

    it('puts the right one first on the preview, and promises nothing it can not do', () => {
      const none = request({ options: [] });
      const { data } = boundChatEvent(none, bytes(none)) as any;
      expect(data.description.startsWith(INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY)).toBe(true);
      expect(data.content[0].text.startsWith(INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY)).toBe(true);
      expect(`${data.description}${data.content[0].text}`).not.toMatch(/deny/i);
    });
  });

  describe('whether a phone can approve', () => {
    const small = () => request({ rawInput: { file_path: '/x' } });
    const medium = () => request({ rawInput: { content: 'm'.repeat(200 * 1024) } });

    describe('with input that is all control characters', () => {
      const controls = (megabytes: number) => '\x01'.repeat(megabytes * 1024 * 1024);

      it('keeps one within the permission cap as sent', () => {
        const [row] = boundPendingPermissions([request({ rawInput: { content: controls(20) } })]);
        expect(bytes(row.data)).toBeLessThanOrEqual(256 * 1024);
      });

      it('shares the total evenly rather than the first taking it', () => {
        const rows = boundPendingPermissions(Array.from({ length: 6 }, () => request({ rawInput: { content: controls(2) } })));
        const sizes = rows.map((row) => bytes(row.data));
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1024 * 1024);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
        expect(Math.min(...sizes)).toBeGreaterThan(100 * 1024);
      });

      it('keeps a tool call within its cap', () => {
        const event = { type: 'tool_call', agentId: 'a', seq: 1, ts: 0, sessionId: 's', data: { toolCallId: 't', kind: 'other', title: 'T', status: 'pending', content: [{ type: 'text', text: controls(10) }, { type: 'text', text: controls(10) }] } } as never;
        expect(bytes(boundChatEvent(event, bytes(event)))).toBeLessThanOrEqual(1024 * 1024);
      });

      it('does not count a small field by its raw size', () => {
        const [row] = boundPendingPermissions([request({ rawInput: { note: '\x01'.repeat(1000), content: controls(2) } })]) as any[];
        expect(row.data.rawInput).not.toHaveProperty('note');
      });
    });

    it('stays refused through a reconnect once a preview was sent, when it would fit alone now', () => {
      const pending = Array.from({ length: 12 }, medium);
      boundPendingPermissions(pending);
      // The others are resolved, so it would fit. A phone still only saw part of it.
      expect(boundPendingPermissions([pending[0]])).toHaveLength(1);
      expect(isIncompletePermission(pending[0])).toBe(true);
    });

    it('refuses one left pending across a restart, since nothing remembers what was shown', () => {
      const event = medium();
      event.ts = 1000;
      _forgetSentPermissionsForTest(2000);
      expect(isIncompletePermission(event)).toBe(true);
    });

    it('allows a new one after a restart, when it was sent whole', () => {
      _forgetSentPermissionsForTest(2000);
      const event = medium();
      event.ts = 3000;
      expect(isIncompletePermission(event)).toBe(false);
    });

    it('allows a small one across a restart: no total can ever cut it', () => {
      const event = small();
      event.ts = 1000;
      _forgetSentPermissionsForTest(2000);
      expect(isIncompletePermission(event)).toBe(false);
    });

    /** A request of exactly this encoded size, in its data. */
    const sized = (target: number) => {
      const event = request({ rawInput: { pad: '' } });
      event.data.rawInput.pad = 'p'.repeat(target - bytes(event.data));
      expect(bytes(event.data)).toBe(target);
      return event;
    };

    it('takes the floor from the real size, with options counted, on either side of it', () => {
      _forgetSentPermissionsForTest(Date.now() + 60_000);
      expect(isIncompletePermission(sized(4096))).toBe(false);
      expect(isIncompletePermission(sized(4097))).toBe(true);
      // Options push a small input over.
      const manyOptions = Array.from({ length: 40 }, (_, i) => ({ optionId: `o${i}`, kind: 'allow_once', label: 'l'.repeat(100) }));
      expect(isIncompletePermission(request({ rawInput: { file_path: '/x' }, options: manyOptions }))).toBe(true);
    });

    it('never treats a small projection of a large request as complete', () => {
      _forgetSentPermissionsForTest(0);
      const full = request();
      const preview = boundChatEvent(full, bytes(full)) as any;
      const small = { ...preview, data: { ...preview.data, content: [{ type: 'text', text: 'short' }], description: 'short' } };
      expect(bytes(small.data)).toBeLessThan(4096);
      expect(isIncompletePermission(small)).toBe(true);
    });

    it('keeps a small request refused if a preview of it is on file, even with no time on its side', () => {
      _forgetSentPermissionsForTest(0);
      const event = sized(2048);
      // A share below its size is not reachable from the floor alone, so record it the way a preview does.
      boundChatEvent(event, 1024 * 1024);
      expect(isIncompletePermission(event)).toBe(true);
    });

    it('refuses when the options the agent would act on are not the ones a phone was shown', () => {
      _forgetSentPermissionsForTest(0);
      const event = small();
      expect(isIncompletePermission(event, options as never)).toBe(false);
      expect(isIncompletePermission(event, [...options, { optionId: 'always', kind: 'allow_always', label: 'Always' }] as never)).toBe(true);
      expect(isIncompletePermission(event, [{ ...options[0], label: 'Allow everything' }, options[1]] as never)).toBe(true);
    });

    it('fails closed for older requests once the record has had to forget one', () => {
      _forgetSentPermissionsForTest(0);
      const older = medium();
      older.ts = Date.now() - 60_000;
      expect(isIncompletePermission(older)).toBe(false);
      for (let i = 0; i < 1001; i++) boundChatEvent(request({ requestId: `flood_${i}`, rawInput: { file_path: '/x' } }), 2 * 1024 * 1024);
      expect(isIncompletePermission(older)).toBe(true);
    });
  });

  describe('across pending permissions', () => {
    const medium = () => request({ rawInput: { content: 'm'.repeat(200 * 1024) } });

    it('stays within the total, and drops none', () => {
      const pending = Array.from({ length: 12 }, medium);
      const bounded = boundPendingPermissions(pending);
      expect(bounded).toHaveLength(12);
      expect(bytes(bounded)).toBeLessThanOrEqual(PERMISSIONS_TOTAL_MAX_BYTES + 12 * 4096);
      expect(bounded.map((e) => e.data.requestId)).toEqual(pending.map((e) => e.data.requestId));
    });

    it('counts one forced below its own cap as incomplete, even after the others are gone', () => {
      const pending = Array.from({ length: 12 }, medium);
      const bounded = boundPendingPermissions(pending) as any[];
      const forced = bounded.filter((e) => e.data.truncated);
      expect(forced.length).toBeGreaterThan(0);
      for (const e of forced) {
        expect(e.data.description.startsWith(INCOMPLETE_INPUT_WARNING)).toBe(true);
        expect(isIncompletePermission(pending.find((p) => p.data.requestId === e.data.requestId))).toBe(true);
      }
    });

    it('refuses approve for one the total forces down, before /chat has been read', () => {
      const pending = Array.from({ length: 12 }, medium);
      expect(isIncompletePermission(pending[0])).toBe(false);
      boundPendingPermissions(pending);
      expect(isIncompletePermission(pending[0])).toBe(true);
    });

    it('leaves a set that fits alone', () => {
      const pending = [medium(), medium()];
      expect(boundPendingPermissions(pending)).toEqual(pending);
      expect(isIncompletePermission(pending[0])).toBe(false);
    });
  });
});

describe('tool calls', () => {
  const big = 'c'.repeat(2 * 1024 * 1024);
  const call = (data: Record<string, unknown>) => ({ type: 'tool_call', agentId: 'a', seq: 1, ts: 0, sessionId: 's', data: { toolCallId: 't', title: 'Write a.ts', kind: 'edit', status: 'pending', ...data } }) as any;

  it('keeps what the call is, and only the small fields of its input', () => {
    const event = call({ rawInput: { file_path: '/x', content: big }, locations: [{ path: '/x' }] });
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data).toMatchObject({ toolCallId: 't', title: 'Write a.ts', kind: 'edit', status: 'pending', locations: [{ path: '/x' }], rawInput: { file_path: '/x' }, truncated: { originalBytes: bytes(event) } });
    expect(bytes(data)).toBeLessThan(PERMISSION_INPUT_MAX_BYTES);
    // 147 ignores `truncated`, so the text itself has to say.
    expect(data.content[0].text).toMatch(/this is a preview/);
  });

  it('previews its content the same way as an update', () => {
    const event = call({ content: [{ type: 'terminal', command: 'ls', output: big }] });
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data.content[0].text).toMatch(/this is a preview/);
    expect(data.content[1].command).toBe('ls');
    expect(data.content[1].output).toMatch(/\[Clubhouse: \d+ bytes/);
    expect(bytes(data)).toBeLessThan(TOOL_EVENT_MAX_BYTES);
  });

  it('leaves one under the cap alone', () => {
    const event = call({ rawInput: { file_path: '/x', content: 'small' } });
    expect(boundChatEvent(event, bytes(event))).toBe(event);
  });
});

describe('tool input sizes', () => {
  it('puts a size in a fixed bucket', () => {
    expect([0, 64 * 1024, 64 * 1024 + 1, 256 * 1024, 256 * 1024 + 1, 1024 * 1024, 1024 * 1024 + 1].map(toolInputSizeBucket))
      .toEqual(['<=64k', '<=64k', '<=256k', '<=256k', '<=1m', '<=1m', '>1m']);
  });
});

describe('boundToolInput', () => {
  it('leaves what fits', () => {
    const input = { file_path: '/x', content: 'small' };
    expect(boundToolInput(input)).toEqual({ toolInput: input });
  });

  it('keeps small fields and says how large it was', () => {
    const input = { file_path: '/x', count: 3, flag: true, content: 'c'.repeat(100 * 1024) };
    const { toolInput, toolInputTruncated } = boundToolInput(input);
    expect(toolInput).toEqual({ file_path: '/x', count: 3, flag: true });
    expect(toolInputTruncated!.originalBytes).toBeGreaterThan(OUTER_TOOL_INPUT_MAX_BYTES);
    expect(bytes(toolInput)).toBeLessThan(OUTER_TOOL_INPUT_MAX_BYTES);
  });

  it('stays within the cap however many small fields there are', () => {
    const input = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 'v'.repeat(100)]));
    expect(bytes(boundToolInput(input).toolInput)).toBeLessThanOrEqual(OUTER_TOOL_INPUT_MAX_BYTES);
  });

  it('passes undefined through', () => {
    expect(boundToolInput(undefined)).toEqual({ toolInput: undefined });
  });
});
