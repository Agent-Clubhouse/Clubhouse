import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import vectors from './fixtures/annex-member-names-v1.json';
import {
  normalizeLocalMemberName, isMemberName, readMemberNamePayload, encodeMemberNamePayload,
  compareMemberNameOrder, sameMemberNameEpoch, nextMemberNameStamp, remoteMemberNameStampAllowed,
} from './annex-member-names';

const FP = Array(16).fill('aa').join(':');
const BY = Array(16).fill('bb').join(':');
const payload = () => ({ fingerprint: FP, joinedAt: 1760000000000, pairingId: 'pairing-123', name: 'Studio', at: 1770000000000, by: BY });
const epoch = () => ({ fingerprint: FP, joinedAt: 1760000000000, pairingId: 'pairing-123' });
const order = () => ({ at: 1770000000000, by: BY, id: 'a'.repeat(64) });

describe('member-name primitives (unwired)', () => {
  describe('fixed local trim and receiver validity', () => {
    it.each(vectors.stringCases)('$id', test => {
      expect(normalizeLocalMemberName(test.input)).toBe('writerResult' in test ? test.writerResult : null);
      expect(isMemberName(test.input)).toBe(test.modernReceiverAcceptsInput);
    });
    const trimPoints = [9, 10, 11, 12, 13, 32, 0xa0, 0x1680,
      ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
    it.each(trimPoints)('trims only edge U+%i and preserves interior code point', point => {
      const char = String.fromCodePoint(point);
      expect(normalizeLocalMemberName(char + 'A' + char + 'B' + char)).toBe('A' + char + 'B');
      expect(isMemberName(char + 'AB')).toBe(false);
      expect(isMemberName('A' + char + 'B')).toBe(true);
    });
    it.each([0, 0x85, 0x180e, 0x200b, 0x2060])('preserves non-trim U+%i', point => {
      const name = String.fromCodePoint(point) + 'A' + String.fromCodePoint(point);
      expect(normalizeLocalMemberName(name)).toBe(name); expect(isMemberName(name)).toBe(true);
    });
    it.each([null, undefined, 1, {}, [], true])('refuses non-string %#', raw => {
      expect(normalizeLocalMemberName(raw)).toBeNull(); expect(isMemberName(raw)).toBe(false);
    });
    it('validates original UTF-16 and refuses truncation/replacement/normalization', () => {
      for (const name of ['\ud800', '\udc00', ' \ud800 ', 'a'.repeat(199) + '🚀', '🚀'.repeat(101)]) {
        expect(normalizeLocalMemberName(name)).toBeNull(); expect(isMemberName(name)).toBe(false);
      }
      expect(normalizeLocalMemberName(' ' + '🚀'.repeat(100) + ' ')).toBe('🚀'.repeat(100));
      expect(normalizeLocalMemberName(' e\u0301 ')).toBe('e\u0301');
      expect(normalizeLocalMemberName(' É ')).toBe('É');
      expect(isMemberName('')).toBe(false);
    });
  });

  describe('explicit canonical UTF-8 payload bytes', () => {
    it.each(vectors.hashVectors)('matches fixed vector %#', vector => {
      const { id: _id, ...raw } = vector.record;
      const parsed = readMemberNamePayload(raw);
      expect(parsed).toEqual(raw);
      const bytes = encodeMemberNamePayload(raw);
      expect(Buffer.from(bytes).toString('hex')).toBe(vector.canonicalBytesHex);
      // The expected digest/bytes predate this implementation; node:crypto is test-only.
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.sha256);
    });
    it('captures detached scalars, with absent pairing ID remaining absent', () => {
      const raw = payload(); const parsed = readMemberNamePayload(raw)!;
      expect(parsed).not.toBe(raw); raw.name = 'changed'; expect(parsed.name).toBe('Studio');
      const absent: Record<string, unknown> = payload(); delete absent.pairingId;
      expect(readMemberNamePayload(absent)).not.toHaveProperty('pairingId');
      expect(readMemberNamePayload({ ...absent, pairingId: undefined })).toBeNull();
    });
    it('accepts null-prototype and frozen enumerable data', () => {
      const raw = payload(); Object.setPrototypeOf(raw, null); Object.freeze(raw);
      expect(readMemberNamePayload(raw)).toEqual(payload());
    });
    it.each(['fingerprint', 'joinedAt', 'name', 'at', 'by'])('refuses absent %s', key => {
      const raw: Record<string, unknown> = payload(); delete raw[key];
      expect(readMemberNamePayload(raw)).toBeNull();
      expect(() => encodeMemberNamePayload(raw as ReturnType<typeof payload>)).toThrow('Invalid member name payload');
    });
    it('refuses extra keys, including id (payload bytes intentionally exclude it)', () => {
      expect(readMemberNamePayload({ ...payload(), id: 'a'.repeat(64) })).toBeNull();
      expect(readMemberNamePayload({ ...payload(), extra: true })).toBeNull();
    });
    it.each(['fingerprint', 'by'])('requires normalized fingerprint in %s', key => {
      for (const invalid of [FP.toUpperCase(), FP + '\n', 'aa:bb', Array(15).fill('aa').join(':'), Array(33).fill('aa').join(':'), null]) {
        expect(readMemberNamePayload({ ...payload(), [key]: invalid })).toBeNull();
      }
      expect(readMemberNamePayload({ ...payload(), [key]: Array(32).fill('ff').join(':') })).not.toBeNull();
    });
    it.each(['short', 'with space', 'a'.repeat(65), 'pairing-123\n', null, 1])('refuses invalid pairing ID %#', pairingId => {
      expect(readMemberNamePayload({ ...payload(), pairingId })).toBeNull();
    });
    it.each([-8640000000000000, 0, 8640000000000000])('accepts supported Date integer %s', joinedAt => {
      expect(readMemberNamePayload({ ...payload(), joinedAt })).not.toBeNull();
    });
    it.each([-8640000000000001, 8640000000000001, 1.5, NaN, Infinity, '0'])('refuses invalid joinedAt %#', joinedAt => {
      expect(readMemberNamePayload({ ...payload(), joinedAt })).toBeNull();
    });
    it.each([0, -1, 253402300800000, 1.5, NaN, Infinity, '1'])('refuses invalid operation stamp %#', at => {
      expect(readMemberNamePayload({ ...payload(), at })).toBeNull();
    });
    it('accepts minimum/maximum operation stamps without locale/exponent encoding', () => {
      for (const at of [1, 253402300799999]) {
        const raw = { ...payload(), joinedAt: -8640000000000000, at };
        const bytes = Buffer.from(encodeMemberNamePayload(raw)).toString('utf8');
        expect(bytes).toContain('17:-8640000000000000'); expect(bytes).toContain(String(at));
        expect(bytes).not.toContain('e+');
      }
    });
    it.each([' Studio', 'Studio ', '', '\ud800', 'a'.repeat(201)])('never silently normalizes a receiver name %#', name => {
      expect(readMemberNamePayload({ ...payload(), name })).toBeNull();
    });
    it.each(['hidden', 'symbol', 'accessor', 'prototype', 'array'])('refuses non-data shape %s without raw getter reads', flavor => {
      const raw = payload(); const getter = vi.fn(() => 'Studio');
      if (flavor === 'hidden') Object.defineProperty(raw, 'extra', { value: 1 });
      if (flavor === 'symbol') Object.defineProperty(raw, Symbol('extra'), { value: 1 });
      if (flavor === 'accessor') Object.defineProperty(raw, 'name', { get: getter, enumerable: true });
      if (flavor === 'prototype') Object.setPrototypeOf(raw, { inherited: 1 });
      expect(readMemberNamePayload(flavor === 'array' ? [] : raw)).toBeNull();
      expect(getter).not.toHaveBeenCalled();
    });
    it('fails closed on hostile or revoked reflection without treating it as authority', () => {
      expect(readMemberNamePayload(new Proxy({}, { ownKeys() { throw new Error('private'); } }))).toBeNull();
      const revoked = Proxy.revocable({}, {}); revoked.revoke(); expect(readMemberNamePayload(revoked.proxy)).toBeNull();
    });
  });

  describe('epoch and order are values, not authorization', () => {
    it('requires fingerprint, joinedAt and pairing-presence/value to all match', () => {
      expect(sameMemberNameEpoch(epoch(), { ...epoch(), unrelated: 'ignored' })).toBe(true);
      for (const changed of [{ fingerprint: BY }, { joinedAt: epoch().joinedAt + 1 }, { pairingId: 'pairing-456' }]) {
        expect(sameMemberNameEpoch(epoch(), { ...epoch(), ...changed })).toBe(false);
      }
      const legacy = { fingerprint: FP, joinedAt: epoch().joinedAt };
      expect(sameMemberNameEpoch(legacy, { ...legacy })).toBe(true);
      expect(sameMemberNameEpoch(legacy, epoch())).toBe(false);
      expect(sameMemberNameEpoch(epoch(), legacy)).toBe(false);
      expect(sameMemberNameEpoch(legacy, { ...legacy, joinedAt: legacy.joinedAt + 1 })).toBe(false);
      expect(sameMemberNameEpoch({ ...epoch(), pairingId: undefined }, epoch())).toBe(false);
    });
    it('compares numeric stamp then ordinal writer then ordinal content ID', () => {
      const a = order();
      expect(compareMemberNameOrder(a, { ...a })).toBe(0);
      for (const newer of [{ ...a, at: a.at + 1 }, { ...a, by: Array(16).fill('cc').join(':') }, { ...a, id: 'b'.repeat(64) }]) {
        expect(compareMemberNameOrder(a, newer)).toBe(-1);
        expect(compareMemberNameOrder(newer, a)).toBe(1);
      }
      expect(compareMemberNameOrder({ ...a, at: 9, by: BY }, { ...a, at: 10, by: FP })).toBe(-1);
      const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale ordering forbidden'); });
      try { expect(compareMemberNameOrder(a, { ...a, by: FP })).toBe(1); } finally { locale.mockRestore(); }
    });
    it('keeps A→B→C→A and same-name stamp progress; the name is not an order key', () => {
      const base = { ...order(), name: 'A' };
      let previous = base;
      for (const name of ['B', 'C', 'A', 'A']) {
        const newer = { ...previous, name, at: previous.at + 1 };
        expect(compareMemberNameOrder(previous, newer)).toBe(-1);
        previous = newer;
      }
      expect(compareMemberNameOrder({ ...base, name: 'A' }, { ...base, name: 'Z' })).toBe(0);
    });
    it('rejects invalid ordering inputs and malformed epoch scalars without getter reads', () => {
      for (const invalid of [{ ...order(), id: 'A'.repeat(64) }, { ...order(), id: 'a'.repeat(64) + '\n' }, { ...order(), at: 0 }, { ...order(), by: 'writer' }]) {
        expect(() => compareMemberNameOrder(order(), invalid)).toThrow('Invalid member name order');
      }
      expect(sameMemberNameEpoch(epoch(), { ...epoch(), joinedAt: NaN })).toBe(false);
      const getter = vi.fn(() => epoch().joinedAt); const raw = epoch();
      Object.defineProperty(raw, 'joinedAt', { get: getter });
      expect(sameMemberNameEpoch(epoch(), raw)).toBe(false); expect(getter).not.toHaveBeenCalled();
    });
  });

  describe('explicit logical time and future-skew decisions', () => {
    it('advances under frozen/backwards clocks without reading wall time', () => {
      const wall = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('implicit time forbidden'); });
      try {
        expect(nextMemberNameStamp(100, 0)).toBe(100);
        expect(nextMemberNameStamp(100, 100)).toBe(101);
        expect(nextMemberNameStamp(1, 101)).toBe(102);
        expect(nextMemberNameStamp(-1, 0)).toBe(1);
      } finally { wall.mockRestore(); }
    });
    it.each([[0, -1], [0, NaN], [NaN, 0], [Infinity, 0], [1.5, 0], [253402300800000, 0], [1, 253402300799999], [1, 1.5]])('refuses invalid/overflow local clock %s %s', (now, maximum) => {
      expect(() => nextMemberNameStamp(now, maximum)).toThrow('Member name clock out of range');
    });
    it('accepts exactly24h and exposes the ratchet/slow-peer limit without clamping', () => {
      const now = 1770000000000, incoming = now + 86400000;
      expect(remoteMemberNameStampAllowed(incoming, now)).toBe(true);
      expect(remoteMemberNameStampAllowed(incoming + 1, now)).toBe(false);
      const next = nextMemberNameStamp(now, incoming);
      expect(next).toBe(incoming + 1);
      expect(remoteMemberNameStampAllowed(next, now - 3600000)).toBe(false);
      expect(remoteMemberNameStampAllowed(now, now - 3600000)).toBe(true);
      expect(remoteMemberNameStampAllowed(incoming, now - 1)).toBe(false);
    });
    it('does not invalidate old accepted history or turn a skipped value into a clock update', () => {
      expect(remoteMemberNameStampAllowed(1, 1770000000000)).toBe(true);
      expect(nextMemberNameStamp(100, 200)).toBe(201);
      // This pure decision does not mutate a durable floor or invalidate stored records.
      expect(remoteMemberNameStampAllowed(1000000000, 1)).toBe(false);
      expect(nextMemberNameStamp(100, 200)).toBe(201);
    });
    it.each([[0, 0], [NaN, 1], [1, NaN], [1, Infinity], [1, -8640000000000001]])('refuses invalid skew inputs %#', (at, now) => {
      expect(remoteMemberNameStampAllowed(at, now)).toBe(false);
    });
  });
});
