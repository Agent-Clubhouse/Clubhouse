import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from 'electron';
import { normalizeLevel, normalizeSampleRate, parseConnectionString, TEST_AZURE_HOST_ENV, validateDestination } from './settings';
import { countOfflineItems, pruneOfflineDir } from './offline';
import { createIdentity, hashId, isValidIdentity } from './ids';
import { buildResourceAttributes, channelForVersion, majorMinor, RESOURCE_KEYS } from './resource';

const IKEY = '00000000-0000-4000-8000-000000000001';

describe('validateDestination', () => {
  it('accepts an App Insights connection string and reports the ingestion host', () => {
    const r = validateDestination({
      kind: 'azure',
      connectionString: `InstrumentationKey=${IKEY};IngestionEndpoint=https://westus2-1.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/`,
    });
    expect(r).toMatchObject({ ok: true, host: 'westus2-1.in.applicationinsights.azure.com' });
  });

  it.each([
    'https://chinaeast2-0.in.applicationinsights.azure.cn/',
    'https://usgovvirginia-1.in.applicationinsights.azure.us/',
    'https://dc.applicationinsights.us/',
  ])('accepts sovereign-cloud ingestion host %s', (endpoint) => {
    expect(validateDestination({ kind: 'azure', connectionString: `InstrumentationKey=${IKEY};IngestionEndpoint=${endpoint}` }).ok).toBe(true);
  });

  it('only allows the test ingestion host override for the exact host:port in unpackaged builds', () => {
    const cs = `InstrumentationKey=${IKEY};IngestionEndpoint=https://127.0.0.1:4443/`;
    expect(validateDestination({ kind: 'azure', connectionString: cs })).toEqual({ ok: false, reason: 'not_azure_ingestion_host' });
    process.env[TEST_AZURE_HOST_ENV] = '127.0.0.1:4443';
    try {
      expect(validateDestination({ kind: 'azure', connectionString: cs }).ok).toBe(true);
      expect(validateDestination({ kind: 'azure', connectionString: cs.replace('4443', '4444') }).ok).toBe(false);
      (app as { isPackaged: boolean }).isPackaged = true;
      expect(validateDestination({ kind: 'azure', connectionString: cs }).ok).toBe(false);
    } finally {
      (app as { isPackaged: boolean }).isPackaged = false;
      delete process.env[TEST_AZURE_HOST_ENV];
    }
  });

  it.each([
    [`InstrumentationKey=${IKEY}`, 'missing_ingestion_endpoint'],
    [`InstrumentationKey=${IKEY};IngestionEndpoint=https://collector.example.com/`, 'not_azure_ingestion_host'],
    [`InstrumentationKey=${IKEY};IngestionEndpoint=https://applicationinsights.azure.com.evil.io/`, 'not_azure_ingestion_host'],
    ['IngestionEndpoint=https://x.example', 'invalid_instrumentation_key'],
    [`InstrumentationKey=not-a-key;IngestionEndpoint=https://x.example`, 'invalid_instrumentation_key'],
    [`InstrumentationKey=${IKEY};IngestionEndpoint=http://westus2-1.in.applicationinsights.azure.com`, 'https_required'],
  ])('rejects connection string %j', (cs, reason) => {
    expect(validateDestination({ kind: 'azure', connectionString: cs })).toEqual({ ok: false, reason });
  });

  it('requires HTTPS for OTLP except to loopback', () => {
    expect(validateDestination({ kind: 'otlp', endpoint: 'https://otlp.example.com:4318' })).toMatchObject({ ok: true, host: 'otlp.example.com:4318' });
    expect(validateDestination({ kind: 'otlp', endpoint: 'http://127.0.0.1:4318' })).toMatchObject({ ok: true });
    expect(validateDestination({ kind: 'otlp', endpoint: 'http://otlp.example.com' })).toEqual({ ok: false, reason: 'https_required' });
    expect(validateDestination({ kind: 'otlp', endpoint: 'https://user:pw@otlp.example.com' })).toEqual({ ok: false, reason: 'credentials_in_url' });
    expect(validateDestination({ kind: 'otlp', endpoint: 'not a url' })).toEqual({ ok: false, reason: 'invalid_url' });
  });

  it('validates OTLP header names', () => {
    expect(validateDestination({ kind: 'otlp', endpoint: 'https://o.example', headers: { 'x-api-key': 'v' } }).ok).toBe(true);
    expect(validateDestination({ kind: 'otlp', endpoint: 'https://o.example', headers: { 'bad header': 'v' } })).toEqual({ ok: false, reason: 'invalid_header_name' });
    expect(validateDestination({ kind: 'otlp', endpoint: 'https://o.example', headers: { Host: 'evil' } })).toEqual({ ok: false, reason: 'reserved_header_name' });
  });

  it('rejects a missing destination', () => {
    expect(validateDestination(null)).toEqual({ ok: false, reason: 'missing_destination' });
  });

  it('parses connection strings case-insensitively', () => {
    expect(parseConnectionString('instrumentationkey=a; IngestionEndpoint = https://b ;;junk')).toEqual({
      instrumentationkey: 'a',
      ingestionendpoint: 'https://b',
    });
  });

  it('normalizes level and sample rate', () => {
    expect(normalizeLevel('detailed')).toBe('detailed');
    expect(normalizeLevel('verbose')).toBe('standard');
    expect(normalizeSampleRate(0.5)).toBe(0.5);
    expect(normalizeSampleRate(0)).toBe(1);
    expect(normalizeSampleRate('1')).toBe(1);
  });
});

describe('identity', () => {
  it('creates a random v4 install id and a 32-byte salt', () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(isValidIdentity(a)).toBe(true);
    expect(a.installId).not.toBe(b.installId);
    expect(a.hashSalt).not.toBe(b.hashSalt);
    expect(isValidIdentity({ installId: 'x', hashSalt: a.hashSalt })).toBe(false);
  });

  it('hashes ids to 16 hex chars, stable per salt and different across salts', () => {
    const s1 = Buffer.alloc(32, 1);
    const s2 = Buffer.alloc(32, 2);
    expect(hashId(s1, 'proj_1_abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashId(s1, 'proj_1_abc')).toBe(hashId(s1, 'proj_1_abc'));
    expect(hashId(s1, 'proj_1_abc')).not.toBe(hashId(s2, 'proj_1_abc'));
  });
});

describe('resource attributes', () => {
  const attrs = buildResourceAttributes({
    appVersion: '0.43.0-beta.1',
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.26100',
    nodeVersion: '22.11.0',
    electronVersion: '43.0.0',
    installId: IKEY,
    instanceId: 'run-1',
    annexRole: 'none',
    uiChrome: 'legacy',
  });

  it('sets exactly the documented keys, with service.instance.id explicit', () => {
    expect(Object.keys(attrs).sort()).toEqual([...RESOURCE_KEYS].sort());
    // Each destination stamps its own level on its items; the shared resource carries none.
    expect(attrs).not.toHaveProperty('clubhouse.telemetry.level');
    expect(attrs['service.instance.id']).toBe('run-1');
    expect(attrs['enduser.pseudo.id']).toBe(IKEY);
  });

  it('never carries hostname, args, executable path or owner', () => {
    const serialized = JSON.stringify(attrs);
    expect(serialized).not.toContain(os.hostname());
    for (const banned of ['host.name', 'os.description', 'process.command_args', 'process.executable.path', 'process.owner', 'service.namespace']) {
      expect(attrs).not.toHaveProperty(banned);
    }
  });

  it('maps platform, arch, channel and OS version', () => {
    expect(attrs).toMatchObject({ 'os.type': 'windows', 'host.arch': 'amd64', 'os.version': '10.0', 'clubhouse.channel': 'preview', 'deployment.environment.name': 'production' });
    expect(majorMinor('25.5.0')).toBe('25.5');
    expect(majorMinor('garbage')).toBe('unknown');
    expect(channelForVersion('0.43.0')).toBe('stable');
  });
});

describe('pruneOfflineDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-offline-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function file(rel: string, bytes: number, ageMs: number, now: number): Promise<void> {
    const full = path.join(dir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, Buffer.alloc(bytes));
    const t = new Date(now - ageMs);
    await fsp.utimes(full, t, t);
  }

  it('deletes expired files, then the oldest until under the size budget', async () => {
    const now = Date.now();
    await file('Microsoft-AzureMonitor-x/q/1.ai.json', 10, 50 * 3600_000, now); // expired
    await file('Microsoft-AzureMonitor-x/q/2.ai.json', 400, 3 * 3600_000, now);
    await file('Microsoft-AzureMonitor-x/q/3.ai.json', 400, 2 * 3600_000, now);
    await file('Microsoft-AzureMonitor-x/q/4.ai.json', 400, 1 * 3600_000, now);
    const r = await pruneOfflineDir(dir, { maxBytes: 900, now });
    expect(r).toEqual({ deletedFiles: 2, remainingBytes: 800, remainingFiles: 2 });
    expect(await countOfflineItems(dir)).toBe(2);
  });

  it('tolerates a missing directory', async () => {
    expect(await pruneOfflineDir(path.join(dir, 'nope'))).toEqual({ deletedFiles: 0, remainingBytes: 0, remainingFiles: 0 });
  });
});
