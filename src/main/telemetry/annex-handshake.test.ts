import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseTelemetryHello, telemetryHelloAck, handshakeAttributes } from './annex-handshake';
import { telemetryInstanceId } from './instance';
import { sanitizeAttribute } from './redaction';
import { createScrubber } from './scrubber';
const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../..', 'docs/fixtures/annex-tracing-v1.json'), 'utf8'));
describe('Annex telemetry handshake v1 cross-client fixture', () => {
  it('keeps local resource identity separate and echoes only validated peer identity', () => {
    const peer = parseTelemetryHello({ ...fixture.hello.payload, hostname: 'private-machine' })!;
    const ack = telemetryHelloAck(peer, fixture.connectionId);
    expect(ack).toMatchObject({ version: 1, serviceName: 'clubhouse', serviceInstanceId: telemetryInstanceId,
      peerServiceInstanceId: fixture.hello.payload.serviceInstanceId, connectionAttemptId: fixture.hello.payload.connectionAttemptId,
      connectionId: fixture.connectionId, traceContext: 'w3c-v00', sampling: 'local' });
    expect(JSON.stringify(ack)).not.toContain('private-machine');
    expect(ack.serviceInstanceId).not.toBe(peer.serviceInstanceId);
    expect(telemetryHelloAck(peer).connectionId).not.toBe(telemetryHelloAck(peer).connectionId);
    for (const attr of handshakeAttributes(ack)) expect(sanitizeAttribute(attr.key, attr.value, createScrubber({}))).toBe(attr.value);
  });
  it('rejects unsupported capabilities, arbitrary identities and malformed UUIDs', () => {
    for (const value of [null, [], {}, { ...fixture.hello.payload, version: 2 },
      { ...fixture.hello.payload, serviceName: 'secret-hostname' },
      { ...fixture.hello.payload, serviceInstanceId: 'private-machine' },
      { ...fixture.hello.payload, connectionAttemptId: '00000000-0000-0000-0000-000000000000' }]) {
      expect(parseTelemetryHello(value)).toBeUndefined();
    }
    expect(sanitizeAttribute('clubhouse.annex.peer.instance_id', 'private-machine', createScrubber({}))).toBeUndefined();
  });
});
