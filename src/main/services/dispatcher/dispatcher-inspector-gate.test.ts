import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The inspector's gate against the real experimental and update settings
 * stores and a temp userData: main reads Dispatcher debug itself, and a build
 * that isn't preview-eligible reads it as off whatever is saved.
 */

const h = vi.hoisted(() => ({ userData: '', isPackaged: true, version: '0.43.0' }));

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
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { resetAllSettingsStoresForTests } from '../settings-store';
import { DISPATCHER_DEBUG_FLAG } from '../../../shared/types';
import { assertDispatcherDebugOn, isDispatcherDebugOn, InspectorError } from './dispatcher-inspector';

function write(name: string, value: unknown): void {
  fs.writeFileSync(path.join(h.userData, name), typeof value === 'string' ? value : JSON.stringify(value));
  resetAllSettingsStoresForTests();
}

function previewChannel(on: boolean): void {
  write('update-settings.json', { autoUpdate: false, previewChannel: on, lastCheck: null, dismissedVersion: null, lastSeenVersion: null });
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-inspector-gate-'));
  h.isPackaged = true;
  h.version = '0.43.0-beta.8';
  resetAllSettingsStoresForTests();
});

afterEach(() => {
  resetAllSettingsStoresForTests();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe('Dispatcher debug gate', () => {
  it('is off with nothing saved and when saved off, and refuses with debug_off', () => {
    expect(isDispatcherDebugOn()).toBe(false);
    write('experimental-settings.json', { [DISPATCHER_DEBUG_FLAG]: false });
    expect(isDispatcherDebugOn()).toBe(false);
    expect(() => assertDispatcherDebugOn()).toThrow(InspectorError);
    try { assertDispatcherDebugOn(); } catch (err) { expect((err as InspectorError).code).toBe('debug_off'); }
  });

  it('is on in a preview build when saved on', () => {
    write('experimental-settings.json', { [DISPATCHER_DEBUG_FLAG]: true });
    expect(isDispatcherDebugOn()).toBe(true);
    expect(() => assertDispatcherDebugOn()).not.toThrow();
  });

  it('is off in a stable build even when saved on, and the saved value stays', () => {
    h.version = '0.43.0';
    previewChannel(false);
    write('experimental-settings.json', { [DISPATCHER_DEBUG_FLAG]: true });
    expect(isDispatcherDebugOn()).toBe(false);
    expect(() => assertDispatcherDebugOn()).toThrow('dispatcher_inspector:debug_off');
    expect(JSON.parse(fs.readFileSync(path.join(h.userData, 'experimental-settings.json'), 'utf-8'))[DISPATCHER_DEBUG_FLAG]).toBe(true);
    // A stable build on the preview channel is preview-eligible, as for every preview-only flag.
    previewChannel(true);
    expect(isDispatcherDebugOn()).toBe(true);
  });

  it('is off while the settings file cannot be read', () => {
    write('experimental-settings.json', `{ "${DISPATCHER_DEBUG_FLAG}": tru`);
    expect(isDispatcherDebugOn()).toBe(false);
  });

  it('turns off when the file becomes unreadable after it was read as on', () => {
    write('experimental-settings.json', { [DISPATCHER_DEBUG_FLAG]: true });
    expect(isDispatcherDebugOn()).toBe(true);
    // The store keeps its cached "on"; no reset, as in a running app.
    fs.writeFileSync(path.join(h.userData, 'experimental-settings.json'), '{ "dispatcherDebug": tr');
    expect(isDispatcherDebugOn()).toBe(false);
    expect(() => assertDispatcherDebugOn()).toThrow('dispatcher_inspector:debug_off');
  });

  it('accepts only a real true', () => {
    write('experimental-settings.json', { [DISPATCHER_DEBUG_FLAG]: 'true' });
    expect(isDispatcherDebugOn()).toBe(false);
  });
});
