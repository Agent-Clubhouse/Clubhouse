/**
 * Registry of chat drivers (protocol transports). Driver modules register
 * themselves at startup; with none registered, every agent runs in the
 * terminal regardless of settings.
 */

import type { ChatDriver, ChatDriverId } from '../../../shared/chat';

const drivers = new Map<ChatDriverId, ChatDriver>();

export function registerChatDriver(driver: ChatDriver): () => void {
  drivers.set(driver.id, driver);
  return () => {
    if (drivers.get(driver.id) === driver) drivers.delete(driver.id);
  };
}

/** The preferred driver if registered for this provider, else the first one for it that isn't opt-in. */
export function resolveChatDriver(provider: string, preferred?: ChatDriverId): ChatDriver | undefined {
  if (preferred) {
    const d = drivers.get(preferred);
    if (d && d.provider === provider) return d;
  }
  for (const d of drivers.values()) {
    if (d.provider === provider && !d.optIn) return d;
  }
  return undefined;
}

export function listChatDrivers(): ChatDriver[] {
  return [...drivers.values()];
}

/** For tests. */
export function clearChatDrivers(): void {
  drivers.clear();
}
