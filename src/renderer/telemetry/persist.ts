/** Renderer-side persistence signals (spec §12 H1), e.g. the canvas save gate. */
import { createPersistSignals } from '../../shared/telemetry/persist-signals';
import { tel } from './facade';

export const persist = createPersistSignals(tel);
