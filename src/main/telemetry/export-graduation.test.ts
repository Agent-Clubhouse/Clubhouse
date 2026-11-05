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
import { getLocalSink } from './facade';
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

/** Writes to this one settings file fail; everything else goes through. */
function failWritesTo(name: string): void {
  const realWrite = fs.promises.writeFile;
  vi.spyOn(fs.promises, 'writeFile').mockImplementation((target, ...rest) => (
    String(target).endsWith(name)
      ? Promise.reject(new Error('disk full'))
      : realWrite(target, ...rest as [string])
  ));
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

  it('survives the next launch on a fresh install, and saves the flag as true', async () => {
    seedGate(undefined, false);
    await launch();
    expect(await control.saveOtlpConfig({ endpoint: `http://${LOOPBACK_HOST}`, headers: [] })).toMatchObject({ ok: true });
    expect(await control.setEnabled('otlp', true, {})).toMatchObject({ reason: 'needs_confirmation', needs: ['consent', 'destination'] });
    await control.setEnabled('otlp', true, { consent: true, host: LOOPBACK_HOST });
    expect(otlpEntry().enabled).toBe(true);

    await vi.waitFor(() => expect(readSaved().exportGraduation).toBe(1));
    expect(JSON.parse(readText('experimental-settings.json')).telemetry).toBe(true);
    await launch();
    expect(otlpEntry()).toMatchObject({ enabled: true, confirmedHost: LOOPBACK_HOST });
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
  it('does not let export start on this run, and the next launch saves it', async () => {
    seedGate(false, true);
    const raw = file(1, otlp(true), framebriar({ confirmedHost: FB_HOST }));
    writeJson(SETTINGS_FILE, raw);
    const before = readText(SETTINGS_FILE);
    failWritesTo(SETTINGS_FILE);
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
});

describe('a saved false always wins', () => {
  const graduated = (...destinations: object[]) => ({ ...file(1, ...destinations), exportGraduation: 1 });
  const entryOf = (kind: string) => getTelemetrySettings().destinations.find((d) => d.kind === kind)!;
  const anyOn = () => getTelemetrySettings().destinations.some((d) => d.enabled);
  const savedFlags = () => JSON.parse(readText('experimental-settings.json'));
  const connect = () => setFramebriarTelemetrySource(() => ({
    host: FB_HOST,
    sessionId: 's-1',
    options: (signal) => ({ url: `https://${FB_HOST}/v1/${signal}`, headers: async () => ({}) }),
  }));
  /** What an older preview-eligible build's Experimental page leaves behind. Its own file is rewritten whole. */
  const olderBuildSavesFlag = (flag: boolean) => writeJson('experimental-settings.json', { telemetry: flag });
  /** The next launch, once its save has landed. */
  async function upgradeAndWaitForOff(): Promise<void> {
    await launch();
    await vi.waitFor(() => expect(readSaved().destinations.some((d) => d.enabled)).toBe(false));
  }

  it('kept install, older build turns the flag off, upgrade: off, with no export attempt and the queue cleared', async () => {
    seedGate(true, true);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar({ enabled: true, confirmedHost: FB_HOST })));
    await launchAndWaitForMarker();
    expect(anyOn()).toBe(true);
    expect(exportAttempts()).toBeGreaterThan(0);

    olderBuildSavesFlag(false);
    await fsp.mkdir(getOfflineDir(), { recursive: true });
    await upgradeAndWaitForOff();

    expect(exportAttempts()).toBe(0);
    expect(isTelemetryConfigured()).toBe(false);
    expect(readSaved().consentVersion).toBe(1);
    expect(entryOf('otlp')).toMatchObject({ enabled: false, confirmedHost: LOOPBACK_HOST });
    expect(entryOf('framebriar')).toMatchObject({ enabled: false, confirmedHost: FB_HOST, framebriar: { userOff: true } });
    await vi.waitFor(() => expect(fs.existsSync(getOfflineDir())).toBe(false));

    // Repeated starts are no-ops.
    const bytes = readText(SETTINGS_FILE);
    for (let run = 0; run < 2; run++) {
      await launch();
      expect(readText(SETTINGS_FILE)).toBe(bytes);
      expect(exportAttempts()).toBe(0);
    }
  });

  it('migration switched off, deliberate opt-in with no downgrade: stays on across repeated starts', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar()));
    await launchAndWaitForMarker();
    expect(entryOf('otlp').enabled).toBe(false);

    await control.setEnabled('otlp', true, { host: LOOPBACK_HOST });
    expect(entryOf('otlp').enabled).toBe(true);
    await vi.waitFor(() => expect(savedFlags().telemetry).toBe(true));

    for (let run = 0; run < 3; run++) {
      await launch();
      expect(entryOf('otlp').enabled).toBe(true);
      expect(exportAttempts()).toBe(1);
    }
  });

  it('recorded false, opt-in, older build turns it on and then off, upgrade: off', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar()));
    await launchAndWaitForMarker();
    await control.setEnabled('otlp', true, { host: LOOPBACK_HOST });
    await vi.waitFor(() => expect(savedFlags().telemetry).toBe(true));
    await vi.waitFor(() => expect(readSaved().destinations.find((d) => d.kind === 'otlp')?.enabled).toBe(true));

    // Back to true on the older build changes nothing, so the install stays on through that launch.
    olderBuildSavesFlag(true);
    await launch();
    expect(entryOf('otlp').enabled).toBe(true);

    olderBuildSavesFlag(false);
    await upgradeAndWaitForOff();
    expect(anyOn()).toBe(false);
    expect(exportAttempts()).toBe(0);
  });

  it('a failed save stays off in memory and is retried', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, graduated(otlp(true), framebriar({ confirmedHost: FB_HOST })));
    const before = readText(SETTINGS_FILE);
    failWritesTo(SETTINGS_FILE);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await launch();
    await vi.waitFor(() => expect(quiet).toHaveBeenCalled());
    expect(readText(SETTINGS_FILE)).toBe(before);
    expect(anyOn()).toBe(false);
    expect(isTelemetryConfigured()).toBe(false);
    expect(exportAttempts()).toBe(0);

    vi.mocked(fs.promises.writeFile).mockRestore();
    await upgradeAndWaitForOff();
    expect(readSaved().destinations.find((d) => d.kind === 'framebriar')?.framebriar).toEqual({ userOff: true });
    expect(exportAttempts()).toBe(0);
  });

  describe('a failed flag write refuses the opt-in', () => {
    it.each([
      { name: 'a destination', id: 'otlp', ack: { host: LOOPBACK_HOST } },
      { name: 'Share with the developer', id: 'framebriar', ack: { host: FB_HOST } },
    ])('$name', async ({ id, ack }) => {
      seedGate(false, true);
      writeJson(SETTINGS_FILE, graduated(otlp(false), framebriar({ userOff: true })));
      await launch();
      connect();
      const beforeSettings = readText(SETTINGS_FILE);
      const beforeFlags = readText('experimental-settings.json');
      failWritesTo('experimental-settings.json');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await control.setEnabled(id, true, ack);
      expect(result).toMatchObject({ ok: false, reason: 'opt_in_not_saved', message: expect.stringContaining('stays off') });
      expect(anyOn()).toBe(false);
      expect(entryOf('framebriar').framebriar).toEqual({ userOff: true });
      expect(exportAttempts()).toBe(0);
      expect(readText(SETTINGS_FILE)).toBe(beforeSettings);
      expect(readText('experimental-settings.json')).toBe(beforeFlags);
      // This run is back on the saved value too, so nothing reads a true that never landed.
      expect(experimentalSettings.getStoredSettings().telemetry).toBe(false);

      vi.mocked(fs.promises.writeFile).mockRestore();
      await control.setEnabled(id, true, ack);
      expect(entryOf(id).enabled).toBe(true);
      await vi.waitFor(() => expect(savedFlags().telemetry).toBe(true));
    });
  });

  it('the flag write touches only that flag, whatever this build honours', async () => {
    seedGate(false, false);
    writeJson('experimental-settings.json', { telemetry: false, chat: true, dispatcher: false, themeGradients: true });
    writeJson(SETTINGS_FILE, graduated(otlp(false)));
    await launch();
    await control.setEnabled('otlp', true, { host: LOOPBACK_HOST });
    await vi.waitFor(() => expect(savedFlags()).toEqual({ telemetry: true, chat: true, dispatcher: false, themeGradients: true }));
  });

  it('Framebriar confirmed, flag false, Feedback connects later: doesn\'t follow on, and a Share still works and sets the flag', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, graduated(otlp(false), framebriar({ confirmedHost: FB_HOST })));
    await launch();
    await vi.waitFor(() => expect(readSaved().destinations.find((d) => d.kind === 'framebriar')?.framebriar).toEqual({ userOff: true }));

    connect();
    await control.syncFramebriarDestination();
    expect(entryOf('framebriar').enabled).toBe(false);
    expect(exportAttempts()).toBe(0);
    expect(savedFlags().telemetry).toBe(false);

    await control.setEnabled('framebriar', true, { host: FB_HOST });
    expect(entryOf('framebriar')).toMatchObject({ enabled: true, framebriar: { userOff: false } });
    await vi.waitFor(() => expect(savedFlags().telemetry).toBe(true));

    await launch();
    await control.syncFramebriarDestination();
    expect(entryOf('framebriar')).toMatchObject({ enabled: true, framebriar: { userOff: false } });
  });

  it('fresh install: no key, nothing active, and the offer is still shown', async () => {
    seedGate(undefined, false);
    await launch();
    connect();
    expect(experimentalSettings.getStoredSettings()).not.toHaveProperty('telemetry');
    expect(anyOn()).toBe(false);
    expect((await control.getStatus()).destinations.find((d) => d.id === 'framebriar')).toMatchObject({ enabled: false, userOff: false, configured: true });
    expect(await control.setEnabled('framebriar', true, {})).toMatchObject({ reason: 'needs_confirmation', needs: ['consent', 'destination'] });
    // Asking saves nothing. Only the answer does.
    expect(experimentalSettings.getStoredSettings()).not.toHaveProperty('telemetry');
  });

  it('turning a destination off doesn\'t touch the flag', async () => {
    seedGate(true, true);
    writeJson(SETTINGS_FILE, graduated(otlp(true), framebriar()));
    await launch();
    const flags = readText('experimental-settings.json');
    await control.setEnabled('otlp', false);
    await control.setEnabled('framebriar', false);
    expect(readText('experimental-settings.json')).toBe(flags);
    expect(anyOn()).toBe(false);
    await launch();
    expect(anyOn()).toBe(false);
  });

  it('a false with nothing active or able to follow changes nothing', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, graduated(otlp(false), framebriar({ confirmedHost: FB_HOST, userOff: true })));
    const bytes = readText(SETTINGS_FILE);
    await launch();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readText(SETTINGS_FILE)).toBe(bytes);
  });

  describe('what a saved false can\'t speak to', () => {
    it('a missing flag isn\'t false: an active setup stays on', async () => {
      seedGate(undefined, false);
      writeJson(SETTINGS_FILE, graduated(otlp(true), framebriar()));
      await launch();
      expect(entryOf('otlp').enabled).toBe(true);
      expect(exportAttempts()).toBe(1);
    });

    it('the older build never changed the flag (Preview off there, say): the flag is still true, so it resumes', async () => {
      seedGate(true, false);
      writeJson(SETTINGS_FILE, graduated(otlp(true), framebriar()));
      await launch();
      expect(entryOf('otlp').enabled).toBe(true);
    });
  });
});

describe('an unreadable flag file', () => {
  const FLAG_FILE = 'experimental-settings.json';
  // Short, so a JSON parser's message would quote all of it.
  const RAW = 'RAW-FILE-CONTENT';
  const graduated = (...destinations: object[]) => ({ ...file(1, ...destinations), exportGraduation: 1 });
  const active = () => graduated(otlp(true), framebriar({ confirmedHost: FB_HOST }));
  const corruptFlags = () => fs.writeFileSync(userDataPath(FLAG_FILE), RAW);
  const entryOf = (kind: string) => getTelemetrySettings().destinations.find((d) => d.kind === kind)!;
  const prefs = (settings: TelemetrySettings) => JSON.stringify(settings.destinations);
  const recoveryCopies = () => fs.readdirSync(userData.dir).filter((name) => name.startsWith(`${FLAG_FILE}.unreadable`)).sort();
  const connect = () => setFramebriarTelemetrySource(() => ({
    host: FB_HOST,
    sessionId: 's-1',
    options: (signal) => ({ url: `https://${FB_HOST}/v1/${signal}`, headers: async () => ({}) }),
  }));

  /** An active setup, paused by this launch and saved. */
  async function paused(seed: () => void = corruptFlags): Promise<void> {
    seedGate(undefined, true);
    seed();
    writeJson(SETTINGS_FILE, active());
    await launch();
    await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
  }

  describe('what counts as unreadable', () => {
    it.each<[string, () => void, string]>([
      ['no file is missing', () => undefined, 'missing'],
      ['no key is missing', () => writeJson(FLAG_FILE, { chat: true }), 'missing'],
      ['true', () => writeJson(FLAG_FILE, { telemetry: true }), 'true'],
      ['false', () => writeJson(FLAG_FILE, { telemetry: false }), 'false'],
      ['bad JSON', corruptFlags, 'unreadable'],
      ['an empty file', () => fs.writeFileSync(userDataPath(FLAG_FILE), ''), 'unreadable'],
      ['an array', () => writeJson(FLAG_FILE, [{ telemetry: true }]), 'unreadable'],
      ['null', () => writeJson(FLAG_FILE, null), 'unreadable'],
      ['a number', () => writeJson(FLAG_FILE, 1), 'unreadable'],
      ['a flag of the wrong type', () => writeJson(FLAG_FILE, { telemetry: 'true' }), 'unreadable'],
      ['a read error', () => fs.mkdirSync(userDataPath(FLAG_FILE)), 'unreadable'],
    ])('%s', (_name, seed, expected) => {
      seed();
      expect(experimentalSettings.peekStoredFlag('telemetry')).toBe(expected);
    });
  });

  describe('with an active setup', () => {
    it('pauses export and changes nothing else, with local recording still on', async () => {
      seedGate(undefined, true);
      corruptFlags();
      writeJson(SETTINGS_FILE, active());
      const before = migrateTelemetrySettings({ ...active() });
      await fsp.mkdir(getOfflineDir(), { recursive: true });
      await fsp.writeFile(path.join(getOfflineDir(), 'queued.ai.json'), '[1]');
      await launch();

      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
      expect(isTelemetryConfigured()).toBe(false);
      expect(getLocalSink()).not.toBeNull();
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));

      expect(prefs(readSaved())).toBe(prefs(before));
      expect(readSaved().consentVersion).toBe(1);
      expect(await fsp.readFile(path.join(getOfflineDir(), 'queued.ai.json'), 'utf8')).toBe('[1]');
      const status = await control.getStatus();
      expect(status.exportPaused).toBe(true);
      expect(status.pausedFileCopy).toBe(userDataPath(`${FLAG_FILE}.unreadable`));
    });

    it('a flag of the wrong type pauses too', async () => {
      await paused(() => writeJson(FLAG_FILE, { telemetry: 'true' }));
      expect(exportAttempts()).toBe(0);
    });

    it('no export path gets through: Framebriar follow, turning one on, filters, clearing another', async () => {
      await paused();
      const saved = prefs(readSaved());
      connect();

      await control.syncFramebriarDestination();
      expect(entryOf('framebriar').enabled).toBe(false);
      expect(await control.setEnabled('azure', true, { host: 'x' })).toMatchObject({ ok: false, reason: 'export_paused' });
      expect(await control.setEnabled('framebriar', true, { host: FB_HOST })).toMatchObject({ ok: false, reason: 'export_paused' });
      await control.setFilter('otlp', 'standard', 'all');
      await control.clearAzureConnectionString();

      expect(exportAttempts()).toBe(0);
      expect(experimentalSettings.peekStoredFlag('telemetry')).toBe('unreadable');
      expect(prefs(getTelemetrySettings())).toBe(saved);
    });

    it('repeated starts are no-ops, with one recovery copy', async () => {
      await paused();
      const bytes = readText(SETTINGS_FILE);
      for (let run = 0; run < 2; run++) {
        await launch();
        expect(readText(SETTINGS_FILE)).toBe(bytes);
        expect(exportAttempts()).toBe(0);
      }
      expect(recoveryCopies()).toEqual([`${FLAG_FILE}.unreadable`]);
    });

    it('turning everything off leaves nothing suspended', async () => {
      await paused();
      await control.setEnabled('otlp', false);
      await control.setEnabled('framebriar', false);
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect((await control.getStatus()).exportPaused).toBe(false);
    });
  });

  it('with nothing active: nothing suspended, nothing written, no copy', async () => {
    seedGate(undefined, true);
    corruptFlags();
    writeJson(SETTINGS_FILE, graduated(otlp(false), framebriar({ userOff: true })));
    const bytes = readText(SETTINGS_FILE);
    await launch();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getTelemetrySettings().exportSuspended).toBeUndefined();
    expect(readText(SETTINGS_FILE)).toBe(bytes);
    expect(recoveryCopies()).toEqual([]);
  });

  it('a fresh install is unaffected, with no telemetry file written', async () => {
    seedGate(undefined, false);
    corruptFlags();
    await launch();
    expect(getTelemetrySettings().exportSuspended).toBeUndefined();
    expect(fs.existsSync(userDataPath(SETTINGS_FILE))).toBe(false);
    expect(recoveryCopies()).toEqual([]);
  });

  it('before graduation it still counts as flag off, not a pause', async () => {
    seedGate(undefined, true);
    corruptFlags();
    writeJson(SETTINGS_FILE, file(1, otlp(true), framebriar()));
    await launchAndWaitForMarker();
    expect(readSaved().destinations.some((d) => d.enabled)).toBe(false);
    expect(readSaved().exportSuspended).toBeUndefined();
  });

  describe('resolution', () => {
    it('reads true: clears and resumes, with settings as they were', async () => {
      await paused();
      const saved = prefs(readSaved());
      writeJson(FLAG_FILE, { telemetry: true });
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(exportAttempts()).toBe(1);
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBeUndefined());
      expect(prefs(readSaved())).toBe(saved);
    });

    it('reads false: the existing switch-off', async () => {
      await paused();
      await fsp.mkdir(getOfflineDir(), { recursive: true });
      writeJson(FLAG_FILE, { telemetry: false });
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
      expect(entryOf('framebriar').framebriar).toEqual({ userOff: true });
      expect(exportAttempts()).toBe(0);
      await vi.waitFor(() => expect(fs.existsSync(getOfflineDir())).toBe(false));
    });

    it.each<[string, () => void]>([
      ['still unreadable', () => fs.writeFileSync(userDataPath(FLAG_FILE), 'differently broken')],
      ['an older build rewrote it without the key', () => writeJson(FLAG_FILE, { chat: true })],
      ['the file is gone', () => fs.rmSync(userDataPath(FLAG_FILE))],
    ])('stays suspended: %s', async (_name, change) => {
      await paused();
      change();
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
    });

    it('an unrelated save from the renderer doesn\'t clear it', async () => {
      await paused();
      await experimentalSettings.saveSettings({ themeGradients: true });
      await vi.waitFor(() => expect(JSON.parse(readText(FLAG_FILE))).toEqual({ themeGradients: true, telemetry: null }));
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);
    });
  });

  describe('the recovery copy', () => {
    it('is exact, keeps the source\'s permissions, and stays out of the logs', async () => {
      const warn = vi.spyOn(console, 'warn');
      const error = vi.spyOn(console, 'error');
      await paused(() => {
        corruptFlags();
        fs.chmodSync(userDataPath(FLAG_FILE), 0o640);
      });
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);
      if (process.platform !== 'win32') {
        expect(fs.statSync(userDataPath(`${FLAG_FILE}.unreadable`)).mode & 0o777).toBe(0o640);
      }
      await _resetLocalRecordingForTests();
      const logDir = path.join(userData.dir, '.clubhouse', 'logs');
      const logged = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((name) => fs.readFileSync(path.join(logDir, name), 'utf8')).join('') : '';
      expect(logged).not.toContain('RAW-FILE-CONTENT');
      expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('RAW-FILE-CONTENT');
    });

    it('never overwrites an existing copy: different bytes get the next number', async () => {
      fs.writeFileSync(userDataPath(`${FLAG_FILE}.unreadable`), 'from an earlier time');
      await paused();
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe('from an earlier time');
      expect(readText(`${FLAG_FILE}.unreadable.1`)).toBe(RAW);
    });

    it('failing to make it stays paused, refuses writes over the file, and retries next launch', async () => {
      // A directory in the way: reading it as a copy fails.
      fs.mkdirSync(userDataPath(`${FLAG_FILE}.unreadable`));
      await paused();
      expect(exportAttempts()).toBe(0);
      expect(await control.resumeExport()).toMatchObject({ ok: false, reason: 'opt_in_not_saved' });
      await expect(experimentalSettings.saveSettings({ themeGradients: true })).rejects.toThrow();
      expect(readText(FLAG_FILE)).toBe(RAW);
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');

      fs.rmdirSync(userDataPath(`${FLAG_FILE}.unreadable`));
      await launch();
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);
      expect(exportAttempts()).toBe(0);
    });
  });

  it('a failed save of the pause stays paused in memory and retries next launch', async () => {
    seedGate(undefined, true);
    corruptFlags();
    writeJson(SETTINGS_FILE, active());
    const before = readText(SETTINGS_FILE);
    failWritesTo(SETTINGS_FILE);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await launch();
    await vi.waitFor(() => expect(quiet).toHaveBeenCalled());
    expect(readText(SETTINGS_FILE)).toBe(before);
    expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
    expect(isTelemetryConfigured()).toBe(false);
    expect(exportAttempts()).toBe(0);

    vi.mocked(fs.promises.writeFile).mockRestore();
    await launch();
    await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
    expect(exportAttempts()).toBe(0);
  });

  describe('a failed save of the pause, then an unrelated save rewriting the flag file', () => {
    /** Paused in memory only, then the file rewritten as valid. The next launch finds no pause on disk. */
    async function pausedInMemoryThenRewritten(): Promise<void> {
      seedGate(undefined, true);
      corruptFlags();
      writeJson(SETTINGS_FILE, active());
      failWritesTo(SETTINGS_FILE);
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await launch();
      await vi.waitFor(() => expect(quiet).toHaveBeenCalled());
      expect(readSaved().exportSuspended).toBeUndefined();
      await experimentalSettings.saveSettings({ themeGradients: true });
      await vi.waitFor(() => expect(JSON.parse(readText(FLAG_FILE)).themeGradients).toBe(true));
      vi.mocked(fs.promises.writeFile).mockRestore();
    }

    /** A launch where the pause can't be saved, and it isn't. */
    async function launchWithPauseSaveFailing(): Promise<void> {
      failWritesTo(SETTINGS_FILE);
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await launch();
      await vi.waitFor(() => expect(quiet).toHaveBeenCalled());
      expect(readSaved().exportSuspended).toBeUndefined();
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
    }
    const endFailures = () => vi.mocked(fs.promises.writeFile).mockRestore();

    it.each([2, 3])('%i unrelated saves in one run keep the marker, on disk and in memory', async (saves) => {
      seedGate(undefined, true);
      corruptFlags();
      writeJson(SETTINGS_FILE, active());
      await launchWithPauseSaveFailing();
      for (let n = 1; n <= saves; n++) {
        await experimentalSettings.saveSettings({ themeGradients: n % 2 === 0, chat: true });
        expect(JSON.parse(readText(FLAG_FILE))).toEqual({ themeGradients: n % 2 === 0, chat: true, telemetry: null });
        expect(experimentalSettings.getStoredSettings().telemetry).toBeNull();
        expect(experimentalSettings.peekStoredFlag('telemetry')).toBe('unreadable');
      }
      endFailures();
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
      expect(recoveryCopies()).toEqual([`${FLAG_FILE}.unreadable`]);
    });

    it('a restart between saves, with the pause save still failing, gives the same result', async () => {
      seedGate(undefined, true);
      corruptFlags();
      writeJson(SETTINGS_FILE, active());
      for (let run = 0; run < 3; run++) {
        await launchWithPauseSaveFailing();
        await experimentalSettings.saveSettings({ themeGradients: run % 2 === 0 });
        expect(JSON.parse(readText(FLAG_FILE))).toEqual({ themeGradients: run % 2 === 0, telemetry: null });
        endFailures();
      }
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
      expect(recoveryCopies()).toEqual([`${FLAG_FILE}.unreadable`]);
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);
    });

    it('Resume over the marker writes true and resumes, and lasts', async () => {
      await pausedInMemoryThenRewritten();
      await launch();
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
      expect((await control.getStatus()).exportPaused).toBe(true);
      const result = await control.resumeExport();
      expect(result.status.exportPaused).toBe(false);
      await vi.waitFor(() => expect(JSON.parse(readText(FLAG_FILE))).toEqual({ themeGradients: true, telemetry: true }));
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(exportAttempts()).toBe(1);
    });

    it('Resume stays paused while the opt-in can\'t be saved, even with the marker in place', async () => {
      await pausedInMemoryThenRewritten();
      await launch();
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
      const flagFile = readText(FLAG_FILE);
      failWritesTo(FLAG_FILE);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await control.resumeExport()).toMatchObject({ ok: false, reason: 'opt_in_not_saved' });
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
      expect(readText(FLAG_FILE)).toBe(flagFile);
      expect(experimentalSettings.getStoredSettings().telemetry).toBeNull();
    });

    it('Resume with the flag saved but the pause not cleared on disk still resolves on the next load', async () => {
      await pausedInMemoryThenRewritten();
      await launch();
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
      failWritesTo(SETTINGS_FILE);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await control.resumeExport()).status.exportPaused).toBe(false);
      expect(readSaved().exportSuspended).toBe('flag_unreadable');
      endFailures();
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(exportAttempts()).toBe(1);
    });

    it('an older build\'s false over the marker switches off', async () => {
      await pausedInMemoryThenRewritten();
      writeJson(FLAG_FILE, { themeGradients: true, telemetry: false });
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
      expect(exportAttempts()).toBe(0);
    });

    it('repeated starts over the marker are no-ops, and the recovery copy stays', async () => {
      await pausedInMemoryThenRewritten();
      await launch();
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
      const settings = readText(SETTINGS_FILE);
      const flags = readText(FLAG_FILE);
      for (let run = 0; run < 2; run++) {
        await launch();
        expect(readText(SETTINGS_FILE)).toBe(settings);
        expect(readText(FLAG_FILE)).toBe(flags);
        expect(exportAttempts()).toBe(0);
      }
      expect(recoveryCopies()).toEqual([`${FLAG_FILE}.unreadable`]);
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);
    });

    it('the marker doesn\'t reach the renderer, and a page that writes back what it read keeps it', async () => {
      await pausedInMemoryThenRewritten();
      resetAllSettingsStoresForTests();
      const read = experimentalSettings.getSettings();
      expect(read).not.toHaveProperty('telemetry');
      await experimentalSettings.saveSettings({ ...read, chat: true });
      expect(JSON.parse(readText(FLAG_FILE))).toEqual({ themeGradients: true, chat: true, telemetry: null });
    });

    // What v0.42.0 leaves behind, from running its real code over the marker. See the PR.
    it.each<[string, Record<string, unknown>, 'paused' | 'off' | 'on']>([
      ['its page saving another flag keeps null', { telemetry: null, chat: true }, 'paused'],
      ['its Preview-off save keeps null', { telemetry: null, themeGradients: true }, 'paused'],
      ['its page turned on', { telemetry: true }, 'on'],
      ['its page turned on and off', { telemetry: false }, 'off'],
    ])('re-upgrading after v0.42.0: %s', async (_name, flags, expected) => {
      seedGate(undefined, true);
      writeJson(FLAG_FILE, flags);
      writeJson(SETTINGS_FILE, { ...active(), exportSuspended: 'flag_unreadable' });
      await launch();
      if (expected === 'paused') expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      else expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(expected !== 'off');
      expect(exportAttempts()).toBe(expected === 'on' ? 1 : 0);
    });

    it('a save while another is part way through its write doesn\'t take the file for unreadable', async () => {
      seedGate(true, true);
      writeJson(SETTINGS_FILE, graduated(otlp(true), framebriar()));
      await launch();
      const realWrite = fs.promises.writeFile;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (target, data, options) => {
        if (first && String(target).endsWith(FLAG_FILE)) {
          first = false;
          // A real write truncates first: this is what's on disk while it runs.
          fs.writeFileSync(String(target), String(data).slice(0, 5));
          await held;
        }
        return realWrite(target, data, options as never);
      });

      const firstSave = experimentalSettings.saveSettings({ themeGradients: true });
      await vi.waitFor(() => expect(readText(FLAG_FILE)).toHaveLength(5));
      const secondSave = experimentalSettings.saveSettings({ themeGradients: false });
      release();
      await Promise.all([firstSave, secondSave]);

      expect(JSON.parse(readText(FLAG_FILE))).toEqual({ telemetry: true, themeGradients: false });
      expect(recoveryCopies()).toEqual([]);
    });
  });

  describe('Resume', () => {
    it('sets the flag, clears the pause and starts export, with no dialog', async () => {
      await paused();
      const saved = prefs(readSaved());
      expect((await control.getStatus()).consentAccepted).toBe(true);
      const result = await control.resumeExport();
      expect(result.status.exportPaused).toBe(false);
      expect(result.status.pausedFileCopy).toBeUndefined();
      expect('needs' in result).toBe(false);
      expect(exportAttempts()).toBeGreaterThan(0);
      await vi.waitFor(() => expect(JSON.parse(readText(FLAG_FILE)).telemetry).toBe(true));
      await vi.waitFor(() => expect(readSaved().exportSuspended).toBeUndefined());
      expect(prefs(readSaved())).toBe(saved);
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);

      await launch();
      expect(getTelemetrySettings().exportSuspended).toBeUndefined();
      expect(entryOf('otlp').enabled).toBe(true);
      expect(exportAttempts()).toBe(1);
    });

    it('stays paused if the flag can\'t be saved', async () => {
      await paused();
      failWritesTo(FLAG_FILE);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await control.resumeExport()).toMatchObject({ ok: false, reason: 'opt_in_not_saved', message: expect.stringContaining('paused') });
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
      expect(readText(FLAG_FILE)).toBe(RAW);
    });

    it('a save that fails once, over a corrupt file, can\'t leave a valid file with no key: it stays paused', async () => {
      await paused();
      const realWrite = fs.promises.writeFile;
      vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(() => Promise.reject(new Error('disk full')));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await control.resumeExport()).toMatchObject({ ok: false, reason: 'opt_in_not_saved' });
      vi.mocked(fs.promises.writeFile).mockRestore();
      expect(fs.promises.writeFile).toBe(realWrite);
      await vi.waitFor(() => expect(JSON.parse(readText(FLAG_FILE))).toEqual({ telemetry: null }));
      expect(readText(`${FLAG_FILE}.unreadable`)).toBe(RAW);
      await launch();
      expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
      expect(exportAttempts()).toBe(0);
    });

    it('does nothing when nothing is paused', async () => {
      seedGate(undefined, true);
      await launch();
      expect(await control.resumeExport()).toMatchObject({ ok: true });
      expect(fs.existsSync(userDataPath(SETTINGS_FILE))).toBe(false);
      expect(experimentalSettings.getStoredSettings()).not.toHaveProperty('telemetry');
    });
  });
});

describe('the renderer doesn\'t own the telemetry flag', () => {
  const FLAG_FILE = 'experimental-settings.json';
  const saved = () => JSON.parse(readText(FLAG_FILE));

  describe.each([
    { build: 'a preview-eligible build', eligible: true },
    { build: 'a stable build with Preview off', eligible: false },
  ])('$build', ({ eligible }) => {
    it.each<[string, boolean | undefined, Record<string, boolean>]>([
      ['false over a stored true', true, { telemetry: false, themeGradients: true }],
      ['a dropped key over a stored true', true, { themeGradients: true }],
      ['true over a stored false', false, { telemetry: true, themeGradients: true }],
      ['a dropped key over a stored false', false, { themeGradients: true }],
      ['true with none stored', undefined, { telemetry: true, themeGradients: true }],
      ['false with none stored', undefined, { telemetry: false, themeGradients: true }],
    ])('%s leaves the stored value alone', async (_name, stored, sent) => {
      seedGate(stored, eligible);
      resetAllSettingsStoresForTests();
      await experimentalSettings.saveSettings(sent);
      await vi.waitFor(() => expect(saved().themeGradients).toBe(true));
      expect(saved().telemetry).toBe(stored);
    });
  });

  it('a renderer true alone enables nothing, and a renderer false changes nothing', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, { ...file(1, otlp(false), framebriar({ userOff: true })), exportGraduation: 1 });
    await launch();
    await experimentalSettings.saveSettings({ telemetry: true });
    await launch();
    expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
    expect(exportAttempts()).toBe(0);
    expect(saved().telemetry).toBe(false);
  });

  it('over an unreadable file, a renderer true isn\'t written, so it can\'t resume a pause', async () => {
    seedGate(undefined, true);
    fs.writeFileSync(userDataPath(FLAG_FILE), '{broken');
    writeJson(SETTINGS_FILE, { ...file(1, otlp(true), framebriar()), exportGraduation: 1 });
    await launch();
    await vi.waitFor(() => expect(readSaved().exportSuspended).toBe('flag_unreadable'));
    await experimentalSettings.saveSettings({ telemetry: true, themeGradients: true });
    await vi.waitFor(() => expect(saved()).toEqual({ themeGradients: true, telemetry: null }));
    await launch();
    expect(getTelemetrySettings().exportSuspended).toBe('flag_unreadable');
    expect(exportAttempts()).toBe(0);
  });

  it('main\'s opt-in still writes it, and a later renderer save keeps it', async () => {
    seedGate(false, true);
    writeJson(SETTINGS_FILE, { ...file(1, otlp(false), framebriar({ userOff: true })), exportGraduation: 1 });
    await launch();
    await control.setEnabled('otlp', true, { host: LOOPBACK_HOST });
    await vi.waitFor(() => expect(saved().telemetry).toBe(true));
    await experimentalSettings.saveSettings({ telemetry: false, themeGradients: true });
    await vi.waitFor(() => expect(saved()).toEqual({ telemetry: true, themeGradients: true }));
  });
});
