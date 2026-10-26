import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'os';
import { buildPairingUrl, normalizeCertFingerprint, pairingHosts } from './annex-pairing-url';

const CERT_HEX = 'ab'.repeat(32);
const CERT_COLONS = Array(32).fill('AB').join(':');
const ID = Array(16).fill('0F').join(':');

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null };
}

describe('normalizeCertFingerprint', () => {
  it('turns the colon-separated uppercase X509 form into 64 lowercase hex chars', () => {
    expect(normalizeCertFingerprint(CERT_COLONS)).toBe(CERT_HEX);
  });
  it('keeps an already normalized fingerprint', () => {
    expect(normalizeCertFingerprint(CERT_HEX)).toBe(CERT_HEX);
  });
  it.each(['', 'ab:cd', 'zz'.repeat(32), 'ab'.repeat(33)])('rejects %s', (value) => {
    expect(normalizeCertFingerprint(value)).toBeNull();
  });
});

describe('pairingHosts', () => {
  it('orders 192.168, 10, 172.16/12, then Tailscale, then other addresses', () => {
    const interfaces = {
      utun3: [v4('100.101.102.103')],
      en5: [v4('172.20.1.4')],
      en0: [v4('192.168.1.20')],
      en9: [v4('203.0.113.7')],
      en1: [v4('10.0.0.5')],
    };
    expect(pairingHosts(interfaces, '0.0.0.0')).toEqual([
      '192.168.1.20', '10.0.0.5', '172.20.1.4', '100.101.102.103', '203.0.113.7',
    ]);
  });

  it('skips loopback, internal, link-local, IPv6 and addresses outside the ranges edges', () => {
    const interfaces = {
      lo0: [v4('127.0.0.1', true), { ...v4('::1', true), family: 'IPv6' as const }],
      en0: [v4('169.254.10.2'), { ...v4('fe80::1'), family: 'IPv6' as const }, v4('192.168.1.20')],
      bridge: [v4('10.1.1.1', true)],
      odd: [v4('100.63.0.1'), v4('172.32.0.1')],
    };
    // 100.63/172.32 are outside CGNAT and 172.16/12, so they rank last, not with them.
    expect(pairingHosts(interfaces, '0.0.0.0')).toEqual(['192.168.1.20', '100.63.0.1', '172.32.0.1']);
  });

  it('keeps interface order within a range and drops duplicates', () => {
    const interfaces = { en0: [v4('192.168.1.20')], en1: [v4('192.168.50.3'), v4('192.168.1.20')] };
    expect(pairingHosts(interfaces, '0.0.0.0')).toEqual(['192.168.1.20', '192.168.50.3']);
  });

  it('accepts the numeric family older Node versions report', () => {
    const info = { ...v4('10.0.0.5'), family: 4 } as unknown as NetworkInterfaceInfo;
    expect(pairingHosts({ en0: [info] }, '0.0.0.0')).toEqual(['10.0.0.5']);
  });

  it('returns only the bound address when the server is bound to one', () => {
    expect(pairingHosts({ en0: [v4('192.168.1.20'), v4('10.0.0.5')] }, '10.0.0.5')).toEqual(['10.0.0.5']);
  });
});

describe('buildPairingUrl', () => {
  const parts = {
    hosts: ['192.168.1.20', '100.101.102.103'],
    port: 53123,
    fingerprint: ID,
    certFingerprint: CERT_COLONS,
    pin: '042917',
    name: "Mason's Mac+Studio",
  };

  it('encodes the v1 contract with repeated hosts and percent-encoded values', () => {
    const url = buildPairingUrl(parts)!;
    expect(url).toBe(
      'clubhousego://pair?v=1&host=192.168.1.20&host=100.101.102.103&port=53123'
      + `&id=${ID.replace(/:/g, '%3A')}&cert=${CERT_HEX}&pin=042917&name=Mason%27s%20Mac%2BStudio`,
    );
  });

  it('round-trips through URL parsing', () => {
    const parsed = new URL(buildPairingUrl(parts)!);
    expect(parsed.protocol).toBe('clubhousego:');
    expect(parsed.host).toBe('pair');
    expect(parsed.searchParams.getAll('host')).toEqual(parts.hosts);
    expect(parsed.searchParams.get('id')).toBe(ID);
    expect(parsed.searchParams.get('cert')).toBe(CERT_HEX);
    expect(parsed.searchParams.get('name')).toBe(parts.name);
  });

  it.each([
    ['no hosts', { hosts: [] }],
    ['no port', { port: 0 }],
    ['no identity', { fingerprint: '' }],
    ['a bad certificate fingerprint', { certFingerprint: 'nope' }],
    ['no PIN', { pin: '' }],
  ])('is null with %s', (_label, override) => {
    expect(buildPairingUrl({ ...parts, ...override })).toBeNull();
  });
});
