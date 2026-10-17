/**
 * E2E: telemetry export (docs/telemetry-otel-spec.md, Phase 1).
 *
 * Boots the webpack-built app with `experimental.telemetry` on and a
 * destination pointing at a mock ingestion server on 127.0.0.1, quits it
 * through the normal before-quit path (which awaits the telemetry flush), and
 * checks what arrived: `clubhouse.app.sessions`, the hand-built resource, and
 * nothing that identifies the machine.
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

function expectNoMachineIdentifiers(received: Received[]): void {
  const all = received.map((r) => r.body).join('\n');
  expect(all).not.toContain(os.hostname());
  expect(all).not.toContain(os.homedir());
  expect(all).not.toContain('host.name');
  expect(all).not.toContain('process.command_args');
}

test.describe('Telemetry export', () => {
  test('OTLP: sends clubhouse.app.sessions with the hand-built resource on quit', async () => {
    const mock = await startMockIngestion();
    const { electronApp, window, userDataDir } = await launchApp({
      experimental: { telemetry: true },
      userDataFiles: {
        'telemetry-settings.json': {
          enabled: true,
          level: 'standard',
          sampleRate: 1,
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
    // Unpackaged-only override of the App Insights host allowlist (settings.ts).
    process.env.CLUBHOUSE_TELEMETRY_TEST_AZURE_HOST = `127.0.0.1:${mock.port}`;
    let launched: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      launched = await launchApp({
        experimental: { telemetry: true },
        userDataFiles: {
          'telemetry-settings.json': {
            enabled: true,
            level: 'standard',
            sampleRate: 1,
            destination: {
              kind: 'azure',
              connectionString: `InstrumentationKey=00000000-0000-4000-8000-0000000000e2;IngestionEndpoint=https://127.0.0.1:${mock.port}/`,
            },
          },
        },
      });
      await expect(launched.window.locator('body')).toBeVisible();
      await quitAndWait(launched.electronApp);

      const tracks = mock.received.filter((r) => r.url.startsWith('/v2.1/track'));
      expect(tracks.length).toBeGreaterThan(0);
      const body = tracks.map((r) => r.body).join('\n');
      expect(body).toContain('clubhouse.app.sessions');
      expect(body).toContain('00000000-0000-4000-8000-0000000000e2');
      expectNoMachineIdentifiers(mock.received);
      // Only the configured endpoint's ingestion path was ever hit.
      for (const r of mock.received) expect(r.url.startsWith('/v2.1/track')).toBe(true);

      // The seeded file is the Phase 1 shape with a plaintext secret. Once
      // secure storage takes it, the plaintext is wiped from the settings file.
      const dir = launched.userDataDir!;
      const settingsText = await fs.promises.readFile(path.join(dir, 'telemetry-settings.json'), 'utf-8');
      if (fs.existsSync(path.join(dir, 'telemetry-secret.bin'))) {
        expect(settingsText).not.toContain('InstrumentationKey');
        expect(JSON.parse(settingsText).destination).toBe('azure');
      }
    } finally {
      delete process.env.CLUBHOUSE_TELEMETRY_TEST_AZURE_HOST;
      if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = prevCa;
      await launched?.electronApp.close().catch(() => {});
      mock.server.close();
      fs.rmSync(caDir, { recursive: true, force: true });
      if (launched?.userDataDir) fs.rmSync(launched.userDataDir, { recursive: true, force: true });
    }
  });

  test('flag on but not enabled: nothing exported and no install id created', async () => {
    const { electronApp, window, userDataDir } = await launchApp({ experimental: { telemetry: true } });
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
