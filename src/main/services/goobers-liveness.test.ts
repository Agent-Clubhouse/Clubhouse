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

/** The configured root's real identity (M22) — written to `.instance-id` by
 *  default in `beforeEach` since every "our own daemon" fixture below now
 *  needs it to pass the identity check at all. */
const LOCAL_INSTANCE_ID = 'eaf74575d8de50fa5471027ba7fd15cb';
/** A different, equally well-formed 32-hex id — a genuinely foreign daemon. */
const FOREIGN_INSTANCE_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-liveness-test-'));
  otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-liveness-other-'));
  fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, '.instance-id'), `${LOCAL_INSTANCE_ID}\n`);
  vi.mocked(httpGetJson).mockReset();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(otherRoot, { recursive: true, force: true });
});

function writeAddressFile(host = '127.0.0.1', port = 8080): void {
  fs.writeFileSync(path.join(tmpRoot, 'scheduler', 'api.address'), `${host}:${port}`);
}

/** An `/api/v1/instance` 200 body for *our own* daemon — deliberately reports
 *  `instanceRoot: "."` (M22: an argv echo, not identity) and the id matching
 *  `.instance-id` above. */
function ownInstanceBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apiVersion: 'v1',
    schemaVersion: 'v1',
    instanceRoot: '.',
    rootIdentity: { id: LOCAL_INSTANCE_ID },
    ...overrides,
  });
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

  it('rejects a genuine identity mismatch (foreign daemon, different absolute root and id) — never rendered as ours', async () => {
    writeAddressFile();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: otherRoot, rootIdentity: { id: FOREIGN_INSTANCE_ID } }) }); // /api/v1/instance

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('unknown');
    expect(result.error?.code).toBe('identity-mismatch');
    expect(result.instance).toBeNull();
  });

  it('M22: rejects a foreign daemon even when it reports instanceRoot "." like ours does — identity must not be decided by the path string', async () => {
    writeAddressFile();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      // Same relative-path echo as our own daemon would produce, but a
      // genuinely different rootIdentity.id — this is the non-negotiable
      // acceptance criterion: a foreign daemon squatting the port and
      // reporting "." must still be refused.
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: '.', rootIdentity: { id: FOREIGN_INSTANCE_ID } }) });

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('unknown');
    expect(result.error?.code).toBe('identity-mismatch');
    expect(result.instance).toBeNull();
  });

  it('M22: renders real state when the daemon reports instanceRoot "." for OUR OWN instance — the reported bug', async () => {
    writeAddressFile();
    writeUpLock();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() }) // /api/v1/instance — instanceRoot: "."
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
    expect(result.error).toBeUndefined();
    expect(result.instance?.instanceRoot).toBe('.');
  });

  it('identity-unverifiable when the configured root has no valid .instance-id — never a silent pass', async () => {
    fs.rmSync(path.join(tmpRoot, '.instance-id'));
    writeAddressFile();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() }); // /api/v1/instance

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('unknown');
    expect(result.error?.code).toBe('identity-unverifiable');
    expect(result.error?.message).not.toContain('another process is listening'); // the old, false claim
    expect(result.instance).toBeNull();
  });

  it('identity-unverifiable (not a pass) when the daemon omits rootIdentity — older-daemon version skew', async () => {
    writeAddressFile();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', instanceRoot: '.' }) }); // no rootIdentity at all

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('unknown');
    expect(result.error?.code).toBe('identity-unverifiable');
    expect(result.instance).toBeNull();
  });

  it('reads the dotted .instance-id, never the sibling undotted instance-id file', async () => {
    // Mirrors the reference instance (spec §4.2): a different, wrong value in
    // the undotted sibling file must never be what gets compared.
    fs.writeFileSync(path.join(tmpRoot, 'instance-id'), 'e86a94384664f7981488722ac46d2432\n');
    writeAddressFile();
    writeUpLock();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' })
      .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() }) // reports the DOTTED file's id
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ apiVersion: 'v1', schemaVersion: 'v1', ready: true, healthy: true, instance: { name: 'x', environment: 'dev' }, freshness: {} }) });

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('running'); // would be identity-mismatch if the undotted file were read instead
    expect(result.error).toBeUndefined();
  });

  it('reports running with confirmed identity, and pid/version/startedAt are display-only from up.lock', async () => {
    writeAddressFile();
    writeUpLock();
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' }) // /readyz
      .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() }) // /api/v1/instance
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
    expect(result.instance?.instanceRoot).toBe('.');
  });

  it('flags degraded when lastTickAgeMillis exceeds livenessTimeoutMillis', async () => {
    writeAddressFile();
    writeUpLock({ livenessTimeoutMillis: 1000 });
    vi.mocked(httpGetJson)
      .mockResolvedValueOnce({ status: 200, body: '' })
      .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() })
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
      .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() }) // /api/v1/instance
      .mockResolvedValueOnce({ status: 401, body: '' }); // /api/v1/health

    const result = await probeLiveness(tmpRoot);
    expect(result.daemon.state).toBe('running');
    expect(result.error?.code).toBe('auth-required');
    expect(result.instance?.instanceRoot).toBe('.');
    expect(result.health).toBeNull();
  });

  describe('503 recovering (M20 — fifth one-sided seam)', () => {
    function readyzBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        ready: true,
        checks: { apiListening: true, configLoaded: true, resumeComplete: false, stateOpen: false, sweepsStarted: false, triggerSweepReady: false },
        startup: { phase: 'worktree-reap-crash-orphan', since: new Date().toISOString() },
        ...overrides,
      });
    }

    it('maps a 503 recovering body to a first-class recovering state, not identity-check-failed, carrying the /readyz breakdown', async () => {
      writeAddressFile();
      vi.mocked(httpGetJson)
        .mockResolvedValueOnce({ status: 200, body: readyzBody() }) // /readyz
        .mockResolvedValueOnce({ status: 503, body: JSON.stringify({ error: { code: 'recovering', message: 'daemon is completing crash recovery' } }) }); // /api/v1/instance

      const result = await probeLiveness(tmpRoot);
      expect(result.daemon.state).toBe('starting');
      expect(result.error?.code).toBe('recovering');
      expect(result.error?.message).toBe('daemon is completing crash recovery');
      expect(result.recovery?.phase).toBe('worktree-reap-crash-orphan');
      expect(result.recovery?.checks.resumeComplete).toBe(false);
      expect(result.instance).toBeNull();
      // Never reaches /api/v1/health — identity was never confirmed.
      expect(httpGetJson).toHaveBeenCalledTimes(2);
    });

    it('does not swallow a 503 whose body is not the known "recovering" shape — requirement 4', async () => {
      writeAddressFile();
      vi.mocked(httpGetJson)
        .mockResolvedValueOnce({ status: 200, body: readyzBody() }) // /readyz
        .mockResolvedValueOnce({ status: 503, body: JSON.stringify({ error: { code: 'some-other-failure', message: 'boom' } }) }); // /api/v1/instance

      const result = await probeLiveness(tmpRoot);
      expect(result.error?.code).not.toBe('recovering');
      expect(result.error?.code).toBe('identity-check-failed');
      expect(result.recovery).toBeUndefined();
    });

    it('treats a recovering 503 that has stalled well past the threshold as a genuine error, not an endless wait', async () => {
      writeAddressFile();
      const staleSince = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      vi.mocked(httpGetJson)
        .mockResolvedValueOnce({ status: 200, body: readyzBody({ startup: { phase: 'worktree-reap-crash-orphan', since: staleSince } }) })
        .mockResolvedValueOnce({ status: 503, body: JSON.stringify({ error: { code: 'recovering', message: 'daemon is completing crash recovery' } }) });

      const result = await probeLiveness(tmpRoot);
      expect(result.error?.code).toBe('recovery-stalled');
      expect(result.error?.message).toContain('worktree-reap-crash-orphan');
      expect(result.daemon.state).not.toBe('starting');
      expect(result.recovery).toBeUndefined();
    });

    it('the transition back to running (200 on the next probe) needs no special-casing — it is the normal success path', async () => {
      writeAddressFile();
      writeUpLock();
      vi.mocked(httpGetJson)
        .mockResolvedValueOnce({ status: 200, body: readyzBody({ ready: true }) })
        .mockResolvedValueOnce({ status: 200, body: ownInstanceBody() })
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
        });

      const result = await probeLiveness(tmpRoot);
      expect(result.daemon.state).toBe('running');
      expect(result.error).toBeUndefined();
      expect(result.recovery).toBeUndefined();
    });
  });
});
