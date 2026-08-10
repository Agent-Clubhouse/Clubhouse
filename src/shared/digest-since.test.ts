import { describe, it, expect } from 'vitest';
import {
  parseDigestSince,
  encodeDigestSince,
  decodeDigestSince,
  SINCE_CHANNELS_PARAM,
  MAX_SINCE_PARAM_LENGTH,
} from './digest-since';

const ISO = '2026-07-25T10:00:00.000Z';

describe('parseDigestSince', () => {
  it('accepts undefined and null', () => {
    expect(parseDigestSince(undefined, 'since')).toBeUndefined();
    expect(parseDigestSince(null, 'since')).toBeUndefined();
  });

  it('accepts a single ISO timestamp', () => {
    expect(parseDigestSince(ISO, 'since')).toBe(ISO);
  });

  it('accepts a per-channel map', () => {
    const map = { general: ISO, tasks: '2026-07-25T11:00:00.000Z' };
    expect(parseDigestSince(map, 'since')).toEqual(map);
  });

  it('accepts an empty map', () => {
    expect(parseDigestSince({}, 'since')).toEqual({});
  });

  it('rejects arrays and numbers', () => {
    expect(() => parseDigestSince([ISO], 'since')).toThrow('must be a string or an object');
    expect(() => parseDigestSince(42, 'since')).toThrow('must be a string or an object');
  });

  it('rejects non-string map values', () => {
    expect(() => parseDigestSince({ general: 42 }, 'since')).toThrow('since.general must be a string');
  });

  it('rejects prototype-polluting keys', () => {
    const payload = JSON.parse(`{"__proto__": {"polluted": true}, "general": "${ISO}"}`);
    expect(() => parseDigestSince(payload, 'since')).toThrow('may not contain the key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    expect(() => parseDigestSince({ constructor: ISO }, 'since')).toThrow('may not contain the key "constructor"');
    expect(() => parseDigestSince({ prototype: ISO }, 'since')).toThrow('may not contain the key "prototype"');
  });

  it('enforces the entry, key, and value bounds', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 501; i++) tooMany[`t${i}`] = ISO;
    expect(() => parseDigestSince(tooMany, 'since')).toThrow('at most 500 entries');

    expect(() => parseDigestSince({ ['x'.repeat(257)]: ISO }, 'since')).toThrow('at most 256 characters');
    expect(() => parseDigestSince({ general: 'x'.repeat(65) }, 'since')).toThrow('at most 64 characters');
    expect(() => parseDigestSince('x'.repeat(65), 'since')).toThrow('at most 64 characters');
  });

  it('names the offending value using the caller-supplied label', () => {
    expect(() => parseDigestSince(42, 'arg3')).toThrow(/^arg3 /);
    expect(() => parseDigestSince({ general: 42 }, SINCE_CHANNELS_PARAM))
      .toThrow(`${SINCE_CHANNELS_PARAM}.general must be a string`);
  });
});

describe('encodeDigestSince', () => {
  it('emits nothing for an absent or empty cutoff', () => {
    expect(encodeDigestSince(undefined)).toEqual({ params: {}, oversized: false });
    expect(encodeDigestSince({})).toEqual({ params: {}, oversized: false });
  });

  it('emits `since` for the single-timestamp form', () => {
    expect(encodeDigestSince(ISO)).toEqual({ params: { since: ISO }, oversized: false });
  });

  it('emits `sinceChannels` as JSON for the map form', () => {
    const map = { general: ISO };
    const { params, oversized } = encodeDigestSince(map);
    expect(oversized).toBe(false);
    expect(JSON.parse(params[SINCE_CHANNELS_PARAM])).toEqual(map);
    // Never overloads `since` — an older satellite must not read JSON as a date.
    expect(params.since).toBeUndefined();
  });

  it('reports oversized instead of emitting an unsendable URL', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 400; i++) huge[`channel-with-a-long-name-${i}`] = ISO;
    const { params, oversized } = encodeDigestSince(huge);
    expect(oversized).toBe(true);
    expect(params).toEqual({});
  });

  it('stays well under the cap for a realistically sized board', () => {
    const board: Record<string, string> = {};
    for (let i = 0; i < 30; i++) board[`inbox-some-agent-name-${i}`] = ISO;
    const { params, oversized } = encodeDigestSince(board);
    expect(oversized).toBe(false);
    expect(params[SINCE_CHANNELS_PARAM].length).toBeLessThan(MAX_SINCE_PARAM_LENGTH);
  });
});

describe('decodeDigestSince', () => {
  it('returns undefined when neither param is present', () => {
    expect(decodeDigestSince(null, null)).toBeUndefined();
  });

  it('honours a plain `since` — an older controller keeps working', () => {
    expect(decodeDigestSince(ISO, null)).toBe(ISO);
  });

  it('decodes `sinceChannels` into a map', () => {
    expect(decodeDigestSince(null, JSON.stringify({ general: ISO }))).toEqual({ general: ISO });
  });

  it('prefers `sinceChannels` when both are sent', () => {
    expect(decodeDigestSince(ISO, JSON.stringify({ general: ISO }))).toEqual({ general: ISO });
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeDigestSince(null, 'not json')).toThrow('must be valid JSON');
  });

  it('rejects a JSON string where an object is required', () => {
    expect(() => decodeDigestSince(null, '"2026-07-25T10:00:00.000Z"')).toThrow('must be an object');
  });

  it('rejects an oversized param before parsing it', () => {
    expect(() => decodeDigestSince(null, 'x'.repeat(MAX_SINCE_PARAM_LENGTH + 1)))
      .toThrow(`at most ${MAX_SINCE_PARAM_LENGTH} characters`);
  });

  it('applies the same bounds and prototype rejection as the local boundary', () => {
    expect(() => decodeDigestSince(null, '{"__proto__": {"polluted": true}}')).toThrow('may not contain the key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => decodeDigestSince(null, JSON.stringify({ general: 42 }))).toThrow('must be a string');
  });

  it('round-trips what encodeDigestSince produces', () => {
    const map = { general: ISO, 'inbox-warm-alpaca': '2026-07-25T11:30:00.000Z' };
    const { params } = encodeDigestSince(map);
    expect(decodeDigestSince(null, params[SINCE_CHANNELS_PARAM])).toEqual(map);

    const { params: strParams } = encodeDigestSince(ISO);
    expect(decodeDigestSince(strParams.since, null)).toBe(ISO);
  });
});
