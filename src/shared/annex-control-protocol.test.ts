import { describe, expect, it } from 'vitest';
import { CONTROL_FEATURES, decodeControlBody, encodeControlBody, parseControlMessage } from './annex-control-protocol';

describe('Annex control protocol (#3613 P3)', () => {
  it('parses each message type exactly', () => {
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'hello', features: ['request'] }))).toEqual({ ok: true, message: { v: 1, type: 'hello', features: ['request'] } });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'request', id: 'a-1', method: 'POST', path: '/api/v1/network/agent-call', headers: { 'content-type': 'application/json' }, body: '{}', extra: 'dropped' })))
      .toEqual({ ok: true, message: { v: 1, type: 'request', id: 'a-1', method: 'POST', path: '/api/v1/network/agent-call', headers: { 'content-type': 'application/json' }, body: '{}' } });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'cancel', id: 'a-1' }))).toMatchObject({ ok: true });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'response', id: 'a-1', status: 200, headers: {}, body: '', encoding: 'utf8' }))).toMatchObject({ ok: true });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'error', id: 'a-1', code: 'busy' }))).toMatchObject({ ok: true });
  });

  it('offers request (P3), subscribe (P4), ws-control (P5) and bulk (P6)', () => {
    expect([...CONTROL_FEATURES]).toEqual(['request', 'subscribe', 'ws-control', 'bulk']);
  });

  it('parses a client frame exactly', () => {
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'client', id: 's1', frame: { type: 'pty:input', payload: { data: 'x' } } })))
      .toEqual({ ok: true, message: { v: 1, type: 'client', id: 's1', frame: { type: 'pty:input', payload: { data: 'x' } } } });
    for (const bad of [
      { v: 1, type: 'client', frame: { type: 'pty:input' } },
      { v: 1, type: 'client', id: 's1', frame: 'pty:input' },
      { v: 1, type: 'client', id: 's1', frame: { payload: {} } },
      { v: 1, type: 'client', id: 's1', frame: { type: 'x'.repeat(65) } },
    ]) expect(parseControlMessage(JSON.stringify(bad)).ok, JSON.stringify(bad)).toBe(false);
  });

  it('parses subscription frames exactly', () => {
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'subscribe', id: 's1' }))).toEqual({ ok: true, message: { v: 1, type: 'subscribe', id: 's1' } });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'unsubscribe', id: 's1' }))).toEqual({ ok: true, message: { v: 1, type: 'unsubscribe', id: 's1' } });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'event', id: 's1', frame: { type: 'snapshot', payload: {} } })))
      .toEqual({ ok: true, message: { v: 1, type: 'event', id: 's1', frame: { type: 'snapshot', payload: {} } } });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'ended', id: 's1', code: 'closed' }))).toMatchObject({ ok: true });
    for (const bad of [
      { v: 1, type: 'subscribe' },
      { v: 1, type: 'event', id: 's1', frame: 'text' },
      { v: 1, type: 'event', id: 's1', frame: { payload: {} } },
      { v: 1, type: 'event', id: 's1', frame: [] },
      { v: 1, type: 'ended', id: 's1', code: 'made_up' },
    ]) expect(parseControlMessage(JSON.stringify(bad)).ok, JSON.stringify(bad)).toBe(false);
  });

  it('refuses what is not exactly a control message', () => {
    const bad = [
      'not json', '[]', JSON.stringify({ v: 2, type: 'hello', features: [] }),
      JSON.stringify({ v: 1, type: 'subscribe' }),
      JSON.stringify({ v: 1, type: 'hello', features: 'request' }),
      JSON.stringify({ v: 1, type: 'request', id: 'has space', method: 'GET', path: '/' }),
      JSON.stringify({ v: 1, type: 'request', id: 'x'.repeat(129), method: 'GET', path: '/' }),
      JSON.stringify({ v: 1, type: 'response', id: 'a', status: 99, headers: {}, body: '', encoding: 'utf8' }),
      JSON.stringify({ v: 1, type: 'response', id: 'a', status: 200, headers: { a: 1 }, body: '', encoding: 'utf8' }),
      JSON.stringify({ v: 1, type: 'response', id: 'a', status: 200, headers: {}, body: '', encoding: 'hex' }),
      JSON.stringify({ v: 1, type: 'error', id: 'a', code: 'made_up' }),
      // transport_unavailable is local to the requester, never on the wire.
      JSON.stringify({ v: 1, type: 'error', id: 'a', code: 'transport_unavailable' }),
    ];
    for (const text of bad) expect(parseControlMessage(text).ok, text).toBe(false);
  });

  it('refuses a request it could answer with an error, keeping its id', () => {
    const cases: Array<Record<string, unknown>> = [
      { method: 'CONNECT', path: '/' },
      { method: 'GET', path: 'relative' },
      { method: 'GET', path: '//host/path' },
      { method: 'GET', path: 'https://elsewhere/api' },
      { method: 'GET', path: '/a b' },
      { method: 'GET', path: '/a#frag' },
      { method: 'GET', path: '/a\\b' },
      { method: 'GET', path: `/${'a'.repeat(5000)}` },
      { method: 'GET', path: '/', headers: { cookie: 'x' } },
      { method: 'GET', path: '/', headers: { host: 'x' } },
      { method: 'GET', path: '/', headers: { 'content-type': 'a\r\nx: y' } },
      { method: 'POST', path: '/', body: 3 },
      { method: 'POST', path: '/', body: '', encoding: 'hex' },
    ];
    for (const fields of cases) {
      expect(parseControlMessage(JSON.stringify({ v: 1, type: 'request', id: 'r1', ...fields })), JSON.stringify(fields)).toMatchObject({ ok: false, id: 'r1' });
    }
  });

  it('carries bodies byte for byte: text as text, anything else as base64', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('{"a":"é"}'), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from([0xc3]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]) {
      const wire = encodeControlBody(bytes);
      expect(decodeControlBody(wire.body, wire.encoding).equals(bytes)).toBe(true);
    }
    expect(encodeControlBody(Buffer.from('plain')).encoding).toBe('utf8');
    expect(encodeControlBody(Buffer.from([0xff])).encoding).toBe('base64');
  });
});


describe('P6 bulk message parser', () => {
  const base = { v: 1, type: 'bulk', transfer: '00000000-0000-4000-8000-000000000001', id: 'r' };
  it('accepts start, one credit, digest finish and cancellation', () => {
    for (const fields of [{ op: 'start', kind: 'request', size: 0, meta: { method: 'POST', path: '/x' } }, { op: 'credit' }, { op: 'finish', digest: 'a'.repeat(64) }, { op: 'cancel' }]) expect(parseControlMessage(JSON.stringify({ ...base, ...fields }))).toMatchObject({ ok: true });
  });
  it.each([
    { op: 'start', kind: 'request', size: -1, meta: {} },
    { op: 'start', kind: 'request', size: Number.MAX_SAFE_INTEGER + 1, meta: {} },
    { op: 'start', kind: 'request', size: 1.5, meta: {} },
    { op: 'start', kind: 'request', size: 0, meta: [] },
    { op: 'start', kind: 'tunnel', size: 0, meta: {} },
    { op: 'finish', digest: 'a'.repeat(63) },
    { op: 'credit', transfer: 'wrong' },
    { op: 'unknown' },
  ])('refuses invalid bulk shape %j', (fields) => {
    expect(parseControlMessage(JSON.stringify({ ...base, ...fields }))).toMatchObject({ ok: false });
  });
});
