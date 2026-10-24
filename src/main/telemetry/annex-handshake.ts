import { randomUUID } from 'crypto';
import { ATTR } from '../../shared/telemetry/attributes';
import { telemetryInstanceId, telemetryServiceName } from './instance';
import { telemetryLevel } from './facade';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface TelemetryHello {
  version: 1;
  serviceName: 'clubhouse-go' | 'clubhouse';
  serviceInstanceId: string;
  connectionAttemptId: string;
  traceContext: 'w3c-v00';
}
export function parseTelemetryHello(value: unknown): TelemetryHello | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || (p.serviceName !== 'clubhouse-go' && p.serviceName !== 'clubhouse')
    || p.traceContext !== 'w3c-v00' || typeof p.serviceInstanceId !== 'string' || p.serviceInstanceId.length !== 36 || !UUID4.test(p.serviceInstanceId)
    || typeof p.connectionAttemptId !== 'string' || p.connectionAttemptId.length !== 36 || !UUID4.test(p.connectionAttemptId)) return undefined;
  return { version: 1, serviceName: p.serviceName, serviceInstanceId: p.serviceInstanceId,
    connectionAttemptId: p.connectionAttemptId, traceContext: 'w3c-v00' };
}
export function telemetryHelloAck(peer: TelemetryHello, connectionId = randomUUID()) {
  return { version: 1, serviceName: telemetryServiceName, serviceInstanceId: telemetryInstanceId,
    peerServiceInstanceId: peer.serviceInstanceId, connectionAttemptId: peer.connectionAttemptId,
    connectionId, traceContext: 'w3c-v00', recording: telemetryLevel() ?? 'off', sampling: 'local' };
}
export function handshakeAttributes(ack: ReturnType<typeof telemetryHelloAck>) {
  return [ATTR.annexPeerInstanceId(ack.peerServiceInstanceId), ATTR.annexConnectionId(ack.connectionId),
    ATTR.annexAttemptId(ack.connectionAttemptId)];
}
