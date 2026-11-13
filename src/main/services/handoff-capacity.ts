import * as fs from 'fs';
import * as os from 'os';
import {
  parseHandoffCapacity, type CapacityAgentCounts, type CapacityProvider, type HandoffCapacity,
  type OnlineHandoffCapacity, type ProviderCapacity,
} from '../../shared/handoff-capacity';
import { isMachineFingerprint } from '../../shared/agent-address';

export const CAPACITY_CACHE_MS = 30_000;
/** Total elapsed time, independent of socket activity or OS reads making progress. */
export const CAPACITY_SAMPLE_TIMEOUT_MS = 5_000;

export async function withCapacityDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Capacity probe deadline exceeded.'));
    }, CAPACITY_SAMPLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
export const CAPACITY_RATE_LIMIT = { calls: 30, windowMs: 60_000 } as const;
const GIB = 1024 ** 3;

export interface CapacitySamplingSources {
  machine: string;
  agentCounts(): Promise<CapacityAgentCounts>;
  /** Registered projects only, resolved by main, not tool arguments. */
  projectVolumes(): Promise<string[]>;
  /** Existing cached quota signals only. Must not launch a CLI or login probe. */
  providers(): Record<CapacityProvider, ProviderCapacity>;
  acceptingHandoffs(): boolean;
  now?: () => number;
  cpuUsage?: () => Promise<number>;
  memory?: () => { free: number; total: number };
  disk?: (projectVolume: string) => Promise<{ available: number; total: number }>;
}

async function cpuUsage(): Promise<number> {
  const times = () => os.cpus().reduce((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }), { idle: 0, total: 0 });
  const before = times();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const after = times();
  if (after.total <= before.total || after.idle < before.idle) throw new Error('CPU capacity is unavailable.');
  return 1 - (after.idle - before.idle) / (after.total - before.total);
}

/** Read-only counters/statfs; no process list, benchmark, file writes or CLI. */
export async function sampleHandoffCapacity(sources: CapacitySamplingSources): Promise<OnlineHandoffCapacity> {
  try {
    const volumes = await sources.projectVolumes();
    if (volumes.length === 0 || volumes.length > 1000) throw new Error('No bounded project volumes.');
    const cpu = await (sources.cpuUsage ?? cpuUsage)();
    const memory = (sources.memory ?? (() => ({ free: os.freemem(), total: os.totalmem() })))();
    if (!Number.isFinite(cpu) || cpu < 0 || cpu > 1 || !Number.isFinite(memory.total) || memory.total <= 0
      || !Number.isFinite(memory.free) || memory.free < 0 || memory.free > memory.total) throw new Error('Invalid resource counters.');
    const memoryUsed = 1 - memory.free / memory.total;
    const load = cpu >= 0.9 || memoryUsed >= 0.9 ? 'high' : cpu >= 0.65 || memoryUsed >= 0.75 ? 'medium' : 'low';
    const disks: Array<'ample' | 'limited' | 'low'> = [];
    for (const volume of new Set(volumes)) {
      const disk = sources.disk ? await sources.disk(volume) : await fs.promises.statfs(volume).then((stat) => ({
        available: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize,
      }));
      if (!Number.isFinite(disk.available) || !Number.isFinite(disk.total) || disk.total <= 0
        || disk.available < 0 || disk.available > disk.total) throw new Error('Invalid disk counters.');
      const ratio = disk.available / disk.total;
      disks.push(disk.available < 2 * GIB || ratio < 0.03 ? 'low' : disk.available < 20 * GIB || ratio < 0.1 ? 'limited' : 'ample');
    }
    const now = (sources.now ?? Date.now)();
    const result = parseHandoffCapacity({
      machine: sources.machine, online: true, sampledAt: now, lastSeen: now, agents: await sources.agentCounts(),
      load, disk: disks.includes('low') ? 'low' : disks.includes('limited') ? 'limited' : 'ample',
      providers: sources.providers(), accepting_handoffs: sources.acceptingHandoffs(),
    });
    if (!result.online) throw new Error('Invalid local capacity state.');
    return result;
  } catch {
    // telemetry-exempt: fail explicitly, without reflecting OS paths or probe values
    throw new Error('Capacity probe is unavailable.');
  }
}

export interface CapacityComputer {
  machine: string;
  online: boolean;
  lastSeen: number | null;
}

export interface CapacityProbeOptions {
  machine: string;
  /** device.read on the caller's machine, rechecked before releasing a result. */
  authorize(callerId: string): Promise<boolean>;
  /** Paired Annex Network computers only, never phones or one-to-one satellites. */
  computers(): CapacityComputer[];
  sampleLocal(): Promise<OnlineHandoffCapacity>;
  probeRemote(machine: string, signal: AbortSignal): Promise<unknown>;
  now?: () => number;
}

/** Transport injection is pinned-member-only; this class registers no route/tool. */
export class HandoffCapacityService {
  private readonly cache = new Map<string, { at: number; value: OnlineHandoffCapacity }>();
  private readonly inflight = new Map<string, Promise<OnlineHandoffCapacity>>();
  private readonly rates = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: CapacityProbeOptions) {
    if (!isMachineFingerprint(options.machine) || options.machine !== options.machine.toLowerCase()) throw new Error('Invalid capacity machine.');
    this.now = options.now ?? Date.now;
  }

  private rate(callerId: string): void {
    const now = this.now();
    for (const [id, times] of this.rates) if (times.every((at) => now - at >= CAPACITY_RATE_LIMIT.windowMs || now < at)) this.rates.delete(id);
    const times = (this.rates.get(callerId) ?? []).filter((at) => now >= at && now - at < CAPACITY_RATE_LIMIT.windowMs);
    if (times.length >= CAPACITY_RATE_LIMIT.calls || !this.rates.has(callerId) && this.rates.size >= 1000) throw new Error('Capacity probe rate limit reached.');
    this.rates.set(callerId, [...times, now]);
  }

  private computer(machine: string): CapacityComputer | undefined {
    if (machine === this.options.machine) return { machine, online: true, lastSeen: this.now() };
    return this.options.computers().find((computer) => computer.machine === machine);
  }

  private async sample(machine: string): Promise<OnlineHandoffCapacity> {
    const now = this.now();
    for (const [key, entry] of this.cache) if (now < entry.at || now - entry.at >= CAPACITY_CACHE_MS || !this.computer(key)) this.cache.delete(key);
    const cached = this.cache.get(machine);
    if (cached && now >= cached.at && now - cached.at < CAPACITY_CACHE_MS) return structuredClone(cached.value);
    const pending = this.inflight.get(machine);
    if (pending) return pending;
    const work = async () => {
      const raw = await withCapacityDeadline((signal) => machine === this.options.machine
        ? this.options.sampleLocal() : this.options.probeRemote(machine, signal));
      // Only the winning, unexpired result reaches parsing/cache writes. A late
      // statfs or peer response cannot mutate the cache after its deadline.
      const parsed = parseHandoffCapacity(raw);
      if (!parsed.online || parsed.machine !== machine) throw new Error('Invalid capacity response.');
      if (!this.cache.has(machine) && this.cache.size >= 200) throw new Error('Capacity cache is full.');
      this.cache.set(machine, { at: this.now(), value: parsed });
      return parsed;
    };
    const result = work().catch(() => {
      // telemetry-exempt: surface failure, never transport diagnostics or peer content
      throw new Error('Capacity probe is unavailable.');
    }).finally(() => {
      if (this.inflight.get(machine) === result) this.inflight.delete(machine);
    });
    this.inflight.set(machine, result);
    return result;
  }

  async probe(callerId: string, machine?: string): Promise<HandoffCapacity[]> {
    if (!callerId || callerId.length > 256 || !await this.options.authorize(callerId)) throw new Error('Capacity probe is not authorized.');
    this.rate(callerId);
    const machines = machine === undefined
      ? [...new Set([this.options.machine, ...this.options.computers().map((computer) => computer.machine)])] : [machine];
    if (machines.length > 200) throw new Error('Too many computers for a capacity probe.');
    const results: HandoffCapacity[] = [];
    for (const target of machines) {
      if (!isMachineFingerprint(target) || target !== target.toLowerCase()) throw new Error('Invalid capacity machine.');
      const computer = this.computer(target);
      if (!computer) throw new Error('Capacity computer is unavailable.');
      if (!computer.online) {
        this.cache.delete(target);
        results.push(parseHandoffCapacity({ machine: target, online: false, lastSeen: computer.lastSeen, accepting_handoffs: false }));
        continue;
      }
      let value: OnlineHandoffCapacity | undefined;
      try {
        value = await this.sample(target);
      } catch (error) {
        // telemetry-exempt: only fresh offline membership explains a failed transport.
        const current = this.computer(target);
        if (!current || current.online) throw error;
      }
      const current = this.computer(target);
      if (!current) throw new Error('Capacity computer is unavailable.');
      if (!current.online) {
        this.cache.delete(target);
        results.push(parseHandoffCapacity({ machine: target, online: false, lastSeen: current.lastSeen, accepting_handoffs: false }));
      } else {
        if (!value) throw new Error('Capacity probe is unavailable.');
        results.push(value);
      }
    }
    if (!await this.options.authorize(callerId)) throw new Error('Capacity probe is not authorized.');
    const cohort = new Map(this.options.computers().map((computer) => [computer.machine, computer]));
    return structuredClone(results.map((value) => {
      if (value.machine === this.options.machine) return value;
      const current = cohort.get(value.machine);
      if (!current) {
        this.cache.delete(value.machine);
        throw new Error('Capacity computer is unavailable.');
      }
      if (!current.online) {
        this.cache.delete(value.machine);
        return parseHandoffCapacity({ machine: value.machine, online: false, lastSeen: current.lastSeen, accepting_handoffs: false });
      }
      if (!value.online) throw new Error('Capacity computer is unavailable.');
      return value;
    }));
  }
}
