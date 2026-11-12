import type { DispatcherRole } from './dispatcher-behavior';

/**
 * The Dispatcher's default name: the one place it is written. "Dispatcher" is
 * the working name (#3034); the final name is decided later and changes here.
 * People can still name their own in setup or Settings (#3047).
 */
export const DEFAULT_DISPATCHER_NAME = 'Dispatcher';

export const DISPATCHER_CONTROLLER_NAME = 'Dispatcher controller';

/** Display roles only; saved names and tool-addressing names stay unchanged. */
export function dispatcherRoleDisplayName(role: DispatcherRole, name?: string | null): string {
  return role === 'work' ? DISPATCHER_CONTROLLER_NAME : name || DEFAULT_DISPATCHER_NAME;
}
