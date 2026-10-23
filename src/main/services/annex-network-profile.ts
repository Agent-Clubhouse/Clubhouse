/** Process-local integration profile. Never saved to the user's settings. */
export function annexNetworkProfile(env: NodeJS.ProcessEnv = process.env): { host: '127.0.0.1' | '0.0.0.0'; advertise: boolean } {
  return env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY === '1'
    ? { host: '127.0.0.1', advertise: false }
    : { host: '0.0.0.0', advertise: true };
}
