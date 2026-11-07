import type { ManagedAgentsService } from './service';

const installs = new WeakMap<ManagedAgentsService, Promise<void>>();

/**
 * Install or update a service's built-in parts once per app run. Startup, the
 * automatic switch to managed (D59) and helper starts share it; a failure lets
 * the next caller try again.
 */
export function ensureBuiltinsOnceFor(service: ManagedAgentsService): Promise<void> {
  let install = installs.get(service);
  if (!install) {
    install = service.ensureBuiltins().catch((err) => {
      installs.delete(service);
      throw err;
    });
    installs.set(service, install);
  }
  return install;
}
