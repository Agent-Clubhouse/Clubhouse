import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ dir: '', toast: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir, isPackaged: false } }));
vi.mock('../../renderer/stores/toastStore', () => ({ useToastStore: { getState: () => ({ addToast: fixture.toast }) } }));
vi.mock('../../renderer/stores/uiStore', () => ({ useUIStore: { getState: () => ({ openRuntimeSettings: vi.fn() }) } }));

import * as flags from './experimental-settings';
import { resetAllSettingsStoresForTests } from './settings-store';
import { showChatDefaultTip, CHAT_MESSAGE_SHOWN_KEY, CHAT_TIP_RULED_OUT_KEY } from '../../renderer/features/agents/chat/chat-default-tip';

beforeEach(() => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-tip-'));
  fixture.toast.mockClear();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  vi.stubGlobal('window', { clubhouse: {
    app: { isExperimentalSettingsUnreadable: async () => flags.savedSettingsUnreadable(), getExperimentalSettings: async () => flags.getSettingsForRenderer() },
    chat: { getRuntimeSettings: async () => ({}), getAgentRuntime: async () => ({ chat: true }) },
    project: { list: async () => [{ path: '/synthetic' }] },
    agent: { listDurable: async () => [{ id: 'a1' }] },
  } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAllSettingsStoresForTests();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

it('keeps the decision pending through a corrupt flags launch, then shows once after recovery', async () => {
  const filename = path.join(fixture.dir, 'experimental-settings.json');
  fs.writeFileSync(filename, '{broken');
  await showChatDefaultTip();
  expect(fixture.toast).not.toHaveBeenCalled();
  expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();
  expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBeNull();
  expect(fs.readFileSync(filename, 'utf8')).toBe('{broken');

  fs.writeFileSync(filename, '{}');
  resetAllSettingsStoresForTests(); // next launch
  await showChatDefaultTip();
  expect(fixture.toast).toHaveBeenCalledTimes(1);
  resetAllSettingsStoresForTests(); // another launch
  await showChatDefaultTip();
  expect(fixture.toast).toHaveBeenCalledTimes(1);
});
