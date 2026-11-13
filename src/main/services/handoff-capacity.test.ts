import { describe, expect, it, vi } from 'vitest';
import type { OnlineHandoffCapacity } from '../../shared/handoff-capacity';
import { CAPACITY_CACHE_MS, CAPACITY_RATE_LIMIT, HandoffCapacityService, sampleHandoffCapacity, type CapacitySamplingSources } from './handoff-capacity';

const self = Array(16).fill('aa').join(':');
const other = Array(16).fill('bb').join(':');
const GIB = 1024 ** 3;
const counts = { running: 2, sleeping: 3, idleDurable: 4 };
const providers = { 'claude-code': 'unknown', 'copilot-cli': 'available', 'codex-cli': 'limited' } as const;
const online = (machine = self): OnlineHandoffCapacity => ({
  machine, online: true, lastSeen: 100, sampledAt: 100, agents: counts, load: 'low', disk: 'ample', providers, accepting_handoffs: true,
});
const sources = (overrides: Partial<CapacitySamplingSources> = {}): CapacitySamplingSources => ({
  machine: self, agentCounts: async () => counts, projectVolumes: async () => ['/registered/project'],
  providers: () => providers, acceptingHandoffs: () => true, now: () => 100,
  cpuUsage: async () => 0.1, memory: () => ({ free: 8 * GIB, total: 16 * GIB }),
  disk: async () => ({ available: 30 * GIB, total: 100 * GIB }), ...overrides,
});

describe('read-only capacity bands', () => {
  it.each([
    [0.1, 0.5, 'low'], [0.65, 0.5, 'medium'], [0.9, 0.5, 'high'], [0.1, 0.75, 'medium'], [0.1, 0.9, 'high'],
  ] as const)('maps CPU %s / used memory %s to %s without exposing measurements', async (cpu, used, load) => {
    const result = await sampleHandoffCapacity(sources({ cpuUsage: async () => cpu, memory: () => ({ free: (1 - used) * 100, total: 100 }) }));
    expect(result.load).toBe(load);
    expect(Object.keys(result)).toEqual(['machine', 'online', 'sampledAt', 'lastSeen', 'agents', 'load', 'disk', 'providers', 'accepting_handoffs']);
    expect(JSON.stringify(result)).not.toContain('/registered/project');
  });

  it.each([
    [20 * GIB, 100 * GIB, 'ample'], [2 * GIB, 100 * GIB, 'low'],
    [2 * GIB, 20 * GIB, 'limited'], [20 * GIB - 1, 100 * GIB, 'limited'], [2 * GIB - 1, 20 * GIB, 'low'],
  ] as const)('maps available/total disk counters to %s / %s -> %s', async (available, total, disk) => {
    expect((await sampleHandoffCapacity(sources({ disk: async () => ({ available, total }) }))).disk).toBe(disk);
  });

  it('uses the worst registered project volume and deduplicates reads, without creating files', async () => {
    const disk = vi.fn(async (volume: string) => ({ available: volume === '/first' ? 30 * GIB : GIB, total: 100 * GIB }));
    const result = await sampleHandoffCapacity(sources({ projectVolumes: async () => ['/first', '/second', '/first'], disk }));
    expect(result.disk).toBe('low');
    expect(disk).toHaveBeenCalledTimes(2);
  });

  it('reports invalid counters or disk read failures explicitly with no OS path/value leakage', async () => {
    await expect(sampleHandoffCapacity(sources({ cpuUsage: async () => NaN }))).rejects.toThrow('Capacity probe is unavailable.');
    await expect(sampleHandoffCapacity(sources({ projectVolumes: async () => [] }))).rejects.toThrow('Capacity probe is unavailable.');
    await expect(sampleHandoffCapacity(sources({ disk: async () => { throw new Error('/private/user/secret'); } }))).rejects.toThrow('Capacity probe is unavailable.');
  });
});

describe('authorized, cached machine capacity', () => {
  function fixture() {
    let now = 100;
    let allowed = true;
    let connected = true;
    let present = true;
    const local = vi.fn(async () => online());
    const remote = vi.fn(async () => online(other));
    const service = new HandoffCapacityService({
      machine: self, authorize: async () => allowed, computers: () => present ? [{ machine: other, online: connected, lastSeen: 99 }] : [],
      sampleLocal: local, probeRemote: remote, now: () => now,
    });
    return {
      service, local, remote, time: (value: number) => { now = value; }, allow: (value: boolean) => { allowed = value; },
      connect: (value: boolean) => { connected = value; }, present: (value: boolean) => { present = value; },
    };
  }

  it('returns offline immediately without starting a local or remote probe, even after a cached online result', async () => {
    const state = fixture();
    await state.service.probe('caller', other);
    state.connect(false);
    expect(await state.service.probe('caller', other)).toEqual([{ machine: other, online: false, lastSeen: 99, accepting_handoffs: false }]);
    expect(state.remote).toHaveBeenCalledTimes(1);
    expect(state.local).not.toHaveBeenCalled();
  });

  it('samples both computers, shares bursts and refreshes exactly at the 30-second boundary', async () => {
    const state = fixture();
    const [first, second] = await Promise.all([state.service.probe('one'), state.service.probe('two')]);
    expect(first).toEqual([online(), online(other)]);
    expect(second).toEqual(first);
    expect(state.remote).toHaveBeenCalledTimes(1);
    state.time(100 + CAPACITY_CACHE_MS - 1);
    await state.service.probe('caller');
    expect(state.local).toHaveBeenCalledTimes(1);
    state.time(100 + CAPACITY_CACHE_MS);
    await state.service.probe('caller');
    expect(state.local).toHaveBeenCalledTimes(2);
    first[0].accepting_handoffs = false;
    expect((await state.service.probe('caller'))[0].accepting_handoffs).toBe(true);
  });

  it('rechecks device.read on every cached call and before releasing an in-flight answer', async () => {
    const state = fixture();
    state.allow(false);
    await expect(state.service.probe('caller')).rejects.toThrow('not authorized');
    expect(state.local).not.toHaveBeenCalled();
    state.allow(true);
    state.remote.mockImplementationOnce(async () => { state.allow(false); return online(other); });
    await expect(state.service.probe('caller', other)).rejects.toThrow('not authorized');
  });

  it('does not release cached or in-flight data for a computer removed or disconnected during the probe', async () => {
    const state = fixture();
    state.remote.mockImplementationOnce(async () => { state.connect(false); return online(other); });
    expect(await state.service.probe('caller', other)).toEqual([{ machine: other, online: false, lastSeen: 99, accepting_handoffs: false }]);
    state.present(false);
    await expect(state.service.probe('caller', other)).rejects.toThrow('unavailable');
  });

  it('rechecks earlier peers after a later peer disconnects them', async () => {
    const third = Array(16).fill('cc').join(':');
    let connected = true;
    const remote = vi.fn(async (machine: string) => { if (machine === third) connected = false; return online(machine); });
    const service = new HandoffCapacityService({
      machine: self, authorize: async () => true,
      computers: () => [{ machine: other, online: connected, lastSeen: 99 }, { machine: third, online: true, lastSeen: 98 }],
      sampleLocal: async () => online(),
      probeRemote: remote,
    });
    expect((await service.probe('caller')).find((record) => record.machine === other)).toEqual({
      machine: other, online: false, lastSeen: 99, accepting_handoffs: false,
    });
    connected = true;
    expect(await service.probe('caller', other)).toEqual([online(other)]);
    expect(remote).toHaveBeenCalledTimes(3);
  });

  it('does not return a removed member after the final asynchronous grant check', async () => {
    let present = true;
    let checks = 0;
    const service = new HandoffCapacityService({
      machine: self, authorize: async () => { if (++checks === 2) present = false; return true; },
      computers: () => present ? [{ machine: other, online: true, lastSeen: 99 }] : [],
      sampleLocal: async () => online(), probeRemote: async () => online(other),
    });
    await expect(service.probe('caller', other)).rejects.toThrow('unavailable');
  });

  it('returns a fresh offline record when a transport rejection coincides with disconnect', async () => {
    const state = fixture();
    state.remote.mockImplementationOnce(async () => { state.connect(false); throw new Error('private transport diagnostic'); });
    expect(await state.service.probe('caller', other)).toEqual([
      { machine: other, online: false, lastSeen: 99, accepting_handoffs: false },
    ]);
  });

  it('uses the final membership timestamps if the last grant check disconnects a peer', async () => {
    let connected = true;
    let checks = 0;
    const service = new HandoffCapacityService({
      machine: self, authorize: async () => { if (++checks === 2) connected = false; return true; },
      computers: () => [{ machine: other, online: connected, lastSeen: connected ? 99 : 101 }],
      sampleLocal: async () => online(), probeRemote: async () => online(other),
    });
    expect(await service.probe('caller', other)).toEqual([{ machine: other, online: false, lastSeen: 101, accepting_handoffs: false }]);
  });

  it('does not invent online bands if a disconnected failed probe reconnects during the final grant check', async () => {
    let connected = true;
    let checks = 0;
    const service = new HandoffCapacityService({
      machine: self, authorize: async () => { if (++checks === 2) connected = true; return true; },
      computers: () => [{ machine: other, online: connected, lastSeen: 99 }],
      sampleLocal: async () => online(),
      probeRemote: async () => { connected = false; throw new Error('private transport diagnostic'); },
    });
    await expect(service.probe('caller', other)).rejects.toThrow('Capacity computer is unavailable.');
  });

  it('rejects wrong-machine or detailed peer responses and sanitizes transport errors', async () => {
    const state = fixture();
    state.remote.mockResolvedValueOnce(online(self));
    await expect(state.service.probe('caller', other)).rejects.toThrow('Capacity probe is unavailable.');
    state.remote.mockRejectedValueOnce(new Error('private-host /private/project'));
    await expect(state.service.probe('caller', other)).rejects.toThrow('Capacity probe is unavailable.');
    state.remote.mockResolvedValueOnce({ ...online(other), hostname: 'private-host' } as OnlineHandoffCapacity);
    await expect(state.service.probe('caller', other)).rejects.toThrow('Capacity probe is unavailable.');
  });

  it('rate limits cache hits per caller and permits another caller, resetting exactly at the window boundary', async () => {
    const state = fixture();
    for (let count = 0; count < CAPACITY_RATE_LIMIT.calls; count++) await state.service.probe('caller', self);
    await expect(state.service.probe('caller', self)).rejects.toThrow('rate limit');
    expect(await state.service.probe('another', self)).toEqual([online()]);
    state.time(100 + CAPACITY_RATE_LIMIT.windowMs);
    expect(await state.service.probe('caller', self)).toEqual([online()]);
  });
});

describe('capacity sample deadlines', () => {
  it('expires a never-settling local sampler, releases coalesced callers and allows a fresh attempt', async () => {
    vi.useFakeTimers();
    try {
      const sample = vi.fn<() => Promise<OnlineHandoffCapacity>>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(online());
      const service = new HandoffCapacityService({
        machine: self, authorize: async () => true, computers: () => [], sampleLocal: sample, probeRemote: async () => online(other),
      });
      const first = expect(service.probe('first', self)).rejects.toThrow('Capacity probe is unavailable.');
      const coalesced = expect(service.probe('second', self)).rejects.toThrow('Capacity probe is unavailable.');
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([first, coalesced]);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(await service.probe('retry', self)).toEqual([online()]);
      expect(sample).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('prevents a late expired result from overwriting the cache or removing a newer in-flight sample', async () => {
    vi.useFakeTimers();
    try {
      let finishExpired!: (value: OnlineHandoffCapacity) => void;
      let finishFresh!: (value: OnlineHandoffCapacity) => void;
      const sample = vi.fn<() => Promise<OnlineHandoffCapacity>>()
        .mockImplementationOnce(() => new Promise((resolve) => { finishExpired = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { finishFresh = resolve; }));
      const service = new HandoffCapacityService({
        machine: self, authorize: async () => true, computers: () => [], sampleLocal: sample, probeRemote: async () => online(other),
      });
      const expired = expect(service.probe('expired', self)).rejects.toThrow('Capacity probe is unavailable.');
      await vi.advanceTimersByTimeAsync(5_000);
      await expired;
      const fresh = service.probe('fresh', self);
      await vi.advanceTimersByTimeAsync(0);
      finishExpired({ ...online(), load: 'high' });
      await vi.advanceTimersByTimeAsync(0);
      const coalesced = service.probe('coalesced', self);
      await vi.advanceTimersByTimeAsync(0);
      expect(sample).toHaveBeenCalledTimes(2);
      finishFresh(online());
      expect(await fresh).toEqual([online()]);
      expect(await coalesced).toEqual([online()]);
      expect(await service.probe('cached', self)).toEqual([online()]);
      expect(sample).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
