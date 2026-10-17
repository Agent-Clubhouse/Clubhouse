/**
 * Main-process persistence signals (spec §12 H1). Imports only the facade,
 * so store modules (including the settings store) can use it without a cycle.
 */
import { createPersistSignals } from '../../shared/telemetry/persist-signals';
import { tel } from './facade';

export const persist = createPersistSignals(tel);
export type { PersistStore, PersistAction } from '../../shared/telemetry/persist-signals';
