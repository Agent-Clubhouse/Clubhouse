import { describe, expect, it, vi } from 'vitest';
vi.mock('node:os', () => ({ networkInterfaces: () => ({ en0: [{ address: '192.168.10.9', internal: false }] }) }));
import { annexNetworkProfile } from './annex-network-profile';
describe('isolated Annex network profile', () => {
  it('preserves production binding and discovery by default', () => {
    expect(annexNetworkProfile({})).toEqual({ host: '0.0.0.0', advertise: true });
  });
  it('binds only IPv4 loopback and never advertises when explicitly enabled', () => {
    expect(annexNetworkProfile({ CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1' })).toEqual({ host: '127.0.0.1', advertise: false });
  });
});

it('allows only an explicit local interface in an isolated memory-only profile without discovery', () => {
  expect(annexNetworkProfile({ CLUBHOUSE_ANNEX_BIND_ADDRESS: '192.168.10.9', CLUBHOUSE_ANNEX_EPHEMERAL: '1', CLUBHOUSE_USER_DATA: '/tmp/fixture' }))
    .toEqual({ host: '192.168.10.9', advertise: false });
});
it.each(['0.0.0.0', '127.0.0.1', 'example.test', '192.168.10.8', '::'])('rejects unsafe/unavailable explicit interface %s', (address) => {
  expect(() => annexNetworkProfile({ CLUBHOUSE_ANNEX_BIND_ADDRESS: address })).toThrow();
});
it('refuses conflicting bind settings and memory-only mode without isolation', () => {
  expect(() => annexNetworkProfile({ CLUBHOUSE_ANNEX_BIND_ADDRESS: '192.168.10.9', CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1' })).toThrow();
  expect(() => annexNetworkProfile({ CLUBHOUSE_ANNEX_BIND_ADDRESS: '192.168.10.9', CLUBHOUSE_ANNEX_EPHEMERAL: '1' })).toThrow();
});
