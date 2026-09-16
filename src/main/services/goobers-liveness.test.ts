import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('./goobers-http', () => ({
  httpGetJson: vi.fn(),
  parseJsonBody: <T>(body: string): T | null => {
    try {
      return JSON.parse(body) as T;
    } catch {
      return null;
    }
  },
}));

import { httpGetJson } from './goobers-http';
import { probeLiveness } from './goobers-liveness';

let tmpRoot: string;
let otherRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-liveness-test-'));
  otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-liveness-other-'));
  fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
  vi.mocked(httpGetJson).mockReset();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(otherRoot, { recursive: true, force: true });
});

function writeAddressFile(host = '127.0.0.1', port = 8080): void {
  fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), `${host}:${port}`);
}

function writeUpLock(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(tmpRoot, 'scheduler', 'up.lock'),
    JSON.stringify({
      pid: 7027,
      startedAt: '2026-09-13T23:42:45.374274Z',
      instanceRoot: tmpRoot,
      version: 'portal-v0.1.0-21-ga1b2ae99',
      livenessTimeoutMillis: 120000,
      holderKind: 'daemon',
      ...overrides,
    }),
  );
}

describe('probeLiveness', () => {
  it('reports not-running when scheduler/api.address is absent — never trusts a stale up.lock pid (the reference-instance fixture case)', async () => {
    // Mirrors the reference instance: up.lock present with a stale pid 7027,
    // but no address file (daemon actually down).
    writeUpLock();

    const result = await probeLiveness(tmpRoot);

    expect(result.daemon.state).toBe('not-running');
    expect(result.daemon.pid).toBeNull();
    expect(httpGetJson).not.toHaveBeenCalled();
  });

  it('treats ECONNREFUSED against a present address file as a stale file, not a failure', async () => {
    writeAddressFile();
    vi.mocked(httpGetJson).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('not-running');
  });

  it('reports starting on a 503 from /readyz', async () => {
    writeAddressFile();
    vi.mocked(httpGetJson).mockResolvedValueOnce({ status: 503, body: '' });

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('starting');
  });

  it('rejects an identity mismatch — a second process on the same port is never rendered as ours', async () => {
    writeAddressFile();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: otherRoot }) }); // /api/v1/instance

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('unknown');
    expect(result.error?.code).toBe('identity-mismatch');
    expect(result.instance).toBeNull();
  });

  it('reports running with confirmed identity, and pid/version/startedAt are display-only from up.lock', async () => {
    writeAddressFile();
    writeUpLock();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: tmpRoot }) }) // /api/v1/instance
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          schemaVersion: 'v1',
          ready: true,
          healthy: true,
          instance: { name: 'goobers-local', environment: 'dev' },
          freshness: { observedAt: 'x', definitionsLoadedAt: 'x', journalUpdatedAt: 'x', lastSchedulerTickAt: 'x', lastTickAgeMillis: 1000 },
        }),
      }); // /api/v1/health

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('running');
    expect(result.daemon.pid).toBe(7027); // display only
    expect(result.daemon.version).toBe('portal-v0.1.0-21-ga1b2ae99');
    expect(result.degraded).toBe(false);
    expect(result.instance?.instanceRoot).toBe(tmpRoot);
  });

  it('flags degraded when lastTickAgeMillis exceeds livenessTimeoutMillis', async () => {
    writeAddressFile();
    writeUpLock({ livenessTimeoutMillis: 1000 });
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: tmpRoot }) })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          schemaVersion: 'v1',
          ready: true,
          healthy: true,
          instance: { name: 'goobers-local', environment: 'dev' },
          freshness: { observedAt: 'x', definitionsLoadedAt: 'x', journalUpdatedAt: 'x', lastSchedulerTickAt: 'x', lastTickAgeMillis: 999999 },
        }),
      });

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('running'); // daemon.state is unaffected — degraded is a connection-level concern
    expect(result.degraded).toBe(true);
  });

  it('reports a non-loopback address as an immediate hard error, never attempting a connection', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), '10.0.0.5:8080');

    const result = await probeLiveness(tmpRoot);
    expect(result.error?.code).toBe('non-loopback-address');
    expect(httpGetJson).not.toHaveBeenCalled();
  });

  it('a 401 on /api/v1/instance reports auth-required, daemon still running — /readyz already confirmed it (§14.1)', async () => {
    writeAddressFile();
    writeUpLock();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz — outside the auth pipeline, never 401s
      .mockResolvedValueOnce({ status: 401, body: '' }); // /api/v1/instance

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('running');
    expect(result.daemon.pid).toBe(7027); // display metadata from up.lock is still readable — no auth needed for a local file
    expect(result.error?.code).toBe('auth-required');
    expect(result.instance).toBeNull();
    expect(result.health).toBeNull();
    // Only /readyz and /api/v1/instance were called — never /api/v1/health,
    // since identity was never confirmed.
    expect(httpGetJson).toHaveBeenCalledTimes(2);
  });

  it('a 401 on /api/v1/health reports auth-required but keeps the already-confirmed instance identity', async () => {
    writeAddressFile();
    writeUpLock();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: tmpRoot }) }) // /api/v1/instance
      .mockResolvedValueOnce({ status: 401, body: '' }); // /api/v1/health

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('running');
    expect(result.error?.code).toBe('auth-required');
    expect(result.instance?.instanceRoot).toBe(tmpRoot);
    expect(result.health).toBeNull();
  });
});
