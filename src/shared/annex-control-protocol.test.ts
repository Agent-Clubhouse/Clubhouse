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

  it('offers only the request feature in this slice', () => {
    expect([...CONTROL_FEATURES]).toEqual(['request']);
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
