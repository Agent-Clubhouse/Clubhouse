import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { ATTR, getAttributeSpec } from '../../shared/telemetry/attributes';
import {
  _resetAnnexTelemetryForTests,
  addrFamily,
  attemptBucket,
  connectAuthMode,
  connectErrorFor,
  connectFailed,
  connectStarted,
  connectSucceeded,
  disconnectReasonFor,
  pairResultFor,
  recordBroadcast,
  recordDiscover,
  restTraceparent,
  routeTemplate,
  wsTraceparent,
} from './annex-telemetry';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import type { TelemetryRuntime } from './types';

let rt: TelemetryRuntime;
beforeEach(() => {
  rt = { level: 'standard', count: vi.fn(), replaySpan: vi.fn(), event: vi.fn() } as unknown as TelemetryRuntime;
  setProducingRuntime(rt);
});
afterEach(() => {
  setProducingRuntime(null);
  _resetAnnexTelemetryForTests();
});

const spans = () => (rt.replaySpan as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

describe('helpers', () => {
  it.each([
    ['192.168.1.4', 'ipv4'],
    ['fe80::1%en0', 'ipv6'],
    ['fe80::1', 'ipv6'],
    ['[fe80::1]', 'ipv6'],
    ['desk.local', 'hostname'],
    [undefined, 'hostname'],
  ])('addrFamily(%s) → %s', (host, family) => {
    expect(addrFamily(host)).toBe(family);
  });

  it('buckets attempts', () => {
    expect([1, 2, 3, 5, 6, 10, 11].map(attemptBucket)).toEqual(['1', '2', '3-5', '3-5', '6-10', '6-10', '>10']);
  });

  it('maps pairing codes and disconnect text to enums only', () => {
    expect(pairResultFor('pairing_locked')).toBe('locked');
    expect(pairResultFor('Pairing failed (HTTP 500)')).toBe('other');
    expect(connectErrorFor('Peer certificate mismatch')).toBe('cert_mismatch');
    expect(connectErrorFor('Opening handshake has timed out')).toBe('handshake_timeout');
    expect(connectErrorFor('Unexpected server response: 401')).toBe('auth_rejected');
    expect(connectErrorFor('ECONNREFUSED 10.0.0.2:4433')).toBe('ws_error');
    expect(connectErrorFor(undefined)).toBeUndefined();
    expect(disconnectReasonFor('Heartbeat timeout')).toBe('heartbeat_timeout');
    expect(disconnectReasonFor(undefined)).toBe('user');
  });
});

describe('REST route templates', () => {
  it('covers every satellite route with a registered template and never a concrete path', async () => {
    const { annexHttpRoutes } = await import('../services/annex-server');
    const allowed = getAttributeSpec('clubhouse.annex.route')?.values ?? [];
    const templates = annexHttpRoutes().map((r) => routeTemplate(r.method, r.pattern));
    expect(templates.length).toBeGreaterThan(30);
    expect(templates.filter((t) => !allowed.includes(t))).toEqual([]);
    expect(allowed.filter((v) => v !== 'other' && !templates.includes(v as never))).toEqual([]);
    expect(routeTemplate('GET', /^\/api\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/transcript(\?.*)?$/)).toBe('GET /api/v1/agents/:id/sessions/:id/transcript');
  }, 30_000); // importing the satellite module is slow on a loaded machine
});

describe('satellite trace context', () => {
  const tc = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  it('takes tc only from remote spawn/wake messages', () => {
    expect(wsTraceparent('agent:spawn', tc)).toBe(tc);
    expect(wsTraceparent('agent:wake', tc)).toBe(tc);
    expect(wsTraceparent('pty:input', tc)).toBeUndefined();
    expect(wsTraceparent('some:new-type', tc)).toBeUndefined();
    expect(wsTraceparent('agent:spawn', 42)).toBeUndefined();
  });

  it('takes the REST traceparent header only from mTLS controllers', () => {
    expect(restTraceparent(tc, true)).toBe(tc);
    expect(restTraceparent(tc, false)).toBeUndefined();
    expect(restTraceparent([tc, tc], true)).toBeUndefined();
    expect(restTraceparent(undefined, true)).toBeUndefined();
  });
});

describe('controller connect', () => {
  it('replays a connect from start to the first snapshot with family and auth mode', () => {
    connectStarted('fp1', 'fe80::1', 1000);
    connectAuthMode('fp1', 'mtls');
    connectSucceeded('fp1', 1800);
    connectSucceeded('fp1', 1900); // later snapshots are no-ops
    expect(spans()).toEqual([{
      name: 'clubhouse.annex.connect', startMs: 1000, endMs: 1800,
      attrs: [ATTR.annexRole('controller'), ATTR.addrFamily('ipv6'), ATTR.annexAuthMode('mtls')],
      outcome: 'ok', errorType: undefined,
    }]);
  });

  it('records a failed connect by type and drops one the user abandoned', () => {
    connectStarted('fp2', '10.0.0.2', 0);
    connectFailed('fp2', 'cert_mismatch', 50);
    connectStarted('fp3', '10.0.0.3', 0);
    connectFailed('fp3', undefined, 50);
    connectSucceeded('fp3', 60);
    expect(spans().map((s) => [s.outcome, s.errorType])).toEqual([['error', 'cert_mismatch']]);
    expect(JSON.stringify(spans())).not.toContain('10.0.0');
  });

  it('records discovery by address family without the host', () => {
    recordDiscover(0, '192.168.0.9', 'identity_unreachable', 20);
    expect(spans()[0]).toMatchObject({ name: 'clubhouse.annex.discover', outcome: 'error', attrs: [ATTR.annexRole('controller'), ATTR.addrFamily('ipv4')] });
    expect(JSON.stringify(spans())).not.toContain('192.168');
  });
});

describe('satellite broadcasts', () => {
  it('counts once per broadcast with bytes, buckets unknown types, and counts send failures', () => {
    recordBroadcast('pty:data', 120, 0);
    recordBroadcast('some:new-event', 10, 2);
    const calls = (rt.count as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toEqual([
      ['clubhouse.annex.events', 1, [ATTR.annexEventType('pty:data')]],
      ['clubhouse.annex.events.bytes', 120, [ATTR.annexEventType('pty:data')]],
      ['clubhouse.annex.events', 1, [ATTR.annexEventType('other')]],
      ['clubhouse.annex.events.bytes', 10, [ATTR.annexEventType('other')]],
      ['clubhouse.annex.send_failures', 2, [ATTR.annexEventType('other')]],
    ]);
  });
});
