/**
 * Export leaving Experimental (spec §6.8): the one-time migration, run through
 * the real settings stores, the real preview gate and the real init path. Every
 * exporter and SDK chunk is stubbed to fail on load, and counted: loading one is
 * the first step that could send anything, so nothing here is ever sent.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userData = vi.hoisted(() => ({ dir: '' }));
const chunks = vi.hoisted(() => {
  const refuse = () => vi.fn(async () => { throw new Error('no exporters in this test'); });
  return { loadSdk: refuse(), loadAzureDestination: refuse(), loadOtlpDestination: refuse(), loadFramebriarDestination: refuse() };
});

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('../../__mocks__/electron')>('../../__mocks__/electron');
  return { ...actual, app: { ...actual.app, getPath: () => userData.dir } };
});
vi.mock('./lazy-chunks', () => chunks);

import { TELEMETRY_SETTINGS } from '../../shared/settings-definitions';
import * as experimentalSettings from '../services/experimental-settings';
import { resetAllSettingsStoresForTests } from '../services/settings-store';
import { initTelemetry, isTelemetryConfigured, whenStarted } from './bootstrap';
import * as control from './control';
import { setFramebriarTelemetrySource } from './destinations/framebriar-source';
import { _resetLocalRecordingForTests } from './local-control';
import { getOfflineDir } from './offline';
import { getTelemetrySettings, migrateTelemetrySettings, type TelemetrySettings } from './settings';

const SETTINGS_FILE = 'telemetry-settings.json';
const FB_HOST = 'framebriar.example.net';
const LOOPBACK_HOST = '127.0.0.1:9';

const otlp = (enabled: boolean) => ({
  id: 'otlp', kind: 'otlp', enabled, level: 'standard', preset: 'all', confirmedHost: LOOPBACK_HOST,
  otlp: { endpoint: `http://${LOOPBACK_HOST}`, headerNames: [] as string[], temporality: 'cumulative' },
});
const azure = (enabled: boolean) => ({
  id: 'azure', kind: 'azure', enabled, level: 'standard', preset: 'all', confirmedHost: 'westus2-1.in.applicationinsights.azure.com',
});
const framebriar = (patch: { enabled?: boolean; confirmedHost?: string; userOff?: boolean } = {}) => ({
  id: 'framebriar', kind: 'framebriar', enabled: patch.enabled ?? false, level: 'standard', preset: 'user_activity',
  ...(patch.confirmedHost ? { confirmedHost: patch.confirmedHost } : {}),
  framebriar: { userOff: patch.userOff ?? false },
});
const file = (consentVersion: number, ...destinations: object[]) => ({ sampleRate: 1, developerRule: 2, consentVersion, destinations });

const userDataPath = (name: string) => path.join(userData.dir, name);
const writeJson = (name: string, value: unknown) => fs.writeFileSync(userDataPath(name), JSON.stringify(value));
const readText = (name: string) => fs.readFileSync(userDataPath(name), 'utf8');
const readSaved = () => JSON.parse(readText(SETTINGS_FILE)) as TelemetrySettings;

/** What decides eligibility in this unpackaged build: CLUBHOUSE_TEST_STABLE_BUILD makes it follow the opt-in. */
function seedGate(flag: boolean | undefined | 'corrupt', previewEligible: boolean | 'corrupt'): void {
  if (flag === 'corrupt') fs.writeFileSync(userDataPath('experimental-settings.json'), '{not json');
  else if (flag !== undefined) writeJson('experimental-settings.json', { telemetry: flag });
  if (previewEligible === 'corrupt') fs.writeFileSync(userDataPath('update-settings.json'), '{not json');
  else writeJson('update-settings.json', { previewChannel: previewEligible });
}

/** Attempts to start an exporter since the last launch began. */
function exportAttempts(): number {
  return Object.values(chunks).reduce((sum, load) => sum + load.mock.calls.length, 0);
}

/** One run of the app, as far as telemetry's startup goes. */
async function launch(): Promise<void> {
  await _resetLocalRecordingForTests();
  resetAllSettingsStoresForTests();
  for (const load of Object.values(chunks)) load.mockClear();
  initTelemetry();
  await whenStarted();
}

async function launchAndWaitForMarker(): Promise<void> {
  await launch();
  await vi.waitFor(() => expect(readSaved().exportGraduation).toBe(1));
}

/** The stored destinations with `off` applied: what a switched-off setup should hold. */
function expectedOff(raw: Record<string, unknown>, userOff: boolean): TelemetrySettings['destinations'] {
  return migrateTelemetrySettings({ ...raw }).destinations.map((d) => ({
    ...d,
    enabled: false,
    ...(d.kind === 'framebriar' ? { framebriar: { userOff } } : {}),
  }));
}

beforeEach(async () => {
  userData.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-telemetry-graduation-'));
  vi.stubEnv('CLUBHOUSE_TEST_STABLE_BUILD', '1');
  setFramebriarTelemetrySource(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setFramebriarTelemetrySource(null);
  await _resetLocalRecordingForTests();
  resetAllSettingsStoresForTests();
  await fsp.rm(userData.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('a setup the old gate held back ends up off', () => {
  const phase1 = { enabled: true, level: 'standard', sampleRate: 1, destination: { kind: 'otlp', endpoint: `http://${LOOPBACK_HOST}` } };
  const phase2 = { enabled: true, level: 'standard', sampleRate: 1, consentVersion: 1, destination: 'otlp', otlpEndpoint: `http://${LOOPBACK_HOST}`, otlpConfirmedHost: LOOPBACK_HOST };

  const cases: Array<{ name: string; flag: boolean | undefined | 'corrupt'; eligible: boolean | 'corrupt'; raw: Record<string, unknown>; userOff: boolean }> = [
    { name: 'flag saved false with an enabled azure destination', flag: false, eligible: true, raw: file(1, azure(true), otlp(false), framebriar()), userOff: true },
    { name: 'flag missing with recorded consent', flag: undefined, eligible: true, raw: file(1, otlp(true), framebriar()), userOff: true },
    { name: 'flag saved true on a stable build with Preview off (dormant before)', flag: true, eligible: false, raw: file(1, otlp(true), framebriar()), userOff: true },
    { name: 'framebriar confirmed, not userOff, flag off, consent recorded', flag: false, eligible: true, raw: file(1, otlp(false), framebriar({ confirmedHost: FB_HOST })), userOff: true },
    { name: 'framebriar confirmed with no consent, flag off', flag: false, eligible: true, raw: file(0, otlp(false), framebriar({ confirmedHost: FB_HOST })), userOff: true },
    { name: 'framebriar marked enabled and confirmed, flag off', flag: false, eligible: true, raw: file(1, framebriar({ enabled: true, confirmedHost: FB_HOST })), userOff: true },
    { name: 'consent recorded with nothing enabled, flag off', flag: false, eligible: true, raw: file(1, otlp(false), framebriar()), userOff: true },
    { name: 'flag true and eligible, but no consent', flag: true, eligible: true, raw: file(0, otlp(true), framebriar()), userOff: false },
    { name: 'a corrupt experimental file counts as flag off', flag: 'corrupt', eligible: true, raw: file(1, otlp(true), framebriar()), userOff: true },
    { name: 'a corrupt update-settings file counts as Preview off', flag: true, eligible: 'corrupt', raw: file(1, otlp(true), framebriar()), userOff: true },
    { name: 'a Phase 1 file, enabled with no consent', flag: false, eligible: true, raw: phase1, userOff: false },
    { name: 'a Phase 2 file, enabled with consent, flag off', flag: false, eligible: true, raw: phase2, userOff: true },
  ];

  it.each(cases)('$name', async ({ flag, eligible, raw, userOff }) => {
    seedGate(flag, eligible);
    writeJson(SETTINGS_FILE, raw);
    await launchAndWaitForMarker();

    const saved = readSaved();
    expect(saved.destinations).toEqual(expectedOff(raw, userOff));
    expect(saved.consentVersion).toBe(typeof raw.consentVersion === 'number' ? raw.consentVersion : 0);
    expect(isTelemetryConfigured()).toBe(false);
    expect(exportAttempts()).toBe(0);

    // Second launch: no second migration, and the file isn't written.
    const bytes = readText(SETTINGS_FILE);
    await launch();
    expect(readText(SETTINGS_FILE)).toBe(bytes);
    expect(exportAttempts()).toBe(0);
  });

  it('keeps Phase 1 plaintext where it was until the secret move, which still runs', async () => {
    const raw = { enabled: true, level: 'standard', sampleRate: 1, destination: { kind: 'otlp', endpoint: `http://${LOOPBACK_HOST}`, headers: { 'x-k': 'plaintext-value' } } };
    seedGate(false, true);
    writeJson(SETTINGS_FILE, raw);
    await launch();
    expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
    // The move happens after ready; the mock app is ready at once.
    await vi.waitFor(() => expect(readText(SETTINGS_FILE)).not.toContain('plaintext-value'));
    expect(readSaved().exportGraduation).toBe(1);
  });

  it('clears the offline queue, as turning a destination off does', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, file(1, azure(true), framebriar()));
    await fsp.mkdir(getOfflineDir(), { recursive: true });
    await fsp.writeFile(path.join(getOfflineDir(), 'queued.ai.json'), '[]');
    await launchAndWaitForMarker();
    await vi.waitFor(() => expect(fs.existsSync(getOfflineDir())).toBe(false));
  });

  it('does not raise the local recording level for a setup that was held back', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, file(1, { ...otlp(true), level: 'detailed' }, framebriar()));
    await launchAndWaitForMarker();
    await vi.waitFor(() => expect(JSON.parse(readText('logging-settings.json')).telemetryLevelMigrated).toBe(true));
    expect(JSON.parse(readText('logging-settings.json')).telemetryLevel).not.toBe('detailed');
  });
});

describe('a setup left exactly alone', () => {
  const cases: Array<{ name: string; flag: boolean | undefined; eligible: boolean; raw: Record<string, unknown>; starts: boolean }> = [
    { name: 'flag true, preview-eligible, an enabled destination with consent', flag: true, eligible: true, raw: file(1, otlp(true), framebriar()), starts: true },
    { name: 'the same with Framebriar following', flag: true, eligible: true, raw: file(1, otlp(true), framebriar({ enabled: true, confirmedHost: FB_HOST })), starts: true },
    { name: 'a passing setup with nothing enabled keeps its offer', flag: true, eligible: true, raw: file(1, otlp(false), framebriar()), starts: false },
    { name: 'a destination the user already disabled', flag: true, eligible: true, raw: file(1, otlp(false), azure(false), framebriar({ confirmedHost: FB_HOST })), starts: false },
    { name: 'an existing userOff, flag on', flag: true, eligible: true, raw: file(1, framebriar({ confirmedHost: FB_HOST, userOff: true })), starts: false },
    { name: 'an existing userOff, flag off', flag: false, eligible: true, raw: file(1, framebriar({ confirmedHost: FB_HOST, userOff: true })), starts: false },
    { name: 'an existing userOff with no host or consent', flag: undefined, eligible: false, raw: file(0, framebriar({ userOff: true })), starts: false },
  ];

  it.each(cases)('$name', async ({ flag, eligible, raw, starts }) => {
    seedGate(flag, eligible);
    writeJson(SETTINGS_FILE, raw);
    await launchAndWaitForMarker();

    expect(readSaved().destinations).toEqual(migrateTelemetrySettings({ ...raw }).destinations);
    expect(readSaved().consentVersion).toBe(raw.consentVersion);
    expect(exportAttempts()).toBe(starts ? 1 : 0);

    const bytes = readText(SETTINGS_FILE);
    await launch();
    expect(readText(SETTINGS_FILE)).toBe(bytes);
    expect(exportAttempts()).toBe(starts ? 1 : 0);
  });

  it('raises the local recording level as before for a setup that passed', async () => {
    seedGate(true, true);
    writeJson(SETTINGS_FILE, file(1, { ...otlp(true), level: 'detailed' }, framebriar()));
    await launchAndWaitForMarker();
    await vi.waitFor(() => expect(JSON.parse(readText('logging-settings.json')).telemetryLevel).toBe('detailed'));
  });

  it('keeps the queue of a setup that passed', async () => {
    seedGate(true, true);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar()));
    await fsp.mkdir(getOfflineDir(), { recursive: true });
    await launchAndWaitForMarker();
    expect(fs.existsSync(getOfflineDir())).toBe(true);
  });
});

describe('a fresh install', () => {
  it.each([
    { name: 'no flag file', flag: undefined },
    { name: 'the flag saved on, with no telemetry file', flag: true },
  ])('has nothing on, consent 0, no userOff, and no file: $name', async ({ flag }) => {
    seedGate(flag, false);
    await launch();
    const settings = getTelemetrySettings();
    expect(settings.consentVersion).toBe(0);
    expect(settings.destinations.some((d) => d.enabled)).toBe(false);
    expect(settings.destinations.find((d) => d.kind === 'framebriar')?.framebriar).toEqual({ userOff: false });
    expect(fs.existsSync(userDataPath(SETTINGS_FILE))).toBe(false);
    expect(exportAttempts()).toBe(0);
  });

  it('never carries the markers in the defaults: the store merges those over old files before migrating', () => {
    expect(TELEMETRY_SETTINGS.defaults).not.toHaveProperty('exportGraduation');
    expect(TELEMETRY_SETTINGS.defaults).not.toHaveProperty('developerRule');
  });

  it('treats an unreadable telemetry file as fresh, without rewriting it', async () => {
    seedGate(true, true);
    fs.writeFileSync(userDataPath(SETTINGS_FILE), '{not json');
    await launch();
    expect(getTelemetrySettings().consentVersion).toBe(0);
    expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
    expect(readText(SETTINGS_FILE)).toBe('{not json');
    expect(exportAttempts()).toBe(0);
  });
});

describe('Feedback connecting later', () => {
  const connect = () => setFramebriarTelemetrySource(() => ({
    host: FB_HOST,
    sessionId: 's-1',
    options: (signal) => ({ url: `https://${FB_HOST}/v1/${signal}`, headers: async () => ({}) }),
  }));
  const developer = () => getTelemetrySettings().destinations.find((d) => d.kind === 'framebriar')!;

  it('does not switch on a confirmed destination from before, with the flag off', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar({ confirmedHost: FB_HOST })));
    await launchAndWaitForMarker();
    const bytes = readText(SETTINGS_FILE);

    connect();
    await control.syncFramebriarDestination();

    expect(developer()).toMatchObject({ enabled: false, confirmedHost: FB_HOST, framebriar: { userOff: true } });
    expect(readText(SETTINGS_FILE)).toBe(bytes);
    expect(exportAttempts()).toBe(0);
    // Still off on a later launch, with Feedback connected from the start.
    await launch();
    await control.syncFramebriarDestination();
    expect(developer().enabled).toBe(false);
    expect(exportAttempts()).toBe(0);
  });

  it('does not switch on a dormant one in a stable build with Preview off', async () => {
    seedGate(true, false);
    writeJson(SETTINGS_FILE, file(1, framebriar({ confirmedHost: FB_HOST })));
    await launchAndWaitForMarker();
    connect();
    await control.syncFramebriarDestination();
    expect(developer()).toMatchObject({ enabled: false, framebriar: { userOff: true } });
    expect(exportAttempts()).toBe(0);
  });

  it('still follows for a setup that passed the gate', async () => {
    seedGate(true, true);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar({ confirmedHost: FB_HOST })));
    await launchAndWaitForMarker();
    connect();
    await control.syncFramebriarDestination();
    expect(developer().enabled).toBe(true);
  });

  it('fresh install: nothing starts, the offer asks, and "Share" survives the next launch', async () => {
    seedGate(undefined, false);
    await launch();
    connect();
    await control.syncFramebriarDestination();
    expect(developer().enabled).toBe(false);
    expect(fs.existsSync(userDataPath(SETTINGS_FILE))).toBe(false);

    const status = await control.getStatus();
    expect(status.destinations.find((d) => d.id === 'framebriar')).toMatchObject({ configured: true, enabled: false, userOff: false });
    // What the renderer asks on connecting: the question, and no change.
    expect(await control.setEnabled('framebriar', true, {})).toMatchObject({ ok: false, reason: 'needs_confirmation', needs: ['consent', 'destination'], host: FB_HOST });
    expect(fs.existsSync(userDataPath(SETTINGS_FILE))).toBe(false);
    expect(exportAttempts()).toBe(0);

    await control.setEnabled('framebriar', true, { consent: true, host: FB_HOST });
    expect(developer()).toMatchObject({ enabled: true, confirmedHost: FB_HOST, framebriar: { userOff: false } });

    // The file this wrote came from the defaults. Neither one-time migration may undo the choice.
    await vi.waitFor(() => expect(readSaved()).toMatchObject({ exportGraduation: 1, developerRule: 2 }));
    await launch();
    expect(developer()).toMatchObject({ enabled: true, framebriar: { userOff: false } });
  });

  it('fresh install: "Not now" sticks', async () => {
    seedGate(undefined, false);
    await launch();
    connect();
    await control.setEnabled('framebriar', false);
    await launch();
    await control.syncFramebriarDestination();
    expect(developer()).toMatchObject({ enabled: false, framebriar: { userOff: true } });
  });
});

describe('opting in after the migration', () => {
  const otlpEntry = () => getTelemetrySettings().destinations.find((d) => d.kind === 'otlp')!;

  it('survives the next launch on a fresh install, with the saved flag still absent', async () => {
    seedGate(undefined, false);
    await launch();
    expect(await control.saveOtlpConfig({ endpoint: `http://${LOOPBACK_HOST}`, headers: [] })).toMatchObject({ ok: true });
    expect(await control.setEnabled('otlp', true, {})).toMatchObject({ reason: 'needs_confirmation', needs: ['consent', 'destination'] });
    await control.setEnabled('otlp', true, { consent: true, host: LOOPBACK_HOST });
    expect(otlpEntry().enabled).toBe(true);

    await vi.waitFor(() => expect(readSaved().exportGraduation).toBe(1));
    await launch();
    expect(otlpEntry()).toMatchObject({ enabled: true, confirmedHost: LOOPBACK_HOST });
    expect(exportAttempts()).toBe(1);
  });

  it('survives the next launch on an install that was switched off, with the saved flag still false', async () => {
    seedGate(false, false);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar()));
    await launchAndWaitForMarker();
    expect(otlpEntry().enabled).toBe(false);

    await control.setEnabled('otlp', true, { host: LOOPBACK_HOST });
    expect(otlpEntry().enabled).toBe(true);

    await launch();
    expect(otlpEntry().enabled).toBe(true);
    expect(exportAttempts()).toBe(1);
  });

  it('works in a stable build with Preview off: the error about Experimental is gone', async () => {
    seedGate(undefined, false);
    await launch();
    const result = await control.setEnabled('otlp', true, {});
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(JSON.stringify(result)).not.toMatch(/experimental/i);
  });
});

describe('a failed save', () => {
  function failSettingsWrites(): void {
    const realWrite = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((target, ...rest) => (
      String(target).endsWith(SETTINGS_FILE)
        ? Promise.reject(new Error('disk full'))
        : realWrite(target, ...rest as [string])
    ));
  }

  it('does not let export start on this run, and the next launch saves it', async () => {
    seedGate(false, true);
    const raw = file(1, otlp(true), framebriar({ confirmedHost: FB_HOST }));
    writeJson(SETTINGS_FILE, raw);
    const before = readText(SETTINGS_FILE);
    failSettingsWrites();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await launch();
    await vi.waitFor(() => expect(quiet).toHaveBeenCalled());

    // Off in memory, untouched on disk, and nothing started.
    expect(readText(SETTINGS_FILE)).toBe(before);
    expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
    expect(getTelemetrySettings().destinations.find((d) => d.kind === 'framebriar')?.framebriar).toEqual({ userOff: true });
    expect(isTelemetryConfigured()).toBe(false);
    expect(exportAttempts()).toBe(0);

    // Feedback connecting on the same run can't bring it back either.
    setFramebriarTelemetrySource(() => ({ host: FB_HOST, sessionId: 's', options: () => ({ url: `https://${FB_HOST}/`, headers: async () => ({}) }) }));
    await control.syncFramebriarDestination();
    expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
    setFramebriarTelemetrySource(null);

    vi.mocked(fs.promises.writeFile).mockRestore();
    await launchAndWaitForMarker();
    expect(readSaved().destinations).toEqual(expectedOff(raw, true).map((d) => (d.kind === 'framebriar' ? { ...d, confirmedHost: FB_HOST } : d)));
    expect(exportAttempts()).toBe(0);
  });
});

describe('the saved flag', () => {
  it('stays on disk through the migration, and through a later save in a stable build', async () => {
    seedGate(true, false);
    writeJson(SETTINGS_FILE, file(1, otlp(true)));
    const flagFile = readText('experimental-settings.json');
    await launchAndWaitForMarker();
    expect(readText('experimental-settings.json')).toBe(flagFile);

    await experimentalSettings.saveSettings({ ...experimentalSettings.getSettings(), themeGradients: true });
    await vi.waitFor(() => expect(JSON.parse(readText('experimental-settings.json'))).toEqual({ telemetry: true, themeGradients: true }));
  });

  it('no longer changes anything once the file has the marker: turning it off starts nothing and stops nothing', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, { ...file(1, otlp(true), framebriar()), exportGraduation: 1 });
    await launch();
    expect(getTelemetrySettings().destinations.find((d) => d.kind === 'otlp')?.enabled).toBe(true);
    expect(isTelemetryConfigured()).toBe(true);
    expect(exportAttempts()).toBe(1);
  });
});
