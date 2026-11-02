import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FEEDBACK_DIAGNOSTICS, type FeedbackDiagnostics } from '../../../shared/feedback-types';
import { addDiagTap, diag, _resetDiagForTests } from '../../telemetry/diag';
import { createDiagnosticsRing, DIAGNOSTICS_CATALOG, WITHHELD_EVENT, type DiagnosticsRing } from './feedback-diagnostics';
import { DIAGNOSTICS_V1_LIMITS, toDiagnosticsV1 } from './feedback-diagnostics-v1';

const START = Date.parse('2026-11-01T12:00:00.000Z');
const SECRETS = [
  'sk-ant-abcdefghijklmnopqrstuvwxyz012345',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl',
  '/Users/somebody/private-project/notes.md',
  'C:\\Users\\somebody\\secret.txt',
  'my private prompt about the merger',
  'project-goobers',
  '482913', // a pairing pin
  'AA:BB:CC:DD:EE:FF:00:11',
];

describe('createDiagnosticsRing', () => {
  let clock: number;
  let ring: DiagnosticsRing;
  beforeEach(() => {
    clock = START;
    ring = createDiagnosticsRing({ now: () => clock, salt: Buffer.alloc(32, 7) });
  });

  describe('allowlist', () => {
    it('sends the event name and declared attrs, never the message', () => {
      ring.note({ ns: 'core:annex', level: 'info', msg: 'WebSocket client disconnected', meta: { authType: 'mtls', code: 1009, reason: 'my private prompt' } });
      const { lines } = ring.collect();
      expect(lines).toEqual([{ at: new Date(START).toISOString(), level: 'info', ns: 'core:annex', event: 'annex.ws.disconnected', attrs: { link: 'mtls', closeCode: 1009 } }]);
    });

    it('reads variable parts only through patterns that pin them down', () => {
      ring.note({ ns: 'core:annex-client', level: 'info', msg: 'Scheduling reconnect in 4000ms (attempt 3)' });
      ring.note({ ns: 'core:annex-client', level: 'warn', msg: 'Satellite state: connected → disconnected', meta: { error: 'read ECONNRESET at 10.0.0.2' } });
      ring.note({ ns: 'core:annex-client', level: 'info', msg: 'Satellite state: connected → my private prompt' });
      const { lines } = ring.collect();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ event: 'annex.client.reconnect_scheduled', attrs: { backoffMs: 4000, attempt: 3 } });
      expect(lines[1]).toMatchObject({ event: 'annex.client.state', attrs: { fromState: 'connected', toState: 'disconnected', failure: 'closed' } });
    });

    it('drops debug lines, unknown namespaces, and info outside the catalog', () => {
      ring.note({ ns: 'core:annex', level: 'debug', msg: 'Annex server stopped' });
      ring.note({ ns: 'plugin:evil', level: 'error', msg: 'Annex server stopped' });
      ring.note({ ns: 'core:annex', level: 'info', msg: 'Something else' });
      expect(ring.collect()).toMatchObject({ status: 'none', reason: 'no_lines', lines: [] });
    });

    it('keeps only namespace, level, time and failure for a warning outside the catalog', () => {
      ring.note({ ns: 'core:git', level: 'error', msg: `git failed in ${SECRETS[3]}`, meta: { error: `spawn ENOENT ${SECRETS[0]}`, cwd: SECRETS[3] } });
      ring.note({ ns: 'core:file', level: 'fatal', msg: 'read failed', meta: { error: 'connect ETIMEDOUT' } });
      const { lines } = ring.collect();
      expect(lines[0]).toEqual({ at: expect.any(String), level: 'error', ns: 'core:git', event: WITHHELD_EVENT, attrs: { failure: 'unknown' } });
      expect(lines[1]).toEqual({ at: expect.any(String), level: 'error', ns: 'core:file', event: WITHHELD_EVENT, attrs: { failure: 'timeout' } });
    });

    it('replaces ids with a keyed hash that is stable within a run', () => {
      const fingerprint = 'AA:BB:CC:DD:EE:FF:00:11';
      ring.note({ ns: 'core:annex-client', level: 'info', msg: 'Connected to satellite', meta: { fingerprint, host: '10.0.0.2' } });
      ring.note({ ns: 'core:annex-client', level: 'info', msg: 'Heartbeat pong timeout — closing connection', meta: { fingerprint } });
      const other = createDiagnosticsRing({ now: () => clock, salt: Buffer.alloc(32, 9) });
      other.note({ ns: 'core:annex-client', level: 'info', msg: 'Connected to satellite', meta: { fingerprint } });
      const [a, b] = ring.collect().lines;
      expect(a.attrs?.peerRef).toMatch(/^[0-9a-f]{16}$/);
      expect(b.attrs?.peerRef).toBe(a.attrs?.peerRef);
      expect(other.collect().lines[0].attrs?.peerRef).not.toBe(a.attrs?.peerRef);
      expect(Object.keys(a.attrs ?? {})).toEqual(['peerRef']);
    });
  });

  describe('adversarial values', () => {
    it.each(SECRETS)('never carries %s in any field, message or error', (secret) => {
      for (const msg of [secret, `WebSocket client disconnected ${secret}`, `Satellite state: connected → ${secret}`, `Clubhouse v${secret} starting`]) {
        for (const level of ['info', 'warn', 'error'] as const) ring.note({ ns: 'core:annex-client', level, msg, meta: { error: secret, fingerprint: secret } });
      }
      ring.note({
        ns: 'core:chat', level: 'info', msg: 'Chat session ended',
        meta: { agentId: secret, reason: secret, exitCode: secret, driver: secret, prompt: secret, content: secret, projectName: secret },
      });
      ring.note({ ns: 'core:annex', level: 'info', msg: 'WebSocket client disconnected', meta: { authType: secret, code: secret } });
      const text = JSON.stringify(ring.collect());
      expect(text).not.toContain(secret);
    });

    it('takes no values from an object, an array or a prototype', () => {
      ring.note({ ns: 'core:chat', level: 'info', msg: 'Chat session ended', meta: { reason: { toString: () => 'sneaky' }, exitCode: [1] } as Record<string, unknown> });
      ring.note({ ns: 'core:chat', level: 'info', msg: 'Chat session ended', meta: JSON.parse('{"__proto__":{"reason":"sneaky"}}') });
      for (const line of ring.collect().lines) expect(line.attrs).toBeUndefined();
    });

    it('takes words only from a closed set, so a name in a state field goes no further', () => {
      for (const reason of ['project-goobers', 'mergers', 'a1b2c3d4e5f6', 'sk-abcdef', 'has space', 'x'.repeat(33)]) {
        ring.note({ ns: 'core:chat', level: 'info', msg: 'Cancelling chat start', meta: { reason } });
      }
      ring.note({ ns: 'core:chat', level: 'info', msg: 'Cancelling chat start', meta: { reason: 'superseded' } });
      expect(ring.collect().lines.map((l) => l.attrs?.reason)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 'superseded']);
    });

    it('holds out numbers outside a kind\'s range', () => {
      ring.note({ ns: 'core:annex', level: 'info', msg: 'WebSocket client disconnected', meta: { code: 99999 } });
      ring.note({ ns: 'core:annex-client', level: 'warn', msg: 'Identity request failed', meta: { status: 42 } });
      ring.note({ ns: 'core:annex-client', level: 'error', msg: 'WebSocket error', meta: { attempt: -1 } });
      for (const line of ring.collect().lines) expect(line.attrs).toBeUndefined();
    });

    it('stays safe through the real diag pipeline, with logging off', () => {
      _resetDiagForTests('/Users/somebody');
      const tapped = createDiagnosticsRing({ now: () => clock });
      const off = addDiagTap((r) => tapped.note(r), (_ns, level) => level !== 'debug');
      diag('core:chat', 'warn', `Chat start failed for ${SECRETS[5]}`, { agentId: 'agent-1', error: SECRETS[0], prompt: SECRETS[5] });
      diag('core:annex', 'info', 'Annex server stopped');
      off();
      const text = JSON.stringify(tapped.collect());
      expect(text).toContain('annex.server.stopped');
      expect(text).toContain(WITHHELD_EVENT);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
      _resetDiagForTests();
    });
  });

  describe('bounds', () => {
    it('forgets lines older than the time window', () => {
      ring.note({ ns: 'core:annex', level: 'info', msg: 'Annex server starting...' });
      clock += (FEEDBACK_DIAGNOSTICS.windowMinutes + 1) * 60_000;
      ring.note({ ns: 'core:annex', level: 'info', msg: 'Annex server stopped' });
      const d = ring.collect();
      expect(d.lines.map((l) => l.event)).toEqual(['annex.server.stopped']);
      expect(d.windowEnd).toBe(new Date(clock).toISOString());
    });

    it('keeps the newest lines within the line bound, and counts the rest', () => {
      for (let i = 0; i < 300; i++) {
        clock += 1;
        ring.note({ ns: 'core:annex-client', level: 'info', msg: `Scheduling reconnect in ${i}ms (attempt 1)` });
      }
      const d = ring.collect();
      expect(d.lines).toHaveLength(FEEDBACK_DIAGNOSTICS.maxLines);
      expect(d.dropped).toBe(100);
      expect(d.lines[d.lines.length - 1].attrs?.backoffMs).toBe(299);
      expect(d.lines[0].attrs?.backoffMs).toBe(100);
    });

    it('stays within the byte bound', () => {
      const small = createDiagnosticsRing({ now: () => clock, salt: Buffer.alloc(32, 1), maxBytes: 1000 });
      const line = { ns: 'core:chat', level: 'info' as const, msg: 'Starting chat agent', meta: { agentId: 'a', driver: 'claude_agent_sdk', provider: 'claude-code' } };
      for (let i = 0; i < 400; i++) small.note(line);
      const d = small.collect();
      expect(d.bytes).toBeLessThanOrEqual(1000);
      expect(d.lines.length).toBeGreaterThan(0);
      expect(d.dropped).toBe(400 - d.lines.length);
      expect(Buffer.byteLength(d.lines.map((l) => JSON.stringify(l)).join(''), 'utf-8')).toBe(d.bytes);
    });

    it('lets a burst of withheld warnings take only part of a report', () => {
      ring.note({ ns: 'core:annex', level: 'info', msg: 'Annex server stopped' });
      for (let i = 0; i < 1000; i++) ring.note({ ns: 'ui:perf', level: 'warn', msg: `slow ${i}` });
      const { lines } = ring.collect();
      expect(lines.filter((l) => l.event === WITHHELD_EVENT).length).toBeLessThanOrEqual(100);
      expect(lines.some((l) => l.event === 'annex.server.stopped')).toBe(true);
    });
  });
});

describe('DIAGNOSTICS_CATALOG', () => {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(full); }
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'feedback-diagnostics.ts') sources.push(fs.readFileSync(full, 'utf-8'));
    }
  };

  it('lists only messages Clubhouse still logs, so a reworded line can\'t go quiet', () => {
    walk(path.join(process.cwd(), 'src/main'));
    const all = sources.join('\n');
    const missing = Object.values(DIAGNOSTICS_CATALOG).flat().filter((e) => typeof e.msg === 'string' && !all.includes(e.msg) && !all.includes((e.msg as string).replace(/'/g, "\\'")));
    expect(missing.map((e) => e.msg)).toEqual([]);
  });

  it('has unique event names that fit the Framebriar token rule', () => {
    const events = Object.values(DIAGNOSTICS_CATALOG).flat().map((e) => e.event);
    expect(new Set(events).size).toBe(events.length);
    for (const event of events) expect(event).toMatch(/^[A-Za-z0-9_.:+-]{1,64}$/);
  });
});

describe('toDiagnosticsV1', () => {
  const window = { windowStart: '2026-11-01T11:30:00.000Z', windowEnd: '2026-11-01T12:00:00.000Z' };
  const available = (lines: FeedbackDiagnostics['lines'], dropped = 0): FeedbackDiagnostics => ({ status: 'available', ...window, lines, bytes: 1, dropped });
  const line = (attrs?: Record<string, string | number>) => ({ at: window.windowEnd, level: 'info' as const, ns: 'core:annex', event: 'annex.ws.disconnected', ...(attrs && { attrs }) });

  it('maps each outcome to a v1 state', () => {
    const none: FeedbackDiagnostics = { status: 'none', ...window, lines: [], bytes: 0, dropped: 0 };
    expect(toDiagnosticsV1(available([line()]), { status: 'queued', lines: 1 })).toMatchObject({ state: 'attached', lines: 1, delivery: { queued: true } });
    expect(toDiagnosticsV1(available([line()]), { status: 'left_out', reason: 'reporter' })).toMatchObject({ state: 'left_out', reason: 'reporter', lines: 0, entries: [] });
    expect(toDiagnosticsV1(none, { status: 'none', reason: 'no_lines' })).toMatchObject({ state: 'none', reason: 'no_lines' });
    expect(toDiagnosticsV1(none, { status: 'none', reason: 'collection_failed' })).toMatchObject({ state: 'unavailable', reason: 'collection_failed' });
  });

  it('keeps the closed attrs and counts the rest', () => {
    const v1 = toDiagnosticsV1(available([line({ closeCode: 1006, statusCode: 503, failure: 'overflow', attempt: 2, responseBytes: 10, tlsMs: 4, toState: 'disconnected', peerRef: 'abcd', driver: 'x', exitCode: 1 })]), { status: 'queued', lines: 1 });
    expect(v1.entries[0].attrs).toEqual({ closeCode: 1006, statusCode: 503, failure: 'overflow', attempt: 2, responseBytes: 10, tlsMs: 4, operation: 'disconnected' });
    expect(v1.droppedAttrs).toBe(3);
  });

  it.each([
    ['closeCode', 999], ['closeCode', 5000], ['statusCode', 99], ['statusCode', 600], ['failure', 'nope'], ['attempt', -1],
    ['connectionId', 'not-a-uuid'], ['traceId', 'abc'], ['spanId', 'abc'], ['operation', 'has space'],
  ])('drops an invalid %s (%s) and counts it', (key, value) => {
    const v1 = toDiagnosticsV1(available([line({ [key]: value })]), { status: 'queued', lines: 1 });
    expect(v1.entries[0].attrs).toBeUndefined();
    expect(v1.droppedAttrs).toBe(1);
  });

  it('sends ids in lower case, and bytes as the UTF-8 length of the entries', () => {
    const v1 = toDiagnosticsV1(available([line({ connectionId: 'ABCDEF01-2345-4678-89AB-CDEF01234567' })]), { status: 'queued', lines: 1 });
    expect(v1.entries[0].attrs?.connectionId).toBe('abcdef01-2345-4678-89ab-cdef01234567');
    expect(v1.bytes).toBe(Buffer.byteLength(JSON.stringify(v1.entries), 'utf-8'));
  });

  it('accepts every failure word in the frozen enum', () => {
    for (const failure of ['timeout', 'tls', 'dns', 'refused', 'closed', 'oversize', 'overflow', 'busy', 'storage', 'auth', 'protocol', 'cancelled', 'server', 'offline', 'unknown']) {
      expect(toDiagnosticsV1(available([line({ failure })]), { status: 'queued', lines: 1 }).droppedAttrs).toBe(0);
    }
  });

  it('trims the oldest entries past the caps and counts them', () => {
    const lines = Array.from({ length: DIAGNOSTICS_V1_LIMITS.entries + 5 }, (_, i) => line({ attempt: i }));
    const v1 = toDiagnosticsV1(available(lines, 2), { status: 'queued', lines: lines.length });
    expect(v1.entries.length).toBeLessThanOrEqual(DIAGNOSTICS_V1_LIMITS.entries);
    expect(v1.bytes).toBeLessThanOrEqual(DIAGNOSTICS_V1_LIMITS.bytes);
    expect(v1.dropped).toBe(2 + lines.length - v1.entries.length);
    expect(v1.entries[v1.entries.length - 1].attrs?.attempt).toBe(lines.length - 1);
  });

  it('fits what the ring produces at its own bounds, with nothing trimmed', () => {
    const ring = createDiagnosticsRing({ now: () => START, salt: Buffer.alloc(32, 1) });
    for (let i = 0; i < 400; i++) ring.note({ ns: 'core:chat', level: 'info', msg: 'Starting chat agent', meta: { agentId: 'a', driver: 'claude_agent_sdk', provider: 'claude-code' } });
    const d = ring.collect();
    expect(toDiagnosticsV1(d, { status: 'queued', lines: d.lines.length }).entries).toHaveLength(d.lines.length);
  });
});
