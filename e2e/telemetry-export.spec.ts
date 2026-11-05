/**
 * E2E: telemetry export (docs/telemetry-otel-spec.md, Phase 1 and §6.8).
 *
 * Boots the webpack-built app with a destination pointing at a mock ingestion
 * server on 127.0.0.1, quits it through the normal before-quit path (which
 * awaits the telemetry flush), and checks what arrived: `clubhouse.app.sessions`,
 * the hand-built resource, and nothing that identifies the machine. Nothing here
 * sends beyond loopback.
 *
 * Seeded setups with `experimental: { telemetry: true }` are upgrades that
 * passed the old gate (flag, preview-eligible, consent) and keep exporting.
 * The rest of them end up off, once, on the first launch (the migration tests).
 * After that a saved `telemetry: false` still means off: only an older build or
 * a hand edit can leave one behind, since every opt-in here saves it as true.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import selfsigned from 'selfsigned';
import { createDisposableProfile } from './app-profile';
import { launchApp } from './launch';

interface Received {
  url: string;
  contentType: string;
  body: string;
}

function startMockIngestion(tlsOptions?: { key: string; cert: string }) {
  const received: Received[] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      const body = buf.toString('utf8');
      received.push({ url: req.url ?? '', contentType: String(req.headers['content-type'] ?? ''), body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v2.1/track')) {
        let items = 1;
        try {
          const parsed = JSON.parse(body);
          items = Array.isArray(parsed) ? parsed.length : 1;
        } catch {
          items = body.split('\n').filter(Boolean).length;
        }
        res.end(JSON.stringify({ itemsReceived: items, itemsAccepted: items, errors: [] }));
      } else {
        res.end('{}');
      }
    });
  };
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  return new Promise<{ server: http.Server | https.Server; port: number; received: Received[] }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, received });
    });
  });
}

async function quitAndWait(electronApp: Awaited<ReturnType<typeof launchApp>>['electronApp']): Promise<void> {
  // close() asks the app to quit, so before-quit runs and awaits the
  // telemetry flush (bounded at 3 s) before the process exits.
  await electronApp.close();
}

/** Whether the app's main process can encrypt with safeStorage (false on keyring-less Linux runners). */
async function secureStorageAvailable(electronApp: Awaited<ReturnType<typeof launchApp>>['electronApp']): Promise<boolean> {
  return electronApp.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
}

/**
 * With encryption available, the Phase 1 plaintext secret must have moved to
 * telemetry-secret.bin and be gone from telemetry-settings.json. Without it,
 * by design the plaintext stays put (it is the only copy) and no secret file
 * is created.
 */
async function expectLegacySecretHandled(dir: string, encryption: boolean, azureEnabled: boolean): Promise<void> {
  const settingsText = await fs.promises.readFile(path.join(dir, 'telemetry-settings.json'), 'utf-8');
  const secretExists = fs.existsSync(path.join(dir, 'telemetry-secret.bin'));
  if (encryption) {
    expect(secretExists).toBe(true);
    expect(settingsText).not.toContain('InstrumentationKey');
    // Migrated to the multi-destination shape.
    expect(JSON.parse(settingsText).destinations.find((d: { id: string }) => d.id === 'azure')).toMatchObject({ enabled: azureEnabled });
  } else {
    expect(secretExists).toBe(false);
    expect(settingsText).toContain('InstrumentationKey');
  }
}

function expectNoMachineIdentifiers(received: Received[]): void {
  const all = received.map((r) => r.body).join('\n');
  expect(all).not.toContain(os.hostname());
  expect(all).not.toContain(os.homedir());
  expect(all).not.toContain('host.name');
  expect(all).not.toContain('process.command_args');
}

/** `isPreviewEligible` follows the opt-in instead of always being true (see e2e/stable-mode.spec.ts). */
const STABLE_BUILD = { CLUBHOUSE_TEST_STABLE_BUILD: '1' };

/** Saved by an earlier version: consent on record, a confirmed destination on, the developer destination confirmed. */
function upgradeSettings(port: number) {
  return {
    consentVersion: 1,
    sampleRate: 1,
    destinations: [
      {
        id: 'otlp', kind: 'otlp', enabled: true, level: 'standard', preset: 'all', confirmedHost: `127.0.0.1:${port}`,
        otlp: { endpoint: `http://127.0.0.1:${port}`, headerNames: [] as string[], temporality: 'cumulative' },
      },
      { id: 'framebriar', kind: 'framebriar', enabled: false, level: 'standard', preset: 'user_activity', confirmedHost: 'framebriar.invalid', framebriar: { userOff: false } },
    ],
  };
}

test.describe('Telemetry export', () => {
  test('OTLP: sends clubhouse.app.sessions with the hand-built resource on quit', async () => {
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { newChrome: false, telemetry: true },
      userDataFiles: {
        'telemetry-settings.json': {
          enabled: true,
          level: 'standard',
          sampleRate: 1,
          // Phase 1 file shape (plaintext destination) with consent recorded:
          // exercises the Phase 2 migration on startup.
          consentVersion: 1,
          destination: { kind: 'otlp', endpoint: `http://127.0.0.1:${mock.port}` },
        },
      },
    });
    try {
      await expect(window.locator('body')).toBeVisible();
      await quitAndWait(electronApp);

      const metrics = mock.received.filter((r) => r.url === '/v1/metrics');
      expect(metrics.length).toBeGreaterThan(0);
      for (const r of mock.received) expect(r.contentType).toContain('application/json');

      const body = metrics.map((r) => r.body).join('\n');
      expect(body).toContain('clubhouse.app.sessions');
      expect(body).toContain('clubhouse.startup.kind');
      expect(body).toContain('service.instance.id');
      expect(body).toContain('clubhouse.install.id');
      expectNoMachineIdentifiers(mock.received);

      // The install id was generated on first enable and persisted 0600.
      const settingsPath = path.join(userDataDir!, 'telemetry-settings.json');
      const saved = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));
      expect(saved.installId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body).toContain(saved.installId);
      // Passed the old gate, so the migration left it on.
      expect(saved.exportGraduation).toBe(1);
      expect(saved.destinations.find((d: { id: string }) => d.id === 'otlp').enabled).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      await electronApp.close().catch(() => {});
      mock.server.close();
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Azure Monitor: sends envelopes to the connection-string endpoint on quit', async () => {
    // The exporter upgrades every ingestion endpoint to HTTPS, so the mock
    // needs TLS; NODE_EXTRA_CA_CERTS makes the app's main process trust it.
    const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
      keySize: 2048,
      days: 1,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    });
    const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-ca-'));
    const caFile = path.join(caDir, 'ca.pem');
    fs.writeFileSync(caFile, pems.cert);
    const mock = await startMockIngestion({ key: pems.private, cert: pems.cert });

    const prevCa = process.env.NODE_EXTRA_CA_CERTS;
    process.env.NODE_EXTRA_CA_CERTS = caFile;
    let launched: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      launched = await launchApp({
        experimental: { newChrome: false, telemetry: true },
        // Unpackaged-only override of the App Insights host allowlist (settings.ts).
        env: { CLUBHOUSE_TELEMETRY_TEST_AZURE_HOST: `127.0.0.1:${mock.port}` },
        userDataFiles: {
          'telemetry-settings.json': {
            enabled: true,
            level: 'standard',
            sampleRate: 1,
            consentVersion: 1,
            destination: {
              kind: 'azure',
              connectionString: `InstrumentationKey=00000000-0000-4000-8000-0000000000e2;IngestionEndpoint=https://127.0.0.1:${mock.port}/`,
            },
          },
        },
      });
      await expect(launched.window.locator('body')).toBeVisible();
      const encryption = await secureStorageAvailable(launched.electronApp);
      await quitAndWait(launched.electronApp);

      const tracks = mock.received.filter((r) => r.url.startsWith('/v2.1/track'));
      expect(tracks.length).toBeGreaterThan(0);
      const body = tracks.map((r) => r.body).join('\n');
      expect(body).toContain('clubhouse.app.sessions');
      expect(body).toContain('00000000-0000-4000-8000-0000000000e2');
      expectNoMachineIdentifiers(mock.received);
      // Only the configured endpoint's ingestion path was ever hit.
      for (const r of mock.received) expect(r.url.startsWith('/v2.1/track')).toBe(true);

      // The seeded file is the Phase 1 shape with a plaintext secret.
      await expectLegacySecretHandled(launched.userDataDir!, encryption, true);
    } finally {
      if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = prevCa;
      await launched?.electronApp.close().catch(() => {});
      mock.server.close();
      fs.rmSync(caDir, { recursive: true, force: true });
      if (launched?.userDataDir) fs.rmSync(launched.userDataDir, { recursive: true, force: true });
    }
  });

  test('Phase 1 file with the flag off: plaintext secret is still migrated, the destination ends up off, nothing exported', async () => {
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { newChrome: false, telemetry: false },
      userDataFiles: {
        'telemetry-settings.json': {
          enabled: true,
          level: 'standard',
          sampleRate: 1,
          destination: {
            kind: 'azure',
            connectionString: `InstrumentationKey=00000000-0000-4000-8000-0000000000e3;IngestionEndpoint=https://127.0.0.1:${mock.port}/`,
          },
        },
      },
    });
    try {
      await expect(window.locator('body')).toBeVisible();
      const encryption = await secureStorageAvailable(electronApp);
      if (encryption) {
        // Migration runs after ready regardless of flags; wait for it.
        await expect.poll(() => fs.existsSync(path.join(userDataDir!, 'telemetry-secret.bin')), { timeout: 15_000 }).toBe(true);
      }
      await quitAndWait(electronApp);
      await expectLegacySecretHandled(userDataDir!, encryption, false);
      expect(mock.received).toEqual([]);
    } finally {
      await electronApp.close().catch(() => {});
      mock.server.close();
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('renderer errors reach the exporter through main, without their message', async () => {
    // Phase 3a: renderer facade → telemetry:emit → main re-validation → SDK.
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { newChrome: false, telemetry: true },
      userDataFiles: {
        'telemetry-settings.json': {
          enabled: true,
          level: 'errors',
          sampleRate: 1,
          // Export starts only once consent is recorded (Phase 2).
          consentVersion: 1,
          destination: { kind: 'otlp', endpoint: `http://127.0.0.1:${mock.port}` },
        },
      },
    });
    try {
      await expect(window.locator('body')).toBeVisible();
      // Wait until main has told this renderer that telemetry is on.
      await expect
        .poll(() => window.evaluate(() => window.clubhouse.telemetry.getState().then((s) => s.enabled)), { timeout: 15_000 })
        .toBe(true);
      await window.evaluate(() => {
        void Promise.reject(new TypeError('e2e-secret-renderer-message'));
      });
      // Renderer batch (2 s) → main → exporter batch (5 s). Poll instead of sleeping.
      const logsBody = () => mock.received.filter((r) => r.url === '/v1/logs').map((r) => r.body).join('\n');
      await expect.poll(() => logsBody(), { timeout: 20_000 }).toContain('clubhouse.exception');
      await quitAndWait(electronApp);

      const logs = logsBody();
      expect(logs).toContain('clubhouse.exception');
      expect(logs).toContain('TypeError');
      expect(logs).toContain('clubhouse.window.kind');
      const all = mock.received.map((r) => r.body).join('\n');
      expect(all).not.toContain('e2e-secret-renderer-message');
      expectNoMachineIdentifiers(mock.received);
    } finally {
      await electronApp.close().catch(() => {});
      mock.server.close();
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('lifecycle: startup and shutdown span trees and the config snapshot are exported', async () => {
    // Phase 3b: startup ends on renderer-ready; shutdown is recorded before the final flush.
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { newChrome: false, telemetry: true },
      userDataFiles: {
        'telemetry-settings.json': {
          enabled: true,
          level: 'standard',
          sampleRate: 1,
          // #1952 gates export on recorded consent; ignored before it lands.
          consentVersion: 1,
          destination: { kind: 'otlp', endpoint: `http://127.0.0.1:${mock.port}` },
        },
      },
    });
    try {
      await expect(window.locator('body')).toBeVisible();
      // The startup span is exported once initApp() reports ready and the exporter batch (5 s) runs.
      const tracesBody = () => mock.received.filter((r) => r.url === '/v1/traces').map((r) => r.body).join('\n');
      const logsBody = () => mock.received.filter((r) => r.url === '/v1/logs').map((r) => r.body).join('\n');
      await expect.poll(() => tracesBody(), { timeout: 20_000 }).toContain('clubhouse.app.startup');
      await expect.poll(() => logsBody(), { timeout: 20_000 }).toContain('clubhouse.app.config_snapshot');
      await quitAndWait(electronApp);

      const traces = tracesBody();
      expect(traces).toContain('clubhouse.app.startup');
      expect(traces).toContain('clubhouse.app.shutdown');
      expect(logsBody()).toContain('clubhouse.app.config_snapshot');
      expectNoMachineIdentifiers(mock.received);

      // The session record says this run ended cleanly.
      const session = JSON.parse(await fs.promises.readFile(path.join(userDataDir!, 'telemetry-session.json'), 'utf-8'));
      expect(session.clean).toBe(true);
    } finally {
      await electronApp.close().catch(() => {});
      mock.server.close();
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('upgrade with old consent and the flag off: zero requests, on this launch and the next', async () => {
    const mock = await startMockIngestion();
    const profile = createDisposableProfile({ label: 'telemetry-upgrade-flag-off' });
    let open: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      const first = open = await launchApp({ profile, experimental: { telemetry: false }, userDataFiles: { 'telemetry-settings.json': upgradeSettings(mock.port) } });
      await expect(first.window.locator('body')).toBeVisible();
      expect(await first.window.evaluate(() => window.clubhouse.telemetrySettings.getStatus().then((s) => s.running))).toBe(false);
      await quitAndWait(first.electronApp);
      expect(mock.received).toEqual([]);

      const saved = JSON.parse(await fs.promises.readFile(path.join(profile.userDataDir, 'telemetry-settings.json'), 'utf-8'));
      expect(saved).toMatchObject({ consentVersion: 1, exportGraduation: 1 });
      expect(saved.destinations.filter((d: { enabled: boolean }) => d.enabled)).toEqual([]);
      expect(saved.destinations.find((d: { id: string }) => d.id === 'framebriar').framebriar.userOff).toBe(true);
      // Saved as the user left it, for a downgrade.
      expect(JSON.parse(await fs.promises.readFile(path.join(profile.userDataDir, 'experimental-settings.json'), 'utf-8')).telemetry).toBe(false);

      const second = open = await launchApp({ profile });
      await expect(second.window.locator('body')).toBeVisible();
      await quitAndWait(second.electronApp);
      expect(mock.received).toEqual([]);
    } finally {
      await open?.electronApp.close().catch(() => {});
      mock.server.close();
      profile.dispose();
    }
  });

  test('opt-out on an older build: a migrated install with the flag now false sends zero requests', async () => {
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { telemetry: false },
      userDataFiles: { 'telemetry-settings.json': { ...upgradeSettings(mock.port), exportGraduation: 1 } },
    });
    try {
      await expect(window.locator('body')).toBeVisible();
      await quitAndWait(electronApp);
      expect(mock.received).toEqual([]);
      const saved = JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'telemetry-settings.json'), 'utf-8'));
      expect(saved.destinations.filter((d: { enabled: boolean }) => d.enabled)).toEqual([]);
      expect(saved.destinations.find((d: { id: string }) => d.id === 'framebriar').framebriar.userOff).toBe(true);
    } finally {
      await electronApp.close().catch(() => {});
      mock.server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('unreadable flag file: export pauses with zero requests, the file is kept, and Resume starts it', async () => {
    const mock = await startMockIngestion();
    const profile = createDisposableProfile({ label: 'telemetry-flag-unreadable' });
    const flagFile = path.join(profile.userDataDir, 'experimental-settings.json');
    fs.writeFileSync(flagFile, '{"telemetry": tru');
    let open: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      const first = open = await launchApp({ profile, userDataFiles: { 'telemetry-settings.json': { ...upgradeSettings(mock.port), exportGraduation: 1 } } });
      await expect(first.window.locator('body')).toBeVisible();
      expect((await first.window.evaluate(() => window.clubhouse.telemetrySettings.getStatus())).exportPaused).toBe(true);
      await quitAndWait(first.electronApp);
      expect(mock.received).toEqual([]);
      expect(await fs.promises.readFile(`${flagFile}.unreadable`, 'utf-8')).toBe('{"telemetry": tru');
      const saved = JSON.parse(await fs.promises.readFile(path.join(profile.userDataDir, 'telemetry-settings.json'), 'utf-8'));
      expect(saved.exportSuspended).toBe('flag_unreadable');
      expect(saved.destinations.find((d: { id: string }) => d.id === 'otlp').enabled).toBe(true);

      const second = open = await launchApp({ profile });
      await expect(second.window.locator('body')).toBeVisible();
      const resumed = await second.window.evaluate(() => window.clubhouse.telemetrySettings.resume());
      expect(resumed.status.exportPaused).toBe(false);
      await quitAndWait(second.electronApp);
      expect(mock.received.length).toBeGreaterThan(0);
      expect(JSON.parse(await fs.promises.readFile(flagFile, 'utf-8')).telemetry).toBe(true);
    } finally {
      await open?.electronApp.close().catch(() => {});
      mock.server.close();
      profile.dispose();
    }
  });

  test('upgrade with the flag saved on in a stable build with Preview off: zero requests', async () => {
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { telemetry: true },
      env: STABLE_BUILD,
      userDataFiles: { 'update-settings.json': { previewChannel: false }, 'telemetry-settings.json': upgradeSettings(mock.port) },
    });
    try {
      await expect(window.locator('body')).toBeVisible();
      await quitAndWait(electronApp);
      expect(mock.received).toEqual([]);
      const saved = JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'telemetry-settings.json'), 'utf-8'));
      expect(saved.destinations.filter((d: { enabled: boolean }) => d.enabled)).toEqual([]);
    } finally {
      await electronApp.close().catch(() => {});
      mock.server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('fresh install in a stable build: the section shows, nothing sends until the user opts in, and the opt-in lasts', async () => {
    const mock = await startMockIngestion();
    const profile = createDisposableProfile({ label: 'telemetry-stable-fresh' });
    const settingsFile = path.join(profile.userDataDir, 'telemetry-settings.json');
    const host = `127.0.0.1:${mock.port}`;
    let open: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      const first = open = await launchApp({ profile, env: STABLE_BUILD });
      const w = first.window;
      expect(await w.evaluate(() => window.clubhouse.app.isPreviewEligible())).toBe(false);
      await w.locator('[data-testid="nav-settings"]').click();
      await w.getByRole('button', { name: 'Logging', exact: true }).click();
      await expect(w.locator('[data-testid="telemetry-settings"]')).toBeVisible({ timeout: 15_000 });

      const status = await w.evaluate(() => window.clubhouse.telemetrySettings.getStatus());
      expect(status.consentAccepted).toBe(false);
      expect(status.destinations.filter((d) => d.enabled)).toEqual([]);
      expect(status.destinations.find((d) => d.id === 'framebriar')?.userOff).toBe(false);
      expect(fs.existsSync(settingsFile)).toBe(false);

      await w.evaluate((endpoint) => window.clubhouse.telemetrySettings.saveOtlp({ endpoint, headers: [] }), `http://${host}`);
      const asked = await w.evaluate(() => window.clubhouse.telemetrySettings.setEnabled('otlp', true, {}));
      expect(asked).toMatchObject({ ok: false, reason: 'needs_confirmation', needs: ['consent', 'destination'] });
      expect(mock.received).toEqual([]);

      const confirmed = await w.evaluate((h) => window.clubhouse.telemetrySettings.setEnabled('otlp', true, { consent: true, host: h }), host);
      expect(confirmed.ok).toBe(true);
      await quitAndWait(first.electronApp);
      // Saved as true, so the next launch doesn't take this for an older build's opt-out.
      expect(JSON.parse(await fs.promises.readFile(path.join(profile.userDataDir, 'experimental-settings.json'), 'utf-8')).telemetry).toBe(true);
      expect(mock.received.map((r) => r.body).join('\n')).toContain('clubhouse.telemetry.enabled');

      mock.received.length = 0;
      const second = open = await launchApp({ profile, env: STABLE_BUILD });
      await expect(second.window.locator('body')).toBeVisible();
      await quitAndWait(second.electronApp);
      expect(mock.received.filter((r) => r.url === '/v1/metrics').map((r) => r.body).join('\n')).toContain('clubhouse.app.sessions');
      expect(JSON.parse(await fs.promises.readFile(settingsFile, 'utf-8')).destinations.find((d: { id: string }) => d.id === 'otlp').enabled).toBe(true);
    } finally {
      await open?.electronApp.close().catch(() => {});
      mock.server.close();
      profile.dispose();
    }
  });

  test('flag on but not enabled: nothing exported and no install id created', async () => {
    const { electronApp, window, userDataDir } = await launchApp({ experimental: { newChrome: false, telemetry: true } });
    try {
      await expect(window.locator('body')).toBeVisible();
      await quitAndWait(electronApp);
      expect(fs.existsSync(path.join(userDataDir!, 'telemetry-settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(userDataDir!, '.clubhouse', 'telemetry'))).toBe(false);
    } finally {
      await electronApp.close().catch(() => {});
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
