import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => userData.dir, getVersion: () => '0.43.0', isPackaged: false, on: vi.fn(), whenReady: () => Promise.resolve() },
  powerMonitor: { on: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));
vi.mock('../services/project-store', () => ({ list: async () => [{}, {}, {}] }));
vi.mock('../services/theme-service', () => ({ getSettings: () => ({ themeId: 'plugin:ocean-themes:reef' }) }));
vi.mock('../services/clubhouse-mode-settings', () => ({ getSettings: () => ({ enabled: true }) }));
vi.mock('../services/annex-settings', () => ({ getSettings: () => ({ enableServer: false, enableClient: true }) }));
vi.mock('../services/log-settings', () => ({ getSettings: () => ({ enabled: true }) }));

import { ATTR } from '../../shared/telemetry/attributes';
import { flushBeforeExit } from './facade';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import {
  PROCESS_START_MS,
  _resetLifecycleForTests,
  buildStartupTree,
  checkPreviousSession,
  completeStartup,
  installLifecycleTelemetry,
  markStartup,
  recordConfigSnapshot,
  setStartupKind,
  shutdownCompleted,
  shutdownStarted,
  shutdownStep,
} from './lifecycle';
import type { TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'standard',
    flow: vi.fn(),
    step: vi.fn(),
    count: vi.fn(),
    event: vi.fn(),
    exception: vi.fn(),
    replaySpan: vi.fn(),
    replayTree: vi.fn(),
    preview: () => [],
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

let rt: TelemetryRuntime;

beforeEach(() => {
  userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-lifecycle-'));
  rt = fakeRuntime();
  setProducingRuntime(rt);
  installLifecycleTelemetry();
});

afterEach(() => {
  setProducingRuntime(null);
  _resetLifecycleForTests();
  fs.rmSync(userData.dir, { recursive: true, force: true });
});

describe('startup tree', () => {
  it('spans process start to renderer ready, with ordered children inside the root', () => {
    const t = PROCESS_START_MS;
    markStartup('ready', t + 100);
    markStartup('register_ipc_start', t + 110);
    markStartup('register_ipc_end', t + 150);
    markStartup('create_window_start', t + 160);
    markStartup('window_ready_to_show', t + 400);
    setStartupKind('after_update');
    const tree = buildStartupTree(t + 900, { initStartMs: t + 420, settingsLoadedMs: t + 500, pluginsReadyMs: t + 800 });
    expect(tree.root).toMatchObject({ name: 'clubhouse.app.startup', startMs: t, endMs: t + 900, outcome: 'ok' });
    expect(tree.root.attrs).toContainEqual(ATTR.startupKind('after_update'));
    expect(tree.children.map((c) => c.name)).toEqual([
      'clubhouse.app.startup.main_ready',
      'clubhouse.app.startup.register_ipc',
      'clubhouse.app.startup.create_window',
      'clubhouse.app.startup.renderer_init',
      'clubhouse.app.startup.load_settings',
      'clubhouse.app.startup.plugin_system',
    ]);
  });

  it('drops children with missing or inverted marks', () => {
    markStartup('register_ipc_start', PROCESS_START_MS + 50);
    const tree = buildStartupTree(PROCESS_START_MS + 100, { initStartMs: PROCESS_START_MS + 90, settingsLoadedMs: PROCESS_START_MS + 80 });
    expect(tree.children.map((c) => c.name)).toEqual(['clubhouse.app.startup.renderer_init']);
  });

  it('records once, with a duration metric', async () => {
    completeStartup({}, undefined, PROCESS_START_MS + 2000);
    completeStartup({}, undefined, PROCESS_START_MS + 3000);
    expect(rt.replayTree).toHaveBeenCalledTimes(1);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.app.startup.duration', 2, [ATTR.startupKind('cold')]);
  });

  it('marks a failed window load as an error', () => {
    completeStartup(undefined, 'window_load_failed');
    const tree = (rt.replayTree as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(tree.root).toMatchObject({ outcome: 'error', errorType: 'window_load_failed' });
  });
});

describe('shutdown tree', () => {
  it('records the steps under one root plus duration metrics', () => {
    shutdownStarted(1000);
    shutdownStep('pty_kill_all', 1000, 1200, true);
    shutdownStep('agent_config_flush', 1000, 1100, false);
    shutdownCompleted(1300);
    const tree = (rt.replayTree as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(tree.root).toMatchObject({ name: 'clubhouse.app.shutdown', startMs: 1000, endMs: 1300, outcome: 'error' });
    expect(tree.children).toHaveLength(2);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.app.shutdown.duration', 0.3, undefined);
  });

  it('does nothing if shutdown never started', () => {
    shutdownCompleted();
    expect(rt.replayTree).not.toHaveBeenCalled();
  });
});

describe('unclean exits', () => {
  const file = () => path.join(userData.dir, 'telemetry-session.json');

  it('reports a previous session that never marked itself clean', () => {
    fs.writeFileSync(file(), JSON.stringify({ startedAt: 'x', version: '0.42.0', clean: false }));
    checkPreviousSession(false);
    expect(rt.event).toHaveBeenCalledWith('clubhouse.app.unclean_exit', [
      ATTR.previousExit('unknown_exit'),
      ATTR.updateFromVersion('0.42.0'),
    ]);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.app.unclean_exits', 1, [ATTR.previousExit('unknown_exit')]);
  });

  it('labels a crash loop', () => {
    fs.writeFileSync(file(), JSON.stringify({ clean: false }));
    checkPreviousSession(true);
    expect(rt.event).toHaveBeenCalledWith('clubhouse.app.unclean_exit', [ATTR.previousExit('crash_loop')]);
  });

  it('marks the session clean on OS shutdown or logoff, not only on quit', async () => {
    const electron = await import('electron');
    fs.writeFileSync(file(), JSON.stringify({ clean: true }));
    checkPreviousSession(false);
    await Promise.resolve();
    const shutdown = (electron.powerMonitor.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'shutdown')?.[1];
    expect(shutdown).toBeTypeOf('function');
    shutdown();
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).clean).toBe(true);
  });

  it('stays quiet after a clean exit and marks the next exit clean', async () => {
    fs.writeFileSync(file(), JSON.stringify({ clean: true }));
    checkPreviousSession(false);
    expect(rt.event).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).clean).toBe(false);
    await flushBeforeExit(10);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).clean).toBe(true);
  });

  it('never writes the file while telemetry is off', () => {
    setProducingRuntime(null);
    checkPreviousSession(false);
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe('config snapshot', () => {
  it('sends counts and switches, never names', async () => {
    await recordConfigSnapshot();
    const [name, attrs] = (rt.event as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe('clubhouse.app.config_snapshot');
    expect(attrs).toEqual(expect.arrayContaining([
      ATTR.installKind('dev'),
      ATTR.projectsCount(3),
      ATTR.themeKind('plugin'),
      ATTR.clubhouseMode(true),
      ATTR.annexServer(false),
      ATTR.annexClient(true),
      ATTR.loggingEnabled(true),
    ]));
    expect(JSON.stringify(attrs)).not.toContain('ocean');
  });
});
