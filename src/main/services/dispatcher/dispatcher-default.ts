import { ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';

/** Providers that can't run a Dispatcher. Antigravity waits on its desktop-control gate (#3799). */
const NOT_DISPATCHER_PROVIDERS: ReadonlySet<string> = new Set([ANTIGRAVITY_PROVIDER_ID]);

export function canRunDispatcher(providerId: string): boolean {
  return !NOT_DISPATCHER_PROVIDERS.has(providerId);
}

/**
 * The first enabled provider in registration order that can run a Dispatcher,
 * else the first such provider at all.
 */
export function pickDispatcherDefault(providerIds: readonly string[], enabled: readonly string[]): string | undefined {
  const eligible = providerIds.filter(canRunDispatcher);
  return eligible.find((id) => enabled.includes(id)) ?? eligible[0];
}
