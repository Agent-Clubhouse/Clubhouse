import { randomUUID } from 'crypto';
/** One random, non-persistent id per host process, shared by handshake and exporters. */
export const telemetryInstanceId = randomUUID();
export const telemetryServiceName = 'clubhouse';
