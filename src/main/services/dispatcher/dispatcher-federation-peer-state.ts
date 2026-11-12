import { isMachineFingerprint } from '../../../shared/agent-address';
import { isDispatcherFederationIdentity, type DispatcherFederationIdentity, type DispatcherFederationTrip } from '../../../shared/dispatcher-federation';
import { createSettingsStore } from '../settings-store';
import { appLog } from '../log-service';

type Controller = Pick<DispatcherFederationIdentity, 'controllerId' | 'name'>;
interface PeerState {
  version: 1;
  controllers: Record<string, Controller>;
  trips: Record<string, { reason: DispatcherFederationTrip; until: number }>;
}
export const FEDERATION_LINK_PAUSE_MS = 10 * 60_000;

const state = createSettingsStore<PeerState>(
  'dispatcher-federation-peers.json', { version: 1, controllers: {}, trips: {} },
  (raw) => {
    const controllers: PeerState['controllers'] = {};
    const trips: PeerState['trips'] = {};
    if (raw.controllers && typeof raw.controllers === 'object') {
      for (const [machine, value] of Object.entries(raw.controllers).slice(0, 256)) {
        if (!isMachineFingerprint(machine) || !value || typeof value !== 'object') continue;
        const identity = { ...value, enabled: false, running: false, working: false };
        if (isDispatcherFederationIdentity(identity)) {
          controllers[machine.toLowerCase()] = { controllerId: identity.controllerId, name: identity.name };
        }
      }
    }
    if (raw.trips && typeof raw.trips === 'object') {
      for (const [machine, value] of Object.entries(raw.trips).slice(0, 256)) {
        if (!isMachineFingerprint(machine) || !value || typeof value !== 'object') continue;
        const trip = value as Record<string, unknown>;
        if ((trip.reason === 'causal_depth' || trip.reason === 'rate_limit' || trip.reason === 'queue_limit')
          && typeof trip.until === 'number' && Number.isFinite(trip.until)) {
          trips[machine.toLowerCase()] = { reason: trip.reason, until: trip.until };
        }
      }
    }
    return { version: 1, controllers, trips };
  },
  { atomic: true, mode: 0o600 },
);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function logFailure(error: unknown): void {
  appLog('core:dispatcher', 'warn', 'Dispatcher federation peer state could not be saved', {
    meta: { error: error instanceof Error ? error.message : String(error) },
  });
}

function changed(): void {
  scheduleExpiry();
  for (const listener of listeners) {
    try { listener(); } catch (error) {
      // telemetry-exempt: logged; the state change must reach the other subscribers.
      appLog('core:dispatcher', 'warn', 'Dispatcher federation peer-state subscriber failed', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

function scheduleExpiry(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!listeners.size) return;
  const deadlines = Object.values(state.get().trips).map((trip) => trip.until).filter((until) => until > Date.now());
  if (!deadlines.length) return;
  timer = setTimeout(() => {
    timer = null;
    const current = state.get();
    const trips = Object.fromEntries(Object.entries(current.trips).filter(([, trip]) => trip.until > Date.now()));
    void state.save({ ...current, trips }).catch(logFailure);
    changed();
  }, Math.max(0, Math.min(...deadlines) - Date.now()));
  timer.unref?.();
}

export function knownDispatcherFederationController(machineId: string): Controller | undefined {
  const controller = state.get().controllers[machineId.toLowerCase()];
  return controller && { ...controller };
}

/** Call only from the membership/snapshot watcher, never a tool listing or grant check. */
export function rememberDispatcherFederationControllers(members: ReadonlyArray<{ machineId: string; identity?: DispatcherFederationIdentity }>): void {
  const current = state.get();
  const controllers: PeerState['controllers'] = {};
  const trips: PeerState['trips'] = {};
  for (const member of members) {
    const machine = member.machineId.toLowerCase();
    const identity = member.identity ?? current.controllers[machine];
    if (identity) controllers[machine] = { controllerId: identity.controllerId, name: identity.name };
    if (current.trips[machine]) trips[machine] = current.trips[machine];
  }
  const next: PeerState = { version: 1, controllers, trips };
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  void state.save(next).catch(logFailure);
  changed();
}

export function dispatcherFederationTrips(now = Date.now()): ReadonlyMap<string, DispatcherFederationTrip> {
  return new Map(Object.entries(state.get().trips).filter(([, trip]) => trip.until > now).map(([machine, trip]) => [machine, trip.reason]));
}

/** A fixed cooldown, not an election, takeover or change to a user's grants. */
export async function tripDispatcherFederationLink(machineId: string, reason: DispatcherFederationTrip, now = Date.now()): Promise<void> {
  const current = state.get();
  const written = state.save({
    ...current, trips: { ...current.trips, [machineId.toLowerCase()]: { reason, until: now + FEDERATION_LINK_PAUSE_MS } },
  });
  changed();
  await written;
}

export function onDispatcherFederationPeerStateChanged(listener: () => void): () => void {
  listeners.add(listener);
  scheduleExpiry();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearTimeout(timer); timer = null; }
  };
}
