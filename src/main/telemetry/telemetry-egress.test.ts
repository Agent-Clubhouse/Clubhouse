/**
 * Egress allowlist (spec §6.7, release blocker): run each destination through
 * the real bootstrap → lazy chunk → SDK → exporter path against a mock HTTP
 * server, intercept every outbound TCP connection and DNS lookup, and assert
 * that only the configured host is ever contacted. Also checks that the
 * Azure exporter's own Microsoft-bound traffic (Statsbeat, OneSettings) is
 * switched off, and that payloads carry no hostname or home directory.
 */
import { createRequire } from 'module';
import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as net from 'net';
import * as os from 'os';
import * as zlib from 'zlib';
import selfsigned from 'selfsigned';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// The CommonJS dns module object is mutable (the ESM namespace is not) and is
// the one net.connect consults for hostname lookups.
const dnsCjs = createRequire(__filename)('dns') as typeof import('dns');
const originalLookup = dnsCjs.lookup;

interface FakeSettings {
  destinations: Array<Record<string, unknown>>;
  sampleRate: number;
  consentVersion: number;
  installId?: string;
  hashSalt?: string;
  lastVersion?: string;
}

/** Settings with the given destinations enabled (current multi-destination shape). */
function fakeSettings(enabled: { azure?: boolean; otlp?: { endpoint: string; headerNames?: string[] } }): FakeSettings {
  return {
    destinations: [
      { id: 'azure', kind: 'azure', enabled: enabled.azure === true, level: 'standard', preset: 'all' },
      {
        id: 'otlp', kind: 'otlp', enabled: !!enabled.otlp, level: 'standard', preset: 'all',
        otlp: { endpoint: enabled.otlp?.endpoint ?? '', headerNames: enabled.otlp?.headerNames ?? [], temporality: 'cumulative' },
      },
    ],
    sampleRate: 1,
    consentVersion: 1,
  };
}

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  secrets: {} as { connectionString?: string; otlpHeaders?: Record<string, string> },
  logs: [] as string[],
}));

vi.mock('./settings', async (importActual) => {
  const actual = await importActual<typeof import('./settings')>();
  return {
    ...actual,
    getTelemetrySettings: () => state.settings,
    updateTelemetrySettings: async (fn: (s: Record<string, unknown>) => Record<string, unknown>) => {
      state.settings = fn(state.settings);
      return state.settings;
    },
    isExperimentEnabled: () => true,
    hasDestinationConfigured: () => true,
    migrateLegacySecrets: async () => true,
  };
});

vi.mock('./secret-store', () => ({
  readSecrets: async () => state.secrets,
  getSecureStorageState: () => 'available',
  getSecretPath: () => '/nonexistent/telemetry-secret.bin',
}));

vi.mock('../services/log-service', () => ({
  appLog: (_ns: string, level: string, msg: string, opts?: { meta?: unknown }) => {
    state.logs.push(`${level} ${msg} ${JSON.stringify(opts?.meta ?? {})}`);
  },
}));

import { disableTelemetry, getActiveDestinations, initTelemetry, recordAppSession, sendTestEvent, whenStarted } from './bootstrap';
import { tel } from './facade';
import { diag, isDiagActive } from './diag';
import { createAzureExporters, isOneSettingsNeutralized, STATSBEAT_ENV_FLAGS } from './destinations/azure';
import { createOtlpExporters } from './destinations/otlp';
import { TEST_AZURE_HOST_ENV } from './settings';
import { ConfigurationManager } from '../../../node_modules/@azure/monitor-opentelemetry-exporter/dist/commonjs/_configuration/configurationManager.js';

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let httpServer: http.Server;
let httpsServer: https.Server;
let httpPort = 0;
let httpsPort = 0;
/** The port the destination under test is configured for. */
let port = 0;
let certPem = '';
const received: Received[] = [];

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let buf = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
    const body = buf.toString('utf8');
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
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
}

beforeAll(async () => {
  // The Azure exporter always upgrades the ingestion endpoint to HTTPS, so its
  // mock ingestion server needs TLS with a certificate for 127.0.0.1.
  const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048,
    days: 1,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  certPem = pems.cert;
  httpServer = http.createServer(handler);
  httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, handler);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpPort = (httpServer.address() as net.AddressInfo).port;
  httpsPort = (httpsServer.address() as net.AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
});

/** Every outbound TCP target and DNS lookup made while a test runs. */
let connects: Array<{ host: string; port: number }> = [];
let lookups: string[] = [];
const savedProxyEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  received.length = 0;
  connects = [];
  lookups = [];
  state.logs = [];
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'NO_PROXY']) {
    savedProxyEnv[k] = process.env[k];
    delete process.env[k];
  }

  const originalConnect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    // net.connect() passes its normalized [options, cb] array straight through.
    const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    if (typeof first === 'object' && first !== null) {
      const o = first as { host?: string; port?: number | string; path?: string };
      if (o.port !== undefined) connects.push({ host: o.host ?? 'localhost', port: Number(o.port) });
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      connects.push({ host: typeof second === 'string' ? second : 'localhost', port: Number(first) });
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect);

  dnsCjs.lookup = ((hostname: string, ...rest: unknown[]) => {
    lookups.push(hostname);
    return (originalLookup as (...a: unknown[]) => void)(hostname, ...rest);
  }) as typeof dnsCjs.lookup;
});

afterEach(async () => {
  dnsCjs.lookup = originalLookup;
  await disableTelemetry();
  for (const [k, v] of Object.entries(savedProxyEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function assertOnlyConfiguredHost(): void {
  expect(connects.length, 'expected the exporter to connect at least once').toBeGreaterThan(0);
  for (const c of connects) {
    expect(['127.0.0.1', 'localhost']).toContain(c.host);
    expect(c.port).toBe(port);
  }
  for (const h of lookups) expect(['127.0.0.1', 'localhost']).toContain(h);
}

const DIAG_CANARY = 'DIAG-CANARY-2299';

function assertNoMachineIdentifiers(): void {
  const all = received.map((r) => r.body).join('\n');
  // Local-only diag lines (#2299) never reach an exporter.
  expect(all).not.toContain(DIAG_CANARY);
  expect(all).not.toContain(os.hostname());
  expect(all).not.toContain(os.homedir());
  expect(all).not.toContain(JSON.stringify(os.homedir()).slice(1, -1));
}

async function exerciseAllSignals(): Promise<void> {
  initTelemetry();
  expect(await whenStarted()).toBe(true);
  recordAppSession();
  // Recorded locally while the exporter runs, then flushed with it below.
  expect(isDiagActive()).toBe(true);
  diag('core:test', 'error', `${DIAG_CANARY} failed`, { error: new Error(DIAG_CANARY), lastOutput: DIAG_CANARY });
  tel.exception(new Error(`failed reading ${os.homedir()}/secret on ${os.hostname()}`), { origin: 'main', handled: true });
  for (const id of getActiveDestinations().map((d) => d.id)) {
    const result = await sendTestEvent(id, 10_000);
    expect(result.ok).toBe(true);
  }
}

describe('telemetry egress allowlist', () => {
  it('Azure Monitor destination only contacts the configured ingestion endpoint', async () => {
    port = httpsPort;
    process.env[TEST_AZURE_HOST_ENV] = `127.0.0.1:${httpsPort}`;
    onTestFinished(() => {
      delete process.env[TEST_AZURE_HOST_ENV];
    });
    // Trust the mock server's certificate (Node >= 22.19); older runtimes
    // fall back to skipping verification for this test only.
    if (typeof tls.setDefaultCACertificates === 'function') {
      const defaultCAs = tls.getCACertificates('default');
      tls.setDefaultCACertificates([...defaultCAs, certPem]);
      onTestFinished(() => tls.setDefaultCACertificates(defaultCAs));
    } else {
      const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      onTestFinished(() => {
        if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      });
    }
    state.settings = fakeSettings({ azure: true }) as unknown as Record<string, unknown>;
    state.secrets = {
      connectionString: `InstrumentationKey=00000000-0000-4000-8000-000000000001;IngestionEndpoint=https://127.0.0.1:${port}/`,
    };

    await exerciseAllSignals();

    const tracks = received.filter((r) => r.method === 'POST' && r.url.startsWith('/v2.1/track'));
    expect(tracks.length).toBeGreaterThan(0);
    const bodies = tracks.map((r) => r.body).join('\n');
    expect(bodies).toContain('clubhouse.telemetry.test');
    expect(bodies).toContain('clubhouse.app.sessions');
    expect(bodies).toContain('ExceptionData');
    expect(bodies).toContain(state.settings.installId as string);

    expect(isOneSettingsNeutralized()).toBe(true);
    // A later initialize() (e.g. a second exporter) must stay inert.
    ConfigurationManager.getInstance().initialize();
    expect(isOneSettingsNeutralized()).toBe(true);

    assertOnlyConfiguredHost();
    assertNoMachineIdentifiers();
  }, 30_000);

  it('OTLP destination only contacts the configured endpoint, as HTTP/JSON', async () => {
    port = httpPort;
    state.settings = fakeSettings({ otlp: { endpoint: `http://127.0.0.1:${port}`, headerNames: ['x-api-key'] } }) as unknown as Record<string, unknown>;
    state.secrets = { otlpHeaders: { 'x-api-key': 'k' } };

    await exerciseAllSignals();

    const paths = new Set(received.map((r) => r.url));
    expect(paths).toEqual(new Set(['/v1/traces', '/v1/metrics', '/v1/logs']));
    for (const r of received) {
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.headers['x-api-key']).toBe('k');
    }
    expect(received.map((r) => r.body).join('\n')).toContain('clubhouse.app.sessions');

    assertOnlyConfiguredHost();
    assertNoMachineIdentifiers();
  }, 30_000);
});

describe('OTLP loopback hardening', () => {
  it('resolves localhost through the pinned lookup, never the system resolver', async () => {
    port = httpPort;
    state.settings = fakeSettings({ otlp: { endpoint: `http://localhost:${port}` } }) as unknown as Record<string, unknown>;
    state.secrets = {};
    await exerciseAllSignals();
    expect(received.length).toBeGreaterThan(0);
    expect(lookups).toEqual([]);
    for (const c of connects) expect(c.port).toBe(port);
  }, 30_000);

  it("refuses to post into Clubhouse's own loopback ports", async () => {
    const { spanExporter } = createOtlpExporters({ endpoint: `http://127.0.0.1:${httpPort}`, reservedPorts: () => [httpPort] });
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => spanExporter.export([], resolve));
    expect(result.code).not.toBe(0);
    expect(result.error?.message).toContain("Clubhouse's own port");
    expect(received).toEqual([]);
    await spanExporter.shutdown();

    // Control: the same export to a non-reserved port goes through.
    const control = createOtlpExporters({ endpoint: `http://127.0.0.1:${httpPort}`, reservedPorts: () => [1] });
    const ok = await new Promise<{ code: number }>((resolve) => control.spanExporter.export([], resolve));
    expect(ok.code).toBe(0);
    await control.spanExporter.shutdown();
  });
});

describe('Azure exporter self-telemetry', () => {
  it('constructs exporters with Statsbeat tracking off and OneSettings held', () => {
    for (const name of Object.keys(STATSBEAT_ENV_FLAGS)) delete process.env[name];
    const exporters = createAzureExporters({
      connectionString: `InstrumentationKey=00000000-0000-4000-8000-000000000001;IngestionEndpoint=https://127.0.0.1:${httpsPort}/`,
      storageDirectory: os.tmpdir(),
    });
    for (const exporter of [exporters.spanExporter, exporters.metricExporter, exporters.logExporter]) {
      expect((exporter as unknown as { trackStatsbeat: boolean }).trackStatsbeat).toBe(false);
    }
    // Set only while constructing, so agent PTYs never inherit them.
    for (const name of Object.keys(STATSBEAT_ENV_FLAGS)) expect(process.env[name]).toBeUndefined();
    expect(isOneSettingsNeutralized()).toBe(true);
    return Promise.all([exporters.spanExporter.shutdown(), exporters.metricExporter.shutdown(), exporters.logExporter.shutdown()]);
  });
});
