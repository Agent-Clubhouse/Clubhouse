import { describe, expect, it } from 'vitest';
import { annexNetworkProfile } from './annex-network-profile';
describe('isolated Annex network profile', () => {
  it('preserves production binding and discovery by default', () => {
    expect(annexNetworkProfile({})).toEqual({ host: '0.0.0.0', advertise: true });
  });
  it('binds only IPv4 loopback and never advertises when explicitly enabled', () => {
    expect(annexNetworkProfile({ CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1' })).toEqual({ host: '127.0.0.1', advertise: false });
  });
});
