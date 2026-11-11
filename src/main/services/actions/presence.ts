import { DEFAULT_ABSENCE_MINUTES } from '../../../shared/actions';
import type { EngineClock } from './engine';

export type PresenceSignal = 'focus' | 'blur' | 'lock' | 'unlock' | 'suspend' | 'resume';

export interface PresenceSignals {
  focused(): boolean;
  /** Null when the OS cannot report idle time. Lock and suspend still work. */
  idleSeconds(): number | null;
  listen(listener: (signal: PresenceSignal) => void): () => void;
}

interface ReturnWatch {
  id: string;
  absenceMinutes?: number;
}

/** Local, opt-in presence. A launch is a new observation session, not a return. */
export class ActionPresence {
  private watches: ReturnWatch[] = [];
  private unlisten: (() => void) | null = null;
  private timer: unknown = null;
  private locked = false;
  private suspended = false;
  private blockedSince: number | null = null;
  private awaySince: number | null = null;
  private recordedUseAt: number | null = null;
  private qualified = new Set<string>();

  constructor(private readonly deps: {
    /** Sleep-inclusive OS uptime, not wall-clock time. */
    clock: EngineClock;
    signals: PresenceSignals;
    used(): void;
    returned(actionIds: string[]): void;
  }) {}

  configure(watches: ReturnWatch[]): void {
    const previous = new Map(this.watches.map((w) => [w.id, w.absenceMinutes ?? DEFAULT_ABSENCE_MINUTES]));
    for (const id of this.qualified) {
      const next = watches.find((w) => w.id === id);
      if (!next || previous.get(id) !== (next.absenceMinutes ?? DEFAULT_ABSENCE_MINUTES)) this.qualified.delete(id);
    }
    this.watches = watches;
    if (!watches.length) { this.stop(); return; }
    if (this.unlisten) return;
    this.locked = false;
    this.suspended = false;
    this.blockedSince = null;
    this.qualified.clear();
    this.awaySince = this.deps.signals.focused() ? null : this.deps.clock.now();
    this.unlisten = this.deps.signals.listen((signal) => this.signal(signal));
    this.sample();
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
    this.awaySince = null;
    this.blockedSince = null;
    this.qualified.clear();
  }

  private collect(now: number, idle: number | null): number {
    let nextSample = 60_000;
    if (this.awaySince === null) return nextSample;
    for (const w of this.watches) {
      if (this.qualified.has(w.id)) continue;
      const threshold = (w.absenceMinutes ?? DEFAULT_ABSENCE_MINUTES) * 60_000;
      const blockedRemaining = this.blockedSince === null ? Infinity : threshold - (now - this.blockedSince);
      const idleRemaining = idle === null ? Infinity : threshold - idle * 1000;
      const remaining = Math.max(threshold - (now - this.awaySince), Math.min(blockedRemaining, idleRemaining));
      if (remaining <= 0) this.qualified.add(w.id);
      else nextSample = Math.min(nextSample, remaining);
    }
    return nextSample;
  }

  private signal(signal: PresenceSignal): void {
    const now = this.deps.clock.now();
    this.collect(now, this.deps.signals.idleSeconds());
    const wasBlocked = this.locked || this.suspended;
    if (signal === 'lock') this.locked = true;
    if (signal === 'unlock') this.locked = false;
    if (signal === 'suspend') this.suspended = true;
    if (signal === 'resume') this.suspended = false;
    if (!wasBlocked && (this.locked || this.suspended)) this.blockedSince = now;
    if (!this.locked && !this.suspended) this.blockedSince = null;
    if (signal === 'blur') {
      // Another Clubhouse window may receive focus in the same event-loop turn.
      this.arm(0);
      return;
    }
    this.sample();
  }

  private sample(): void {
    const now = this.deps.clock.now();
    const idle = this.deps.signals.idleSeconds();
    const focused = this.deps.signals.focused() && !this.locked && !this.suspended;
    if (!focused && this.awaySince === null) this.awaySince = now;
    const nextSample = this.collect(now, idle);
    const minimum = Math.min(...this.watches.map((w) => w.absenceMinutes ?? DEFAULT_ABSENCE_MINUTES));
    if (focused && (idle === null || idle < minimum * 60)) {
      const ids = this.watches.filter((w) => this.qualified.has(w.id)).map((w) => w.id);
      this.awaySince = null;
      this.qualified.clear();
      if (this.recordedUseAt === null || now - this.recordedUseAt >= 60_000 || ids.length) {
        this.recordedUseAt = now;
        this.deps.used();
      }
      if (ids.length) this.deps.returned(ids);
    }
    if (this.unlisten) this.arm(nextSample);
  }

  private arm(ms: number): void {
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = this.deps.clock.setTimeout(() => { this.timer = null; this.sample(); }, ms);
  }
}
