import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ remotes: [] as { machineId: string; link: { state: string } }[], changed: () => {}, record: vi.fn(), stop: vi.fn() }));
vi.mock('./dispatcher-presence', () => ({ getDispatcherPresence: () => ({ remotes: state.remotes }), onDispatcherPresenceChanged: (listener: () => void) => { state.changed = listener; return state.stop; } }));
vi.mock('../telemetry/dispatcher-telemetry', () => ({ recordFederationLink: state.record }));
import { watchFederationTelemetry } from './dispatcher-federation-telemetry';
it('follows presence events once per transition, including removal, without polling', () => {
  state.remotes = [{ machineId: 'peer', link: { state: 'active' } }];
  const stop = watchFederationTelemetry();
  state.changed(); expect(state.record.mock.calls).toEqual([['peer', 'active']]);
  state.remotes[0].link.state = 'paused'; state.changed(); state.changed();
  state.remotes[0].link.state = 'active'; state.changed();
  state.remotes = []; state.changed();
  expect(state.record.mock.calls).toEqual([['peer', 'active'], ['peer', 'paused'], ['peer', 'active'], ['peer', 'removed']]);
  stop(); expect(state.stop).toHaveBeenCalledOnce();
});
