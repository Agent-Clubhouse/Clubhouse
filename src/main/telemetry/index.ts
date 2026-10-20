/**
 * Public telemetry surface for main-process code. Importing this module never
 * loads the OpenTelemetry SDK; see facade.ts and bootstrap.ts.
 */
export { tel, flushBeforeExit } from './facade';
/** Local-only diagnostic lines (#2299); never exported. */
export { diag, addDiagTap, type DiagTap, type DiagEntry } from './diag';
export { ATTR } from '../../shared/telemetry/attributes';
export {
  initTelemetry,
  recordAppSession,
  enableTelemetry,
  disableTelemetry,
  sendTestEvent,
  isTelemetryConfigured,
} from './bootstrap';
