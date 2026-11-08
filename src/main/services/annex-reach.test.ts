import { describe, it, expect } from 'vitest';
import { formatAddress, KNOWN_HOSTS_MAX, parseTypedHost, rankAddresses, reachCandidates, rememberHost, withReachableAs } from './annex-reach';

describe('annex reach (#3058)', () => {
  describe('a typed host', () => {
    it.each([
      ['studio', { host: 'studio' }],
      ['Studio.local', { host: 'studio.local' }],
      ['studio.tail1234.ts.net', { host: 'studio.tail1234.ts.net' }],
      ['studio.tail1234.ts.net.', { host: 'studio.tail1234.ts.net.' }],
      ['studio.tail1234.ts.net:9443', { host: 'studio.tail1234.ts.net', port: 9443 }],
      ['192.168.1.20', { host: '192.168.1.20' }],
      ['100.101.102.103:7000', { host: '100.101.102.103', port: 7000 }],
      ['fd7a:115c:a1e0::1', { host: 'fd7a:115c:a1e0::1' }],
      ['[fd7a:115c:a1e0::1]', { host: 'fd7a:115c:a1e0::1' }],
      ['[2001:db8::5]:9443', { host: '2001:db8::5', port: 9443 }],
      ['  studio.local  ', { host: 'studio.local' }],
    ])('reads %j', (input, expected) => {
      expect(parseTypedHost(input)).toEqual(expected);
    });

    it.each([
      '', ' ', 'https://studio.local', 'studio.local/path', 'user@studio', 'stu dio', 'studio:', 'studio:abc',
      'studio:0', 'studio:70000', '-studio', 'studio-', 'stu_dio', '[studio.local]', '[2001:db8::5]:x', 'a'.repeat(64),
    ])('refuses %j', (input) => {
      expect(parseTypedHost(input)).toBeNull();
    });
  });

  it('formats an address as a person would type it', () => {
    expect(formatAddress({ host: '10.0.0.2', port: 9443 })).toBe('10.0.0.2:9443');
    expect(formatAddress({ host: '2001:db8::5', port: 9443 })).toBe('[2001:db8::5]:9443');
  });

  it('ranks announced addresses: private IPv4, tailnet, other IPv4, unique-local IPv6, global IPv6; never loopback or link-local', () => {
    expect(rankAddresses([
      'fe80::1', '2001:db8::5', 'fd00::7', '8.8.4.4', '100.64.0.3', '127.0.0.1', '::1', '169.254.1.1', '192.168.1.9', '192.168.1.9',
    ])).toEqual(['192.168.1.9', '100.64.0.3', '8.8.4.4', 'fd00::7', '2001:db8::5']);
    expect(rankAddresses(['fe80::1%en0', 'not-an-ip'])).toEqual([]);
  });

  it('orders candidates: announced now, then typed, then known; no repeats; no port, no candidate', () => {
    expect(reachCandidates({
      discovered: { host: '192.168.1.9', port: 9443 },
      typed: 'Studio.tail1234.ts.net',
      known: ['10.0.0.4', '192.168.1.9', 'studio.tail1234.ts.net'],
      port: 9443,
    })).toEqual([
      { host: '192.168.1.9', port: 9443 },
      { host: 'studio.tail1234.ts.net', port: 9443 },
      { host: '10.0.0.4', port: 9443 },
    ]);
    // A typed port wins over the remembered one for that host only.
    expect(reachCandidates({ typed: 'studio:7000', known: ['10.0.0.4'], port: 9443 })).toEqual([
      { host: 'studio', port: 7000 }, { host: '10.0.0.4', port: 9443 },
    ]);
    expect(reachCandidates({ known: ['10.0.0.4'] })).toEqual([]);
    expect(reachCandidates({ typed: 'not a host', port: 9443 })).toEqual([]);
  });

  it("adds this machine's reachable-as name last to what it gives out, unless the server is bound to one address", () => {
    expect(withReachableAs(['192.168.1.9'], '0.0.0.0', ' Studio.tail1234.ts.net ')).toEqual(['192.168.1.9', 'studio.tail1234.ts.net']);
    expect(withReachableAs(['192.168.1.9'], '', 'studio.tail1234.ts.net:9443')).toEqual(['192.168.1.9', 'studio.tail1234.ts.net']);
    expect(withReachableAs(['192.168.1.9'], '0.0.0.0', '192.168.1.9')).toEqual(['192.168.1.9']);
    expect(withReachableAs(['192.168.1.9'], '0.0.0.0', 'not a host')).toEqual(['192.168.1.9']);
    expect(withReachableAs(['127.0.0.1'], '127.0.0.1', 'studio')).toEqual(['127.0.0.1']);
  });

  it('remembers the newest host first, keeps a few, and ignores case', () => {
    expect(rememberHost(['a', 'B', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(rememberHost(undefined, 'x')).toEqual(['x']);
    const many = Array.from({ length: 10 }, (_, i) => `h${i}`);
    expect(rememberHost(many, 'new')).toHaveLength(KNOWN_HOSTS_MAX);
  });
});
