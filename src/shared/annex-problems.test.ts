import { describe, it, expect } from 'vitest';
import {
  annexProblemText,
  classifyConnectionError,
  classifyRefusal,
  describeAnnexProblem,
  type AnnexProblemCode,
} from './annex-problems';

const ALL: AnnexProblemCode[] = [
  'refused', 'timeout', 'unreachable', 'not-found', 'dropped', 'stopped-answering', 'incompatible',
  'wrong-role', 'tls-unavailable', 'http-refused', 'old-pairing', 'removed-there', 'cert-expired',
  'cert-not-yet-valid', 'cert-mismatch', 'not-found-yet', 'client-off', 'connection-failed',
];

describe('annex problems', () => {
  it.each(ALL)('%s says what happened and what to do, as two sentences', (code) => {
    const problem = describeAnnexProblem(code, 'Studio Mac');
    expect(problem.code).toBe(code);
    expect(problem.message).toMatch(/^[A-Z].*\.$/);
    expect(problem.action).toMatch(/^[A-Z].*\.$/);
    // House style: no em dashes, and no raw error codes shown to the person.
    expect(annexProblemText(problem)).not.toMatch(/[—]|E[A-Z]{4,}/);
  });

  it('names the device, and falls back when it has no name', () => {
    expect(describeAnnexProblem('refused', 'Studio Mac').message).toBe("Studio Mac isn't accepting connections.");
    expect(describeAnnexProblem('refused', '').message).toBe("That computer isn't accepting connections.");
  });

  it('includes the HTTP status for a plain refusal when known', () => {
    expect(describeAnnexProblem('http-refused', 'Mini', { status: 502 }).message).toBe('Mini refused the connection (HTTP 502).');
    expect(describeAnnexProblem('http-refused', 'Mini').message).toBe('Mini refused the connection.');
  });

  it.each([
    '127.0.0.1', '127.12.34.56', 'localhost', 'LOCALHOST.', '::1', '[::1]', '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0::1', '::0001', '0000:0000:0000:0000:0000:0000:0000:0001', '0:0:0:0:0:ffff:7f00:1',
  ])('suggests checking the forward for loopback target %s', (host) => {
    for (const code of ['refused', 'unreachable'] as const) {
      expect(describeAnnexProblem(code, 'Mini', { host }).action).toMatch(/local forward is running/);
      expect(describeAnnexProblem(code, 'Mini', { host, pairing: true }).action).toMatch(/local forward is running/);
    }
    expect(describeAnnexProblem('cert-mismatch', 'Mini', { host }).action).not.toMatch(/forward/);
  });

  it.each(['192.168.1.5', '100.64.0.1', 'studio.local', '::2'])('keeps network advice for non-loopback target %s', (host) => {
    expect(describeAnnexProblem('refused', 'Mini', { host }).action).not.toMatch(/forward/);
  });

  it.each([
    [{ code: 'ECONNREFUSED' }, 'refused'],
    [{ code: 'EHOSTUNREACH' }, 'unreachable'],
    [{ code: 'ENETUNREACH' }, 'unreachable'],
    [{ code: 'EADDRNOTAVAIL' }, 'unreachable'],
    [{ code: 'ENOTFOUND' }, 'not-found'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'ECONNRESET' }, 'dropped'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'cert-expired'],
    [{ code: 'ERR_ANNEX_PIN_MISMATCH' }, 'cert-mismatch'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'cert-mismatch'],
    [new Error('connect ECONNREFUSED 10.0.0.2:9000'), 'refused'],
    [new Error('getaddrinfo ENOTFOUND studio.tail1234.ts.net'), 'not-found'],
    [new Error('Opening handshake has timed out'), 'timeout'],
    ['Timed out pairing with that computer', 'timeout'],
    ['socket hang up', 'dropped'],
    ['Connection closed', 'dropped'],
    ['Heartbeat timeout', 'stopped-answering'],
    ['Incompatible Annex version', 'incompatible'],
    [new Error('something new'), 'connection-failed'],
    [null, 'connection-failed'],
  ] as const)('classifies %s as %s', (err, code) => {
    expect(classifyConnectionError(err)).toBe(code);
  });

  it('gives pairing advice that never promises a retry', () => {
    for (const code of ['unreachable', 'dropped', 'stopped-answering', 'connection-failed'] as const) {
      expect(describeAnnexProblem(code, 'Mini', { pairing: true }).action).not.toMatch(/reconnecting|tries again/);
    }
    expect(describeAnnexProblem('dropped', 'Mini').action).toBe('Clubhouse is reconnecting.');
    expect(describeAnnexProblem('refused', 'Mini', { pairing: true }).action).toBe('Check that Clubhouse is open there with Annex turned on.');
  });

  it.each([
    [401, 'needs_pairing', 'old-pairing'],
    [401, 'peer_not_paired', 'removed-there'],
    [403, 'peer_role_not_allowed', 'wrong-role'],
    [503, 'tls_unavailable', 'tls-unavailable'],
    [503, undefined, 'tls-unavailable'],
    [500, undefined, 'http-refused'],
  ] as const)('classifies an HTTP %s %s refusal as %s', (status, error, code) => {
    expect(classifyRefusal(status, error)).toBe(code);
  });
});
