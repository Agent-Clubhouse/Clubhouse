import { networkInterfaces } from 'node:os';
import { powerMonitor } from 'electron';
import { listDevices } from './annex-devices';
import { onDevicePresenceChanged } from './annex-device-signal';
import { publishAppEvent } from './app-event-bus';
import { AnnexPresence } from './annex-presence';

/** Local interface facts, not Internet reachability or a probe of another device. */
export function localAnnexNetwork(): string {
  return Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith('169.254.') && !entry.address.startsWith('fe80:'))
    .map((entry) => entry.address).sort().join(',');
}

let stop: (() => void) | null = null;

/** Start after Actions subscribes, so the launch burst reaches saved actions. */
export function startDevicePresence(): void {
  if (stop) return;
  const presence = new AnnexPresence({ devices: listDevices, publish: publishAppEvent });
  let network = localAnnexNetwork();
  const sampleNetwork = () => {
    const next = localAnnexNetwork();
    if (next === network) return;
    const previous = network;
    network = next;
    presence.setAway('network', !next);
    if (previous && next) presence.networkChanged();
  };
  const changed = () => { sampleNetwork(); presence.changed(); };
  const signals = {
    suspend: () => presence.setAway('suspend', true),
    resume: () => presence.setAway('suspend', false),
    'lock-screen': () => presence.setAway('lock', true),
    'unlock-screen': () => presence.setAway('lock', false),
  } as const;
  presence.start();
  if (!network) presence.setAway('network', true);
  const unsubscribe = onDevicePresenceChanged(changed);
  for (const [signal, listener] of Object.entries(signals)) powerMonitor.on(signal, listener);
  const timer = setInterval(sampleNetwork, 1_000);
  timer.unref?.();
  stop = () => {
    presence.stop();
    unsubscribe();
    clearInterval(timer);
    for (const [signal, listener] of Object.entries(signals)) powerMonitor.removeListener(signal, listener);
  };
}

/** Called synchronously before Annex sockets close during every shutdown path. */
export function stopDevicePresence(): void {
  stop?.();
  stop = null;
}
