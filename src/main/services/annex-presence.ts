import type { AnnexDevice } from '../../shared/types';
import type { AppEventInput, DevicePresence } from './app-event-bus';

export const DEVICE_STARTUP_SETTLE_MS = 2_000;
// Allow an Annex reconnect round and the server's two heartbeat intervals.
export const DEVICE_RECOVERY_SETTLE_MS = 65_000;

/** This computer's observations only. Away periods keep the last trustworthy baseline. */
export class AnnexPresence {
  private baseline = new Map<string, DevicePresence>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private blockers = new Set<string>();
  private settling = true;
  private stopped = true;

  constructor(private readonly deps: {
    devices(): AnnexDevice[];
    publish(event: AppEventInput): void;
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.settle(DEVICE_STARTUP_SETTLE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  setAway(reason: 'suspend' | 'lock' | 'network', away: boolean): void {
    if (this.stopped) return;
    if (away) {
      this.blockers.add(reason);
      this.settling = true;
      this.clearTimer();
    } else if (this.blockers.delete(reason) && !this.blockers.size) {
      this.settle(DEVICE_RECOVERY_SETTLE_MS);
    }
  }

  /** A changed local interface needs the same recovery as a network loss. */
  networkChanged(): void {
    if (!this.stopped && !this.blockers.size) this.settle(DEVICE_RECOVERY_SETTLE_MS);
  }

  changed(): void {
    if (this.stopped || this.settling || this.blockers.size) return;
    const next = new Map<string, DevicePresence>();
    for (const device of this.deps.devices()) {
      if (device.role !== 'member' || device.state !== 'connected') continue;
      const id = device.fingerprint.toLowerCase();
      next.set(id, { id, name: device.alias || 'Unnamed device', kind: device.kind === 'phone' ? 'phone' : 'computer' });
    }
    const previous = this.baseline;
    // Remember first: subscribers may synchronously change connections.
    this.baseline = next;
    for (const [id, device] of next) {
      if (!previous.has(id)) this.deps.publish({ type: 'device.online', device });
    }
    for (const [id, device] of previous) {
      if (!next.has(id)) this.deps.publish({ type: 'device.offline', device });
    }
  }

  /** Undefined while this computer cannot make a trustworthy observation. */
  online(id: string): boolean | undefined {
    if (this.stopped || this.settling || this.blockers.size) return undefined;
    return this.baseline.has(id.toLowerCase());
  }

  private settle(ms: number): void {
    this.settling = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settling = false;
      this.changed();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
