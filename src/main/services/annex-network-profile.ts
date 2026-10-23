/** Process-local integration profile. Never saved to the user's settings. */
export function annexNetworkProfile(env: NodeJS.ProcessEnv = process.env): { host: '127.0.0.1' | '0.0.0.0'; advertise: boolean } {
  annexEphemeralSession(env);
  return env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY === '1'
    ? { host: '127.0.0.1', advertise: false }
    : { host: '0.0.0.0', advertise: true };
}

/** Explicit isolated integration mode: never load or save Annex credentials. */
export function annexEphemeralSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLUBHOUSE_ANNEX_EPHEMERAL !== '1') return false;
  if (env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY !== '1' || !env.CLUBHOUSE_USER_DATA) {
    throw new Error('Ephemeral Annex requires loopback-only networking and an isolated user-data profile');
  }
  return true;
}
