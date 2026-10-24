import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

/** An explicit isolated phone test may bind one existing IPv4 interface. This
 * neither enables that interface nor opens a socket; start still needs approval.
 * Discovery remains off in this profile: ordinary desktop Bonjour is unchanged. */
function selectedAddress(env: NodeJS.ProcessEnv): string | undefined {
  const address = env.CLUBHOUSE_ANNEX_BIND_ADDRESS;
  if (!address) return undefined;
  if (env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY === '1') throw new Error('Choose loopback or one interface, not both');
  if (isIP(address) !== 4 || address === '0.0.0.0' || address.startsWith('127.')
    || !Object.values(networkInterfaces()).flat().some((item) => item?.address === address && !item.internal)) {
    throw new Error('Annex bind address must be one existing non-loopback IPv4 interface');
  }
  return address;
}

/** Process-local profile. Never saved to the user's settings. */
export function annexNetworkProfile(env: NodeJS.ProcessEnv = process.env): { host: string; advertise: boolean } {
  const selected = selectedAddress(env);
  annexEphemeralSession(env);
  if (selected) return { host: selected, advertise: false };
  return env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY === '1'
    ? { host: '127.0.0.1', advertise: false }
    : { host: '0.0.0.0', advertise: true };
}

/** Explicit isolated integration mode: never load or save Annex credentials. */
export function annexEphemeralSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLUBHOUSE_ANNEX_EPHEMERAL !== '1') return false;
  if ((!selectedAddress(env) && env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY !== '1') || !env.CLUBHOUSE_USER_DATA) {
    throw new Error('Ephemeral Annex requires loopback-only networking or one selected interface and an isolated user-data profile');
  }
  return true;
}
