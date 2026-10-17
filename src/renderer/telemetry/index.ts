/**
 * Public renderer telemetry surface. Feature code imports from here only;
 * nothing in src/renderer may import OpenTelemetry (eslint enforces it).
 */
export { tel, initRendererTelemetry, markRendererReady, flushTelemetry, isTelemetryEnabled } from './facade';
export { installRendererErrorHandlers } from './errors';
export { setTelemetryView, startLongFrameCollection, type TelemetryView } from './long-frames';
export { ATTR } from '../../shared/telemetry/attributes';
