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
    getDispatcherState: () => {
      const { enabled, savedOn, reason } = settings.dispatcherEnablement();
      return { enabled, savedOn, offReason: reason, flagOn: true, classic: false, running: false, agentId: null, path: null, config: null };
    },
    isDispatcherAgentId: () => false,
    onDispatcherChanged: () => () => {},
  };
});

import { resetAllSettingsStoresForTests } from './settings-store';
import { getSettings, getSettingsForRenderer, getStoredSettings, isGraduatedFeatureOn, saveSettings } from './experimental-settings';
import { isPreviewEligible } from './preview-eligible';
import { isChatEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { dispatcherEnablement, isDispatcherEnabled } from './dispatcher/dispatcher-settings';
import { dispatcherCapability } from './mobile-dispatcher';
import { applyExportGraduation, getTelemetrySettings } from '../telemetry/settings';
import { isTelemetryConfigured, uiChrome } from '../telemetry/bootstrap';
import { newChromeEnabled, resetNewChromeCacheForTests } from '../window-chrome';
import { NEW_CHROME_FLAG } from '../../shared/chrome-flag';
import { COPILOT_SDK_FLAG, RICH_CHAT_CONTENT_FLAG } from '../../shared/chat';
import { isGraduatedFlagOn } from '../../shared/graduated-flags';
import { TELEMETRY_CONSENT_VERSION } from '../../shared/telemetry/settings-types';
import { COPILOT_ACP_REMOVED_NOTICE_KEY, PREVIEW_ONLY_EXPERIMENTAL_FLAGS, STRUCTURED_MODE_REMOVED_NOTICE_KEY } from '../../shared/types';

const ALL_SAVED = {
  newChrome: true,
  goobers: true,
  chat: true,
  richChatContent: true,
  copilotSdk: true,
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

describe('chat and rich content, in any build', () => {
  const corrupt = () => {
    fs.writeFileSync(path.join(h.userData, EXPERIMENTAL_FILE), '{ "chat": fal');
    relaunch();
  };

  it('are on with the file or key missing', () => {
    expect(isChatEnabled()).toBe(true);
    expect(isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG)).toBe(true);
    write(EXPERIMENTAL_FILE, { goobers: true });
    relaunch();
    expect(isChatEnabled()).toBe(true);
    expect(isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG)).toBe(true);
    expect(getSettingsForRenderer()).not.toHaveProperty('chat');
  });

  it('are off when saved false', () => {
    write(EXPERIMENTAL_FILE, { chat: false, [RICH_CHAT_CONTENT_FLAG]: false });
    relaunch();
    expect(isChatEnabled()).toBe(false);
    expect(isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG)).toBe(false);
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'terminal' });
  });

  it('are off while the file can\'t be read, since a saved false may be in it', () => {
    corrupt();
    expect(getSettings()).toEqual({});
    expect(isChatEnabled()).toBe(false);
    expect(isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG)).toBe(false);
    expect(resolveRuntimeMode('claude-code', 'chat')).toEqual({ mode: 'terminal' });
  });

  it('an unrelated save over the file keeps the classic layout, and the toggle returns to new', async () => {
    corrupt();
    expect(newChromeEnabled()).toBe(false);
    await saveSettings({ ...getSettingsForRenderer(), themeGradients: true });
    expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toMatchObject({ [NEW_CHROME_FLAG]: false, themeGradients: true });

    relaunch();
    expect(newChromeEnabled()).toBe(false);
    expect(uiChrome()).toBe('legacy');

    await saveSettings({ ...getSettingsForRenderer(), [NEW_CHROME_FLAG]: true });
    relaunch();
    expect(newChromeEnabled()).toBe(true);
    expect(uiChrome()).toBe('v2');
  });

  it('read the same way in the renderer, and only they are forced off', () => {
    corrupt();
    expect(getSettingsForRenderer()).toEqual({ chat: false, [RICH_CHAT_CONTENT_FLAG]: false, [NEW_CHROME_FLAG]: false });
    expect(isGraduatedFlagOn(getSettingsForRenderer(), 'themeGradients')).toBe(true);
  });

  it('come back once the file is readable again', () => {
    corrupt();
    write(EXPERIMENTAL_FILE, { goobers: true });
    relaunch();
    expect(isChatEnabled()).toBe(true);
    expect(isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG)).toBe(true);
  });
});

describe('the preview-only list', () => {
  it('names each feature by the same key its reader uses', () => {
    expect([...PREVIEW_ONLY_EXPERIMENTAL_FLAGS].sort()).toEqual([
      'goobers', COPILOT_SDK_FLAG,
    ].sort());
  });
});

describe('the removed legacy Copilot ACP opt-in, in a packaged stable build (#2868)', () => {
  it.each([false, true])('Preview %s: the flag is dropped, with a notice only when it selected ACP', (previewChannel) => {
    write(UPDATE_FILE, { autoUpdate: false, previewChannel, lastCheck: null, dismissedVersion: null, lastSeenVersion: null });
    write(EXPERIMENTAL_FILE, { goobers: true, copilotLegacyAcp: true });
    relaunch();
    const stored = getStoredSettings();
    expect(stored).not.toHaveProperty('copilotLegacyAcp');
    expect(stored.goobers).toBe(true);
    expect(stored[COPILOT_ACP_REMOVED_NOTICE_KEY] === true).toBe(previewChannel);
  });
});

describe('the Dispatcher on the real default layout and the real Classic setting', () => {
  const ON = { enabled: true, savedOn: true, reason: null };
  const CLASSIC = { enabled: false, savedOn: false, reason: 'classic_layout' };
  const exists = (name: string) => fs.existsSync(path.join(h.userData, name));

  it.each([false, true])('a fresh profile has it on, with nothing saved (Preview %s)', (previewChannel) => {
    if (previewChannel) write(UPDATE_FILE, { autoUpdate: false, previewChannel, lastCheck: null, dismissedVersion: null, lastSeenVersion: null });
    relaunch();
    expect(newChromeEnabled()).toBe(true);
    expect(dispatcherEnablement()).toEqual(ON);
    for (const name of [EXPERIMENTAL_FILE, DISPATCHER_FILE, 'mcp-settings.json']) expect(exists(name)).toBe(false);
  });

  it('ignores an MCP switch saved off before the Clubhouse MCP was always on', () => {
    write('mcp-settings.json', { enabled: false, projectDefault: false });
    relaunch();
    expect(dispatcherEnablement()).toEqual(ON);
    expect(exists(DISPATCHER_FILE)).toBe(false);
  });

  it('Classic layout with nothing saved has it off, and the phone is told the layout is why', () => {
    write(EXPERIMENTAL_FILE, { newChrome: false });
    relaunch();
    expect(dispatcherEnablement()).toEqual(CLASSIC);
    expect(dispatcherCapability()).toMatchObject({ newLayout: false, flagOn: true, enabled: false });
  });

  it('Classic layout honours a saved switch both ways', () => {
    write(EXPERIMENTAL_FILE, { newChrome: false });
    write(DISPATCHER_FILE, { enabled: true });
    relaunch();
    expect(dispatcherEnablement()).toEqual(ON);

    write(DISPATCHER_FILE, { enabled: false });
    relaunch();
    expect(dispatcherEnablement()).toEqual({ enabled: false, savedOn: false, reason: 'switch_off' });
  });

  it('unreadable flags start on classic, so it reads as Classic layout, whatever the file held', () => {
    fs.writeFileSync(path.join(h.userData, EXPERIMENTAL_FILE), '{"newChrome": tr');
    relaunch();
    expect(newChromeEnabled()).toBe(false);
    expect(dispatcherEnablement()).toEqual(CLASSIC);
  });

  it('the Classic switch applies at the next launch, in both directions, and never saves the Dispatcher', async () => {
    relaunch();
    expect(newChromeEnabled()).toBe(true);
    await saveSettings({ newChrome: false });
    // The session keeps its layout, so it is still on until the restart the help text asks for.
    expect(dispatcherEnablement()).toEqual(ON);
    relaunch();
    expect(dispatcherEnablement()).toEqual(CLASSIC);

    await saveSettings({ newChrome: true });
    expect(dispatcherEnablement()).toEqual(CLASSIC);
    relaunch();
    expect(dispatcherEnablement()).toEqual(ON);
    expect(exists(DISPATCHER_FILE)).toBe(false);
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

  it('keeps honouring the saved layout, the graduated flags and the structured-mode notice marker, and reads through the saved telemetry flag', () => {
    expect(getSettings()).toEqual({ newChrome: true, chat: true, [RICH_CHAT_CONTENT_FLAG]: true, themeGradients: true, telemetry: true, [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true });
  });

  it('still reports what is saved through getStoredSettings', () => {
    expect(getStoredSettings()).toEqual(ALL_SAVED);
  });

  it('starts on the new layout, for main, telemetry and the phone', () => {
    expect(newChromeEnabled()).toBe(true);
    expect(uiChrome()).toBe('v2');
    expect(dispatcherCapability()).toMatchObject({ newLayout: true, flagOn: true, enabled: true });
  });

  it('starts on the classic layout with a saved false, for main, telemetry and the phone', () => {
    write(EXPERIMENTAL_FILE, { ...ALL_SAVED, newChrome: false });
    relaunch();
    expect(newChromeEnabled()).toBe(false);
    expect(uiChrome()).toBe('legacy');
    // A saved true stays on in the classic layout, where it can be turned off and not on again (#2565).
    expect(dispatcherCapability()).toMatchObject({ newLayout: false, flagOn: true, enabled: true });
  });

  it('leaves the saved layout as it is on the way through a launch', () => {
    write(EXPERIMENTAL_FILE, { newChrome: false });
    relaunch();
    const saved = bytes(EXPERIMENTAL_FILE);
    expect(newChromeEnabled()).toBe(false);
    expect(bytes(EXPERIMENTAL_FILE)).toBe(saved);
  });

  it('runs a Chat-mode agent in chat, with the standard Copilot SDK, and leaves its saved choices alone', () => {
    const saved = bytes(CHAT_RUNTIME_FILE);
    expect(isChatEnabled()).toBe(true);
    expect(resolveRuntimeMode('copilot-cli', 'chat')).toEqual({ mode: 'chat', driver: 'copilot_sdk' });
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

  it('keeps the Dispatcher on with an MCP switch saved off from before, without changing its saved switch', () => {
    write('mcp-settings.json', { enabled: false, projectDefault: false });
    relaunch();
    const saved = bytes(DISPATCHER_FILE);
    expect(isDispatcherEnabled()).toBe(true);
    expect(bytes(DISPATCHER_FILE)).toBe(saved);
  });

  it('switches a dormant telemetry setup off for good, keeping consent and the confirmed host', async () => {
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

    expect(isTelemetryConfigured()).toBe(false);
    const loaded = getTelemetrySettings();
    expect(loaded.consentVersion).toBe(TELEMETRY_CONSENT_VERSION);
    expect(loaded.destinations.find((d) => d.id === 'azure')).toMatchObject({ enabled: false, confirmedHost: file.destinations[0].confirmedHost });
    await applyExportGraduation()?.saved;

    // Turning Preview on later doesn't bring it back: the flag was the old gate, and it's gone.
    write(UPDATE_FILE, { autoUpdate: false, previewChannel: true, lastCheck: null, dismissedVersion: null, lastSeenVersion: null });
    relaunch();
    expect(getTelemetrySettings().destinations.some((d) => d.enabled)).toBe(false);
    expect(isTelemetryConfigured()).toBe(false);
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
      await saveSettings({ copilotSdk: true });
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ copilotSdk: false });
    });

    it('can change a graduated flag, so a saved false has a way back', async () => {
      write(EXPERIMENTAL_FILE, { chat: false, [RICH_CHAT_CONTENT_FLAG]: false, themeGradients: false, goobers: true });
      relaunch();
      await saveSettings({ ...getSettings(), chat: true, [RICH_CHAT_CONTENT_FLAG]: true, themeGradients: true });
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ chat: true, [RICH_CHAT_CONTENT_FLAG]: true, themeGradients: true, goobers: true });
    });

    it('saves the layout choice, as the Display toggle does, and keeps the preview-only flags', async () => {
      await saveSettings({ ...getSettings(), newChrome: false });
      expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ ...ALL_SAVED, newChrome: false });
      relaunch();
      expect(newChromeEnabled()).toBe(false);
    });

    it('never touches the Preview opt-in', async () => {
      const saved = bytes(UPDATE_FILE);
      await saveSettings(getSettings());
      expect(bytes(UPDATE_FILE)).toBe(saved);
      expect(isPreviewEligible()).toBe(false);
    });

    it('serializes with the store, so two writes in a row both land and keep the flags', async () => {
      await Promise.all([saveSettings({ newChrome: true, themeGradients: false }), saveSettings({ newChrome: true, themeGradients: true })]);
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
  });
});

describe('with no saved flags, a packaged stable build', () => {
  it('starts on the new layout with Chat and the Dispatcher on, the Preview features off, and writes nothing', () => {
    expect(getSettings()).toEqual({});
    expect(newChromeEnabled()).toBe(true);
    expect(uiChrome()).toBe('v2');
    expect(isChatEnabled()).toBe(true);
    expect(isDispatcherEnabled()).toBe(true);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });
});

describe.each([
  ['truncated JSON', '{"newChrome": fal'],
  ['an empty file', ''],
  ['null', 'null'],
  ['an array', '[]'],
])('with %s for saved flags', (_name, content) => {
  it('starts on the classic layout, as it did before the default changed, and leaves the file', () => {
    fs.writeFileSync(path.join(h.userData, EXPERIMENTAL_FILE), content);
    relaunch();
    expect(newChromeEnabled()).toBe(false);
    expect(uiChrome()).toBe('legacy');
    expect(bytes(EXPERIMENTAL_FILE)).toBe(content);
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
    expect(resolveRuntimeMode('copilot-cli', 'chat')).toEqual({ mode: 'chat', driver: 'copilot_sdk' });
    expect(resolveRuntimeMode('claude-code').mode).toBe('chat');
    expect(isDispatcherEnabled()).toBe(true);
    expect(dispatcherCapability()).toMatchObject({ newLayout: true, flagOn: true, enabled: true });
  });

  it('saves what it is given, except the telemetry flag, which main owns', async () => {
    await saveSettings({ chat: false, telemetry: false });
    expect(JSON.parse(bytes(EXPERIMENTAL_FILE))).toEqual({ chat: false, telemetry: true });
  });
});
