import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stable-mode gates against the real stores and a temp userData: a packaged
 * build that isn't preview-eligible honours none of the preview-only flags, and
 * nothing it does changes what is saved.
 */

const h = vi.hoisted(() => ({ userData: '', isPackaged: true, version: '0.42.0' }));

vi.mock('electron', async (importActual) => ({
  ...(await importActual<typeof import('electron')>()),
  app: {
    getPath: () => h.userData,
    get isPackaged() { return h.isPackaged; },
    getVersion: () => h.version,
    getName: () => 'clubhouse-test',
    on: () => {},
  },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./dispatcher/dispatcher-service', async () => {
  const settings = await vi.importActual<typeof import('./dispatcher/dispatcher-settings')>('./dispatcher/dispatcher-settings');
  return {
    getDispatcherState: () => ({ enabled: settings.isDispatcherEnabled(), flagOn: settings.isDispatcherFlagOn(), agentId: null, path: null, config: null }),
    isDispatcherAgentId: () => false,
    onDispatcherChanged: () => () => {},
  };
});

import { resetAllSettingsStoresForTests } from './settings-store';
import { getSettings, getStoredSettings, saveSettings } from './experimental-settings';
import { isPreviewEligible } from './preview-eligible';
import { isChatEnabled, isCopilotSdkEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { DISPATCHER_FLAG, isDispatcherEnabled, isDispatcherFlagOn } from './dispatcher/dispatcher-settings';
import { isMcpEnabledForAny } from './mcp-settings';
import { dispatcherCapability } from './mobile-dispatcher';
import { EXPERIMENTAL_FLAG as TELEMETRY_FLAG, getTelemetrySettings, isExperimentEnabled } from '../telemetry/settings';
import { isTelemetryConfigured, uiChrome } from '../telemetry/bootstrap';
import { newChromeEnabled, resetNewChromeCacheForTests } from '../window-chrome';
import { NEW_CHROME_FLAG } from '../../shared/chrome-flag';
import { COPILOT_SDK_FLAG, RICH_CHAT_CONTENT_FLAG } from '../../shared/chat';
import { TELEMETRY_CONSENT_VERSION } from '../../shared/telemetry/settings-types';
import { PREVIEW_ONLY_EXPERIMENTAL_FLAGS, STRUCTURED_MODE_REMOVED_NOTICE_KEY } from '../../shared/types';

const ALL_SAVED = {
  newChrome: true,
  goobers: true,
  chat: true,
  richChatContent: true,
  copilotSdk: true,
  dispatcher: true,
  telemetry: true,
  themeGradients: true,
  [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true,
};

const UPDATE_FILE = 'update-settings.json';
const EXPERIMENTAL_FILE = 'experimental-settings.json';
const DISPATCHER_FILE = 'dispatcher-settings.json';
const TELEMETRY_FILE = 'telemetry-settings.json';
const CHAT_RUNTIME_FILE = 'chat-runtime-settings.json';

function write(name: string, value: unknown): void {
  fs.writeFileSync(path.join(h.userData, name), JSON.stringify(value, null, 2));
}
function bytes(name: string): string {
  return fs.readFileSync(path.join(h.userData, name), 'utf-8');
}

/** A saved beta profile. Each launch starts from the files, as the next launch would. */
function seed({ previewChannel }: { previewChannel: boolean }): void {
  write(UPDATE_FILE, { autoUpdate: false, previewChannel, lastCheck: null, dismissedVersion: null, lastSeenVersion: null });
  write(EXPERIMENTAL_FILE, ALL_SAVED);
  write(DISPATCHER_FILE, { enabled: true });
  write(CHAT_RUNTIME_FILE, { 'claude-code': { mode: 'chat' } });
  relaunch();
}
function relaunch(): void {
  resetAllSettingsStoresForTests();
  resetNewChromeCacheForTests();
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-stable-gates-'));
  h.isPackaged = true;
  h.version = '0.42.0';
});

afterEach(() => {
  relaunch();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe('the preview-only list', () => {
  it('names each feature by the same key its reader uses', () => {
    expect([...PREVIEW_ONLY_EXPERIMENTAL_FLAGS].sort()).toEqual([
      NEW_CHROME_FLAG, 'goobers', COPILOT_SDK_FLAG, DISPATCHER_FLAG, TELEMETRY_FLAG,
    ].sort());
  });
});

describe('a packaged stable build with Preview off', () => {
  beforeEach(() => seed({ previewChannel: false }));

  it('is not eligible', () => {
    expect(isPreviewEligible()).toBe(false);
  });

  it('reads each preview-only flag as off', () => {
    const flags = getSettings();
    for (const flag of PREVIEW_ONLY_EXPERIMENTAL_FLAGS) expect(flags).not.toHaveProperty(flag);
  });

  it('keeps honouring the graduated flags and the structured-mode notice marker', () => {
    expect(getSettings()).toEqual({ chat: true, [RICH_CHAT_CONTENT_FLAG]: true, themeGradients: true, [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true });
  });

  it('still reports what is saved through getStoredSettings', () => {
    expect(getStoredSettings()).toEqual(ALL_SAVED);
  });

  it('starts on the legacy layout, for main, telemetry and the phone', () => {
    expect(newChromeEnabled()).toBe(false);
    expect(uiChrome()).toBe('legacy');
    expect(dispatcherCapability()).toMatchObject({ newLayout: false, flagOn: false, enabled: false });
  });

  it('runs a Chat-mode agent in chat, without the preview-only Copilot SDK, and leaves its saved choices alone', () => {
    const saved = bytes(CHAT_RUNTIME_FILE);
    expect(isChatEnabled()).toBe(true);
    expect(isCopilotSdkEnabled()).toBe(false);
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'chat' });
    expect(resolveRuntimeMode('claude-code')).toEqual({ mode: 'chat' });
    expect(bytes(CHAT_RUNTIME_FILE)).toBe(saved);
  });

  it('runs a Chat-mode agent in the terminal once Chat is saved off, and leaves its saved choices alone', () => {
    write(EXPERIMENTAL_FILE, { ...ALL_SAVED, chat: false });
    relaunch();
    const saved = bytes(CHAT_RUNTIME_FILE);
    expect(isChatEnabled()).toBe(false);
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'terminal' });
    expect(bytes(CHAT_RUNTIME_FILE)).toBe(saved);
  });

  it('turns the Dispatcher off without changing its saved switch', () => {
    // With MCP off in its own settings, only the Dispatcher could turn it on.
    write('mcp-settings.json', { enabled: false, projectDefault: false });
    relaunch();
    const saved = bytes(DISPATCHER_FILE);
    expect(isDispatcherFlagOn()).toBe(false);
    expect(isDispatcherEnabled()).toBe(false);
    expect(isMcpEnabledForAny()).toBe(false);
    expect(bytes(DISPATCHER_FILE)).toBe(saved);
  });

  it('stops telemetry without rewriting consent or destinations', () => {
    const file = {
      consentVersion: TELEMETRY_CONSENT_VERSION,
      sampleRate: 1,
      destinations: [
        { id: 'azure', kind: 'azure', enabled: true, level: 'standard', preset: 'all', confirmedHost: 'example.in.applicationinsights.azure.com' },
        { id: 'otlp', kind: 'otlp', enabled: false, level: 'standard', preset: 'all', otlp: { endpoint: '', headerNames: [], temporality: 'cumulative' } },
      ],
    };
    write(TELEMETRY_FILE, file);
    relaunch();
    const saved = bytes(TELEMETRY_FILE);

    expect(isExperimentEnabled()).toBe(false);
    expect(isTelemetryConfigured()).toBe(false);

    // Consent and the enabled destination are still what the app loads.
    const loaded = getTelemetrySettings();
    expect(loaded.consentVersion).toBe(TELEMETRY_CONSENT_VERSION);
    expect(loaded.destinations.find((d) => d.id === 'azure')).toMatchObject({ enabled: true, confirmedHost: file.destinations[0].confirmedHost });
    expect(bytes(TELEMETRY_FILE)).toBe(saved);
  });

  describe('a write', () => {
    it('keeps every saved flag when the renderer writes back what it read', async () => {
      const { [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: _shown, ...rest } = getSettings();
      await saveSettings(rest);

      const { [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: _gone, ...expected } = ALL_SAVED;
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual(expected);
    });

    it('still drops a stale flag', async () => {
      write(EXPERIMENTAL_FILE, { ...ALL_SAVED, sessions: true });
      relaunch();
      const { sessions: _stale, ...cleaned } = getSettings();
      await saveSettings(cleaned);
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual(ALL_SAVED);
    });

    it('cannot turn on or change a preview-only flag', async () => {
      write(EXPERIMENTAL_FILE, { copilotSdk: false });
      relaunch();
      await saveSettings({ copilotSdk: true, newChrome: true });
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ copilotSdk: false });
    });

    it('can change a graduated flag, so a saved false has a way back', async () => {
      write(EXPERIMENTAL_FILE, { chat: false, [RICH_CHAT_CONTENT_FLAG]: false, themeGradients: false, dispatcher: true });
      relaunch();
      await saveSettings({ ...getSettings(), chat: true, [RICH_CHAT_CONTENT_FLAG]: true, themeGradients: true });
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ chat: true, [RICH_CHAT_CONTENT_FLAG]: true, themeGradients: true, dispatcher: true });
    });

    it('never touches the Preview opt-in', async () => {
      const saved = bytes(UPDATE_FILE);
      await saveSettings(getSettings());
      expect(bytes(UPDATE_FILE)).toBe(saved);
      expect(isPreviewEligible()).toBe(false);
    });

    it('serializes with the store, so two writes in a row both land and keep the flags', async () => {
      await Promise.all([saveSettings({ themeGradients: false }), saveSettings({ themeGradients: true })]);
      const { [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: _shown, chat: _chat, richChatContent: _rich, ...expected } = ALL_SAVED;
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual(expected);
    });
  });

  it('gets everything back on the next launch with Preview on', async () => {
    await saveSettings(getSettings());
    const experimental = bytes(EXPERIMENTAL_FILE);

    write(UPDATE_FILE, { autoUpdate: false, previewChannel: true, lastCheck: null, dismissedVersion: null, lastSeenVersion: null });
    relaunch();

    expect(bytes(EXPERIMENTAL_FILE)).toBe(experimental);
    expect(getSettings()).toEqual(ALL_SAVED);
    expect(newChromeEnabled()).toBe(true);
    expect(isChatEnabled()).toBe(true);
    expect(isDispatcherEnabled()).toBe(true);
    expect(isExperimentEnabled()).toBe(true);
  });
});

describe('with no saved flags, a packaged stable build', () => {
  it('stays on the legacy layout with Chat on by default and writes nothing', () => {
    expect(getSettings()).toEqual({});
    expect(newChromeEnabled()).toBe(false);
    expect(isChatEnabled()).toBe(true);
    expect(isDispatcherFlagOn()).toBe(false);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });
});

describe.each([
  ['a packaged stable build with Preview on', { isPackaged: true, version: '0.42.0', previewChannel: true }],
  ['a packaged beta with Preview off', { isPackaged: true, version: '0.42.0-beta.14', previewChannel: false }],
  ['a packaged beta with Preview on', { isPackaged: true, version: '0.42.0-beta.14', previewChannel: true }],
  ['an unpackaged dev build', { isPackaged: false, version: '0.42.0', previewChannel: false }],
])('%s', (_name, build) => {
  beforeEach(() => {
    h.isPackaged = build.isPackaged;
    h.version = build.version;
    seed({ previewChannel: build.previewChannel });
  });

  it('honours every saved flag', () => {
    expect(getSettings()).toEqual(ALL_SAVED);
    expect(newChromeEnabled()).toBe(true);
    expect(uiChrome()).toBe('v2');
    expect(isChatEnabled()).toBe(true);
    expect(isCopilotSdkEnabled()).toBe(true);
    expect(resolveRuntimeMode('claude-code').mode).toBe('chat');
    expect(isDispatcherEnabled()).toBe(true);
    expect(isExperimentEnabled()).toBe(true);
    expect(dispatcherCapability()).toMatchObject({ newLayout: true, flagOn: true, enabled: true });
  });

  it('saves exactly what it is given', async () => {
    await saveSettings({ chat: false });
    expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ chat: false });
  });
});
