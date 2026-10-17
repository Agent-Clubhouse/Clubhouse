import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TELEMETRY_SETTINGS } from '../../shared/settings-definitions';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  secrets: {} as { connectionString?: string; otlpHeaders?: Record<string, string> },
  storage: 'available' as 'available' | 'weak' | 'unavailable',
  running: false,
  experiment: true,
  calls: [] as string[],
  /** Destination ids the fake runtime is exporting to. */
  active: [] as string[],
  /** Destination ids that fail to start, with their reason. */
  startErrors: {} as Record<string, string>,
}));

type Entry = { id: string; kind: string; enabled: boolean; level: string; preset: string; confirmedHost?: string; otlp?: { endpoint: string; headerNames: string[]; temporality: string } };
const entries = () => state.settings.destinations as Entry[];
const entry = (id: string) => entries().find((d) => d.id === id)!;
function setEntry(id: string, patch: Partial<Entry>): void {
  state.settings = { ...state.settings, destinations: entries().map((d) => (d.id === id ? { ...d, ...patch } : d)) };
}
const syncActive = () => {
  state.active = (state.settings.destinations as Entry[]).filter((d) => d.enabled && !state.startErrors[d.id]).map((d) => d.id);
};

vi.mock('./settings', async (importActual) => {
  const actual = await importActual<typeof import('./settings')>();
  return {
    ...actual,
    getTelemetrySettings: () => state.settings,
    updateTelemetrySettings: async (fn: (s: Record<string, unknown>) => Record<string, unknown>) => {
      state.settings = fn(state.settings);
      return state.settings;
    },
    isExperimentEnabled: () => state.experiment,
    migrateLegacySecrets: async () => true,
  };
});

vi.mock('./secret-store', () => ({
  readSecrets: async () => state.secrets,
  updateSecrets: async (fn: (s: typeof state.secrets) => typeof state.secrets) => {
    state.secrets = JSON.parse(JSON.stringify(fn(state.secrets)));
    return state.secrets;
  },
  getSecureStorageState: () => state.storage,
}));

vi.mock('./bootstrap', () => ({
  isRunning: () => state.running,
  getLastStartError: () => undefined,
  getDestinationStartError: (id: string) => state.startErrors[id],
  getActiveDestinations: () => state.active.map((id) => ({ id, kind: id })),
  describeDestinationError: (r: string) => `error:${r}`,
  enableTelemetry: async () => {
    state.calls.push('enable');
    state.running = true;
    syncActive();
    return true;
  },
  restartTelemetry: async (o?: { clearOffline?: boolean }) => {
    state.calls.push(`restart:${o?.clearOffline ? 'clear' : 'keep'}`);
    syncActive();
    return true;
  },
  disableTelemetry: async () => {
    state.calls.push('disable');
    state.running = false;
    state.active = [];
  },
  sendTestEvent: async (id: string) => ({ ok: false, exports: [{ signal: 'traces', destination: id, ok: false, at: 1, httpStatus: 404 }] }),
}));

vi.mock('./offline', () => ({
  countOfflineItems: async () => 3,
  getOfflineDir: () => '/tmp/none',
  deleteOfflineData: async () => {},
}));

import * as control from './control';
import { notifyFramebriarConnectionChanged, setFramebriarTelemetrySource } from './destinations/framebriar-source';

const HOST = 'westus2-1.in.applicationinsights.azure.com';
const CS = 'InstrumentationKey=00000000-0000-4000-8000-00000000abcd;IngestionEndpoint=https://westus2-1.in.applicationinsights.azure.com/';

beforeEach(() => {
  state.settings = { ...TELEMETRY_SETTINGS.defaults };
  state.secrets = {};
  state.storage = 'available';
  state.running = false;
  state.experiment = true;
  state.calls = [];
  state.active = [];
  state.startErrors = {};
});

describe('telemetry settings control', () => {
  it('masks the connection string in status: last four of the key plus the host', async () => {
    await control.saveAzureConnectionString(CS);
    const status = await control.getStatus();
    expect(status.azure).toEqual({ configured: true, ikeyLast4: 'abcd', host: 'westus2-1.in.applicationinsights.azure.com' });
    expect(JSON.stringify(status)).not.toContain('00000000-0000-4000-8000-00000000abcd');
    expect(status.offlineItems).toBe(3);
  });

  it('rejects bare instrumentation keys and non-App Insights hosts with plain explanations', async () => {
    const bare = await control.saveAzureConnectionString('00000000-0000-4000-8000-00000000abcd');
    expect(bare).toMatchObject({ ok: false, reason: 'bare_instrumentation_key' });
    expect((bare as { message: string }).message).toMatch(/retired in 2025/);
    const other = await control.saveAzureConnectionString('InstrumentationKey=00000000-0000-4000-8000-00000000abcd;IngestionEndpoint=https://collector.example.com/');
    expect(other).toMatchObject({ ok: false, reason: 'not_azure_ingestion_host' });
    expect(state.secrets).toEqual({});
  });

  it('asks before storing secrets with weak Linux storage, and remembers the answer', async () => {
    state.storage = 'weak';
    expect(await control.saveAzureConnectionString(CS)).toMatchObject({ ok: false, reason: 'needs_confirmation', needs: ['weak_storage'] });
    expect(state.secrets).toEqual({});
    expect(await control.saveAzureConnectionString(CS, { weakStorage: true })).toMatchObject({ ok: true });
    expect(state.settings.weakStorageAccepted).toBe(true);
    expect(state.secrets.connectionString).toBe(CS);
  });

  it('refuses to save secrets when secure storage is unavailable', async () => {
    state.storage = 'unavailable';
    expect(await control.saveAzureConnectionString(CS)).toMatchObject({ ok: false, reason: 'secure_storage_unavailable' });
  });

  it('asks for consent the first time, then starts at the configured level', async () => {
    await control.saveAzureConnectionString(CS);
    // One dialog: consent, naming the host (which also confirms it).
    expect(await control.setEnabled('azure', true)).toMatchObject({ ok: false, needs: ['consent', 'destination'], hosts: [HOST] });
    expect(state.calls).toEqual([]);
    expect(await control.setEnabled('azure', true, { consent: true })).toMatchObject({ ok: false, needs: ['destination'] });
    expect(await control.setEnabled('azure', true, { consent: true, host: HOST })).toMatchObject({ ok: true });
    expect(state.settings).toMatchObject({ consentVersion: 1 });
    expect(entry('azure')).toMatchObject({ enabled: true, level: 'standard', preset: 'all' });
    expect(entry('otlp').enabled).toBe(false);
    expect(state.calls).toEqual(['enable']);
  });

  it('lists every host that will receive data in the consent step', async () => {
    state.secrets.connectionString = CS;
    setEntry('azure', { enabled: true });
    await control.saveOtlpConfig({ endpoint: 'https://otlp.example.com', headers: [] });
    // Consent isn't recorded yet, so nothing is exporting. Azure is already
    // switched on, so consenting while turning OTLP on starts both: the
    // dialog names both hosts.
    const first = await control.setEnabled('otlp', true);
    expect(first).toMatchObject({
      ok: false, needs: ['consent', 'destination'], host: 'otlp.example.com',
      hosts: ['westus2-1.in.applicationinsights.azure.com', 'otlp.example.com'],
    });
    expect(await control.setEnabled('otlp', true, { consent: true, host: 'otlp.example.com' })).toMatchObject({ ok: true });
    setEntry('azure', { enabled: false });
    state.settings.consentVersion = 0;
    const both = await control.setEnabled('azure', true);
    expect(both).toMatchObject({ needs: ['consent', 'destination'], hosts: ['otlp.example.com', HOST] });
    expect(await control.setEnabled('azure', true, { consent: true, host: HOST })).toMatchObject({ ok: true });
    expect(entries().filter((d) => d.enabled).map((d) => d.id)).toEqual(['azure', 'otlp']);
  });

  it('requires confirming the OTLP host on first use and after it changes', async () => {
    state.settings.consentVersion = 1;
    expect(await control.saveOtlpConfig({ endpoint: 'https://otlp.example.com', headers: [{ name: 'x-api-key', value: 'k1234' }] })).toMatchObject({ ok: true });
    expect(await control.setEnabled('otlp', true)).toMatchObject({ ok: false, needs: ['destination'], host: 'otlp.example.com' });
    expect(await control.setEnabled('otlp', true, { host: 'otlp.example.com' })).toMatchObject({ ok: true });

    // Header values come back masked; an omitted value keeps the stored one.
    const status = await control.getStatus();
    expect(status.otlp.headers).toEqual([{ name: 'x-api-key', last4: '1234' }]);
    expect(await control.saveOtlpConfig({ endpoint: 'https://otlp.example.com', headers: [{ name: 'x-api-key' }] })).toMatchObject({ ok: true });
    expect(state.secrets.otlpHeaders).toEqual({ 'x-api-key': 'k1234' });

    // Changing the host of the running export needs a fresh confirmation, and clears the queue.
    expect(await control.saveOtlpConfig({ endpoint: 'https://other.example.net', headers: [] })).toMatchObject({
      ok: false, needs: ['destination'], host: 'other.example.net',
    });
    expect(entry('otlp').otlp?.endpoint).toBe('https://otlp.example.com');
    expect(await control.saveOtlpConfig({ endpoint: 'https://other.example.net', headers: [] }, { host: 'other.example.net' })).toMatchObject({ ok: true });
    // OTLP has no offline queue, so a new host only needs a restart.
    expect(state.calls.at(-1)).toBe('restart:keep');
  });

  it('adds a second destination alongside the first instead of switching', async () => {
    state.settings = { ...state.settings, consentVersion: 1 };
    setEntry('azure', { enabled: true });
    state.secrets.connectionString = CS;
    state.running = true;
    state.active = ['azure'];
    await control.saveOtlpConfig({ endpoint: 'http://localhost:4318', headers: [] });
    expect(await control.setEnabled('otlp', true)).toMatchObject({ ok: false, needs: ['destination'], host: 'localhost:4318' });
    expect(await control.setEnabled('otlp', true, { host: 'localhost:4318' })).toMatchObject({ ok: true });
    expect(entries().filter((d) => d.enabled).map((d) => d.id)).toEqual(['azure', 'otlp']);
    // Azure keeps its queue: nothing about its resource changed.
    expect(state.calls).toEqual(['restart:keep']);
    const status = await control.getStatus();
    expect(status.destinations.map((d) => [d.id, d.enabled, d.active])).toEqual([['azure', true, true], ['otlp', true, true], ['framebriar', false, false]]);

    // Turning one off leaves the other running; turning Azure off drops its queue.
    expect(await control.setEnabled('azure', false)).toMatchObject({ ok: true });
    expect(state.calls.at(-1)).toBe('restart:clear');
    expect(state.active).toEqual(['otlp']);
    expect(await control.setEnabled('otlp', false)).toMatchObject({ ok: true });
    expect(state.calls.at(-1)).toBe('disable');
  });

  it('confirms Azure (a non-OTLP kind) when it is added second, so nothing new sends without a dialog', async () => {
    state.settings = { ...state.settings, consentVersion: 1 };
    await control.saveOtlpConfig({ endpoint: 'http://localhost:4318', headers: [] });
    expect(await control.setEnabled('otlp', true, { host: 'localhost:4318' })).toMatchObject({ ok: true });
    await control.saveAzureConnectionString(CS);
    const second = await control.setEnabled('azure', true);
    expect(second).toMatchObject({
      ok: false, needs: ['destination'], host: 'westus2-1.in.applicationinsights.azure.com',
      hosts: ['localhost:4318', 'westus2-1.in.applicationinsights.azure.com'],
    });
    expect(entry('azure').enabled).toBe(false);
    expect(await control.setEnabled('azure', true, { host: 'westus2-1.in.applicationinsights.azure.com' })).toMatchObject({ ok: true });
    expect(entry('azure').confirmedHost).toBe('westus2-1.in.applicationinsights.azure.com');
  });

  it('asks again before a running Azure destination sends to a different resource host', async () => {
    state.settings = { ...state.settings, consentVersion: 1 };
    await control.saveAzureConnectionString(CS);
    expect(await control.setEnabled('azure', true, { host: 'westus2-1.in.applicationinsights.azure.com' })).toMatchObject({ ok: true });
    const other = 'InstrumentationKey=00000000-0000-4000-8000-00000000ffff;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/';
    expect(await control.saveAzureConnectionString(other)).toMatchObject({ ok: false, needs: ['destination'], host: 'eastus-8.in.applicationinsights.azure.com' });
    expect(state.secrets.connectionString).toBe(CS);
    expect(await control.saveAzureConnectionString(other, { host: 'eastus-8.in.applicationinsights.azure.com' })).toMatchObject({ ok: true });
    expect(entry('azure').confirmedHost).toBe('eastus-8.in.applicationinsights.azure.com');
    expect(state.calls.at(-1)).toBe('restart:clear');
  });

  it('changes one destination\'s filter while another fails to start, and shows that failure under it', async () => {
    state.settings = { ...state.settings, consentVersion: 1 };
    setEntry('azure', { enabled: true, confirmedHost: 'westus2-1.in.applicationinsights.azure.com' });
    setEntry('otlp', { enabled: true, confirmedHost: 'o.example', otlp: { endpoint: 'https://o.example', headerNames: [], temporality: 'cumulative' } });
    state.secrets.connectionString = CS;
    state.startErrors = { otlp: 'The endpoint is not a valid URL.' };
    state.running = true;
    syncActive();
    expect(await control.setFilter('azure', 'detailed', 'all')).toMatchObject({ ok: true });
    expect(state.calls).toEqual(['restart:keep']);
    const status = await control.getStatus();
    const byId = Object.fromEntries(status.destinations.map((d) => [d.id, d]));
    expect(byId.azure).toMatchObject({ active: true, level: 'detailed' });
    expect(byId.otlp).toMatchObject({ enabled: true, active: false, health: { state: 'error', message: 'The endpoint is not a valid URL.' } });
  });

  it('sets each destination its own level and preset', async () => {
    state.running = true;
    expect(await control.setFilter('otlp', 'errors', 'user_activity')).toMatchObject({ ok: true });
    expect(entry('otlp')).toMatchObject({ level: 'errors', preset: 'user_activity' });
    expect(entry('azure')).toMatchObject({ level: 'standard', preset: 'all' });
    expect(state.calls).toEqual(['restart:keep']);
    expect(await control.setFilter('otlp', 'loud' as never, 'all')).toMatchObject({ ok: false, reason: 'invalid_level' });
    expect(await control.setFilter('otlp', 'standard', 'nope' as never)).toMatchObject({ ok: false, reason: 'invalid_preset' });
    expect(await control.setFilter('pigeon', 'standard', 'all')).toMatchObject({ ok: false, reason: 'unknown_destination' });
  });

  it('validates OTLP headers and endpoints', async () => {
    expect(await control.saveOtlpConfig({ endpoint: 'http://otlp.example.com', headers: [] })).toMatchObject({ reason: 'https_required' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'Host', value: 'x' }] })).toMatchObject({ reason: 'reserved_header_name' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'bad name', value: 'x' }] })).toMatchObject({ reason: 'invalid_header_name' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'a' }] })).toMatchObject({ reason: 'missing_header_value' });
    expect(await control.saveOtlpConfig({ endpoint: 'https://o.example', headers: [{ name: 'a', value: '1' }, { name: 'A', value: '2' }] })).toMatchObject({ reason: 'duplicate_header_name' });
  });

  it('is unavailable without the experimental flag', async () => {
    state.experiment = false;
    state.secrets.connectionString = CS;
    expect(await control.setEnabled('azure', true, { consent: true })).toMatchObject({ ok: false, reason: 'not_available' });
  });

  it('restarts a running export when the filter, advanced settings or install id change', async () => {
    state.running = true;
    await control.setFilter('azure', 'errors', 'all');
    await control.setAdvanced({ sampleRate: 0.5, otlpTemporality: 'delta' });
    const before = state.settings.installId;
    await control.resetInstallId();
    expect(state.settings).toMatchObject({ sampleRate: 0.5 });
    expect(entry('azure').level).toBe('errors');
    expect(entry('otlp').otlp?.temporality).toBe('delta');
    expect(state.settings.installId).not.toBe(before);
    expect(state.settings.hashSalt).toBeDefined();
    expect(state.calls).toEqual(['restart:keep', 'restart:keep', 'restart:clear']);
    expect(await control.setAdvanced({ sampleRate: 2 })).toMatchObject({ ok: false, reason: 'invalid_sample_rate' });
  });

  it('shows a Phase 1 file without recorded consent as off, and asks for consent to turn it on', async () => {
    state.settings = { ...state.settings, consentVersion: 0 };
    setEntry('azure', { enabled: true });
    state.secrets.connectionString = CS;
    expect((await control.getStatus()).enabled).toBe(false);
    expect(await control.setEnabled('azure', true)).toMatchObject({ ok: false, needs: ['consent', 'destination'] });
    expect(await control.setEnabled('azure', true, { consent: true, host: HOST })).toMatchObject({ ok: true });
    expect(state.calls).toEqual(['enable']);
    expect((await control.getStatus()).enabled).toBe(true);
  });

  it('clearing a destination also removes an unmigrated Phase 1 plaintext secret', async () => {
    state.settings = { ...state.settings, legacyDestination: { kind: 'azure', connectionString: CS } };
    await control.clearOtlpConfig();
    expect(state.settings.legacyDestination).toBeDefined();
    await control.clearAzureConnectionString();
    expect(state.settings.legacyDestination).toBeUndefined();
    expect(JSON.stringify(state.settings)).not.toContain('InstrumentationKey');
  });

  it('turns off and removes local data', async () => {
    state.settings = { ...state.settings, installId: 'x' };
    setEntry('azure', { enabled: true });
    setEntry('otlp', { enabled: true });
    await control.deleteLocalData();
    expect(entries().some((d) => d.enabled)).toBe(false);
    expect(state.calls).toEqual(['disable']);
  });

  it('sends the test event to one destination and explains its failures', async () => {
    state.running = true;
    state.active = ['otlp'];
    expect(await control.sendTest('otlp')).toMatchObject({ ok: false, httpStatus: 404, message: expect.stringMatching(/base path/) });
    // A destination that isn't exporting can't be tested.
    expect(await control.sendTest('azure')).toMatchObject({ ok: false, message: expect.stringMatching(/Turn this destination on/) });
    expect(control.describeTestFailure({ signal: 'logs', ok: false, at: 0, httpStatus: 403 }, 'azure')).toMatch(/Local authentication/);
    expect(control.describeTestFailure({ signal: 'logs', ok: false, at: 0, httpStatus: 415 }, 'otlp')).toMatch(/JSON/);
    expect(control.describeTestFailure({ signal: 'logs', ok: false, at: 0, errorCode: 'ENOTFOUND' }, 'otlp')).toMatch(/resolve/);
    state.running = false;
    expect(await control.sendTest('otlp')).toMatchObject({ ok: false, message: expect.stringMatching(/Turn this destination on/) });
  });
});

describe('Framebriar destination follows Feedback', () => {
  const HOST = 'framebriar.example.net';
  const FB = {
    host: HOST,
    options: (signal: string) => ({ url: `https://${HOST}/api/v1/otlp/v1/${signal}`, headers: async () => ({ authorization: 'Bearer t' }) }),
    sessionId: 's-abc',
  };
  let connected = false;
  type FbEntry = Entry & { framebriar?: { autoEnabled: boolean; userOff: boolean } };
  const fbEntry = () => entry('framebriar') as FbEntry;

  beforeEach(() => {
    connected = false;
    setFramebriarTelemetrySource(() => (connected ? FB : null));
  });

  async function exportOnWithAzure() {
    await control.saveAzureConnectionString(CS);
    await control.setEnabled('azure', true, { consent: true, host: 'westus2-1.in.applicationinsights.azure.com' });
  }

  it('defaults to off with the "User activity and errors" filter', () => {
    expect(fbEntry()).toMatchObject({ enabled: false, preset: 'user_activity', framebriar: { autoEnabled: false, userOff: false } });
  });

  it('stays off when Feedback connects with an unconfirmed host, and asks to confirm it', async () => {
    await exportOnWithAzure();
    connected = true;
    notifyFramebriarConnectionChanged();
    await control.syncFramebriarDestination();
    expect(fbEntry().enabled).toBe(false);
    expect(state.active).toEqual(['azure']);
    // Turning it on (the Feedback page's prompt, or its panel) needs the host confirmed.
    expect(await control.setEnabled('framebriar', true)).toMatchObject({
      ok: false, needs: ['destination'], host: HOST, hosts: ['westus2-1.in.applicationinsights.azure.com', HOST],
    });
    expect(fbEntry().enabled).toBe(false);
    expect(await control.setEnabled('framebriar', true, { host: HOST })).toMatchObject({ ok: true });
    expect(fbEntry()).toMatchObject({ enabled: true, confirmedHost: HOST });
  });

  it('declining keeps it off for good, and Feedback is unaffected', async () => {
    await exportOnWithAzure();
    connected = true;
    await control.setEnabled('framebriar', false);
    expect(fbEntry()).toMatchObject({ enabled: false, framebriar: { userOff: true } });
    await control.syncFramebriarDestination();
    expect(fbEntry().enabled).toBe(false);
    expect(state.active).toEqual(['azure']);
  });

  it('follows Feedback automatically once its host is confirmed', async () => {
    await exportOnWithAzure();
    setEntry('framebriar', { confirmedHost: HOST });
    connected = true;
    await control.syncFramebriarDestination();
    expect(fbEntry()).toMatchObject({ enabled: true, framebriar: { autoEnabled: true } });
    expect(state.active).toContain('framebriar');
    connected = false;
    await control.syncFramebriarDestination();
    expect(fbEntry()).toMatchObject({ enabled: false, framebriar: { autoEnabled: false } });
    // Reconnecting turns it back on without asking: the host was confirmed.
    connected = true;
    await control.syncFramebriarDestination();
    expect(fbEntry().enabled).toBe(true);
  });

  it('never follows a host that changed since it was confirmed', async () => {
    await exportOnWithAzure();
    setEntry('framebriar', { confirmedHost: 'old.example.net' });
    connected = true;
    await control.syncFramebriarDestination();
    expect(fbEntry().enabled).toBe(false);
  });

  it('names Framebriar in the consent for export, and confirming there confirms it too', async () => {
    connected = true;
    await control.saveAzureConnectionString(CS);
    const ask = await control.setEnabled('azure', true);
    expect(ask).toMatchObject({ ok: false, needs: ['consent', 'destination'], hosts: ['westus2-1.in.applicationinsights.azure.com', HOST] });
    await control.setEnabled('azure', true, { consent: true, host: 'westus2-1.in.applicationinsights.azure.com' });
    expect(fbEntry()).toMatchObject({ enabled: true, confirmedHost: HOST, framebriar: { autoEnabled: true } });
    // Export off: it follows.
    await control.setEnabled('azure', false);
    expect(fbEntry().enabled).toBe(false);
  });

  it('asks again when turning another destination on would bring an unconfirmed Framebriar along', async () => {
    await control.saveAzureConnectionString(CS);
    await control.setEnabled('azure', true, { consent: true, host: 'westus2-1.in.applicationinsights.azure.com' });
    await control.setEnabled('azure', false);
    connected = true;
    // Consent is on record and Azure's host is confirmed, but Framebriar's isn't: the dialog shows.
    expect(await control.setEnabled('azure', true)).toMatchObject({ ok: false, needs: ['destination'], hosts: ['westus2-1.in.applicationinsights.azure.com', HOST] });
  });

  it('stays off without consent or another enabled destination', async () => {
    connected = true;
    setEntry('framebriar', { confirmedHost: HOST });
    await control.syncFramebriarDestination();
    expect(fbEntry().enabled).toBe(false);
    state.settings.consentVersion = 1;
    await control.syncFramebriarDestination();
    expect(fbEntry().enabled).toBe(false);
  });

  it('an explicit On survives export going off', async () => {
    await exportOnWithAzure();
    connected = true;
    expect(await control.setEnabled('framebriar', true, { host: HOST })).toMatchObject({ ok: true });
    expect(fbEntry()).toMatchObject({ enabled: true, framebriar: { autoEnabled: false, userOff: false } });
    await control.setEnabled('azure', false);
    expect(fbEntry().enabled).toBe(true);
  });

  it('explains what to do when Feedback is not connected', async () => {
    await exportOnWithAzure();
    expect(await control.setEnabled('framebriar', true)).toMatchObject({ ok: false, reason: 'not_configured', message: 'Connect Feedback in Settings, Feedback first.' });
    const status = await control.getStatus();
    expect(status.destinations.find((d) => d.id === 'framebriar')).toMatchObject({ label: 'Clubhouse developer (Framebriar)', configured: false, enabled: false });
  });

  it('restarts export when Feedback connects after telemetry started without it', async () => {
    await exportOnWithAzure();
    setEntry('framebriar', { enabled: true, confirmedHost: HOST });
    state.calls = [];
    connected = true;
    await control.syncFramebriarDestination();
    expect(state.calls).toEqual(['restart:keep']);
  });
});

describe('start() host guard', () => {
  it('refuses an unconfirmed or changed host, but adopts a lone destination from before hosts were recorded', async () => {
    const { checkConfirmedHost } = await vi.importActual<typeof import('./bootstrap')>('./bootstrap');
    expect(checkConfirmedHost('a.example', 'a.example', 2)).toBe('ok');
    expect(checkConfirmedHost(undefined, 'a.example', 1)).toBe('adopt');
    expect(checkConfirmedHost(undefined, 'a.example', 2)).toBe('refuse');
    expect(checkConfirmedHost('old.example', 'a.example', 1)).toBe('refuse');
  });
});
