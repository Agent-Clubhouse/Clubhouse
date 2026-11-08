/**
 * The satellite side of annex-session.test.ts, in its own process because each side
 * has its own identity. The real Annex server, canvas storage, pty-manager and
 * terminal mirror, in the folder it's given. Fixtures: the project and agent lists,
 * and node-pty, so output is what the control port says. Runs when asked, as
 * `npm run harness:annex-session` does.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { describe, it, vi } from 'vitest';

const S = vi.hoisted(() => {
  const dir = process.env.CLUBHOUSE_ANNEX_SESSION_DIR ?? '/nonexistent';
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    dir,
    fault: (process.env.CLUBHOUSE_ANNEX_SESSION_FAULT ?? 'none') as 'none' | 'fail' | 'hang',
    releaseHung: [] as Array<() => void>,
    projectListeners: new Set<() => void>(),
    projectIds: [] as string[],
    /** The fake PTY's way out: what a process wrote. */
    output: null as null | ((data: string) => void),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => S.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'annex-session', on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {},
  dialog: {},
  Notification: class {},
}));
vi.mock('bonjour-service', () => ({ default: class { publish() { return { stop() {} }; } destroy() {} } }));
vi.mock('../../src/main/services/log-service', () => ({ appLog: () => {} }));
vi.mock('../../src/main/services/annex-network-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/services/annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));
vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], options: { cols: number; rows: number }) => {
    const dataListeners: Array<(data: string) => void> = [];
    S.output = (data) => { for (const listener of dataListeners) listener(data); };
    return {
      pid: 1, cols: options.cols, rows: options.rows, process: 'fake',
      onData: (listener: (data: string) => void) => { dataListeners.push(listener); return { dispose() {} }; },
      onExit: () => ({ dispose() {} }),
      write() {}, kill() {}, pause() {}, resume() {}, clear() {},
      resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; },
    };
  },
}));
vi.mock('../../src/main/util/shell', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/util/shell')>(),
  getShellEnvironment: () => ({ PATH: '/usr/bin:/bin', HOME: S.dir }),
}));
vi.mock('../../src/main/services/project-store', () => ({
  list: async () => {
    if (S.fault === 'fail') throw new Error('harness: read failed');
    return S.projectIds.map((id) => ({ id, name: id, path: path.join(S.dir, 'projects', id), color: 'indigo' }));
  },
  iconFilePath: async () => null,
  readIconData: async () => null,
  onProjectsChanged: (listener: () => void) => {
    S.projectListeners.add(listener);
    return () => S.projectListeners.delete(listener);
  },
}));
vi.mock('../../src/main/services/agent-config', () => ({
  listDurable: async (projectPath: string) => [{ id: `durable_${path.basename(projectPath)}`, name: 'agent', color: 'indigo', createdAt: '2026-01-01T00:00:00.000Z' }],
  agentIconFilePath: async () => null,
  readAgentIconData: async () => null,
  getDurableConfig: async () => null,
  isSameProject: async () => false,
  onAgentConfigChanged: () => () => {},
}));
vi.mock('../../src/main/services/plugin-storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/services/plugin-storage')>();
  return {
    ...real,
    // Real files, but a build can be told to hang here, as a slow disk would.
    readKey: async (request: Parameters<typeof real.readKey>[0]) => {
      if (S.fault === 'hang' && request.key === 'canvas-instances' && request.scope === 'global') {
        await new Promise<void>((resolve) => { S.releaseHung.push(resolve); });
      }
      return real.readKey(request);
    },
  };
});
vi.mock('../../src/main/services/plugin-manifest-registry', () => ({ listAllManifests: () => [] }));
vi.mock('../../src/main/services/group-project-registry', () => ({ groupProjectRegistry: { list: async () => [], onChange: () => () => {} } }));
vi.mock('../../src/main/services/clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [], onBindingsChanged: () => () => {} } }));

import * as annexServer from '../../src/main/services/annex-server';
import * as eventReplay from '../../src/main/services/annex-event-replay';
import * as ptyManager from '../../src/main/services/pty-manager';
import { writeKey } from '../../src/main/services/plugin-storage';
import { publishChatEvent } from '../../src/main/services/agent-runtime';

/** Canvases that are `kilobytes` of JSON, in views as a real canvas has them. */
function canvasesOf(id: string, kilobytes: number) {
  const views = Array.from({ length: Math.ceil(kilobytes / 4) }, (_, v) => ({
    id: `view_${v}`, type: 'anchor', title: `view ${v}`, position: { x: v, y: v }, size: { width: 300, height: 200 }, zIndex: v, label: 'n'.repeat(4000),
  }));
  return [
    { id: `${id}_main`, name: 'Main', views, viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: views.length, zoomedViewId: null },
    { id: `${id}_other`, name: 'Other', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
  ];
}

async function addProject(id: string, kilobytes: number): Promise<void> {
  const projectPath = path.join(S.dir, 'projects', id);
  fs.mkdirSync(projectPath, { recursive: true });
  await writeKey({ pluginId: 'canvas', scope: 'project-local', key: 'canvas-instances', value: canvasesOf(id, kilobytes), projectPath });
  await writeKey({ pluginId: 'canvas', scope: 'project-local', key: 'canvas-active-id', value: `${id}_main`, projectPath });
  S.projectIds.push(id);
}

function setFault(fault: typeof S.fault): void {
  S.fault = fault;
  if (fault !== 'hang') for (const release of S.releaseHung.splice(0)) release();
}

/** One line of a full terminal with truecolor on every cell, as #2682 measured. */
function colorfulLine(n: number, cols: number): string {
  const label = `line-${n} `;
  let line = label;
  for (let c = label.length; c < cols; c++) line += `\x1b[38;2;${n % 256};${c % 256};99;48;2;${c % 256};${n % 256};7mx`;
  return `${line}\x1b[0m\r\n`;
}

/** Output in chunks with room between them, as a process writes it. */
async function writeTerminalLines(from: number, count: number, cols: number): Promise<void> {
  for (let n = from; n < from + count; n += 200) {
    let chunk = '';
    for (let i = n; i < Math.min(n + 200, from + count); i++) chunk += colorfulLine(i, cols);
    S.output!(chunk);
    await new Promise((r) => setImmediate(r));
  }
}

const describeWhenAsked = process.env.CLUBHOUSE_ANNEX_SESSION_DIR ? describe : describe.skip;

describeWhenAsked('Annex session satellite', () => {
  it('serves until told to stop', async () => {
    // A restart keeps what's on disk, and finds the same projects.
    const known = path.join(S.dir, 'projects');
    if (fs.existsSync(known)) S.projectIds.push(...fs.readdirSync(known).sort());
    else {
      await addProject('proj_0', 5 * 1024);
      await addProject('proj_1', 5 * 1024);
      await writeKey({ pluginId: 'canvas', scope: 'global', key: 'canvas-instances', value: canvasesOf('app', 4), projectPath: undefined });
    }

    // Both clients of the session pair with the one PIN this prints, so it stays usable.
    annexServer._testing.setPinReusable(true);
    annexServer.start();
    await vi.waitFor(() => { if (!(annexServer.getStatus().port > 0)) throw new Error('not yet'); }, { timeout: 20_000 });

    await new Promise<void>((resolve) => {
      const control = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
          void (async () => {
            const body = text ? JSON.parse(text) : {};
            let answer: object = {};
            // `keepHung` leaves reads already hung as they are, so only new ones go normally.
            if (req.url === '/fault') { if (body.keepHung) S.fault = body.fault; else setFault(body.fault); }
            if (req.url === '/release-hung') setFault(S.fault);
            if (req.url === '/add-project') { await addProject(body.id, body.kilobytes ?? 1); }
            if (req.url === '/projects-changed') for (const listener of S.projectListeners) listener();
            if (req.url === '/chat-event') publishChatEvent({ agentId: 'durable_proj_0', type: 'turn_ended', seq: 1, ts: 0, sessionId: 's', data: {} } as never);
            if (req.url === '/spawn-terminal') {
              // Only checked to exist: the fake runs nothing there. macOS temp folders count as restricted.
              await ptyManager.spawn(body.agentId, process.cwd(), '/bin/true');
              S.output!('shell ready');
              ptyManager.resize(body.agentId, body.cols, 30);
            }
            if (req.url === '/terminal-lines') await writeTerminalLines(body.from, body.count, body.cols);
            // Stopped and started in place, as the app does when Annex is switched off and on.
            if (req.url === '/restart-in-place') {
              annexServer.stop();
              annexServer.start();
              await vi.waitFor(() => { if (!(annexServer.getStatus().port > 0)) throw new Error('not yet'); }, { timeout: 20_000 });
            }
            if (req.url === '/state') {
              const status = annexServer.getStatus();
              answer = { port: status.port, pairingPort: status.pairingPort, pin: status.pin, pairingUrl: status.pairingUrl };
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ...answer, fault: S.fault, lastSeq: eventReplay.getLastSeq() }));
            if (req.url === '/stop') {
              setFault('none');
              annexServer.stop();
              annexServer._testing.setPinReusable(false);
              control.close();
              resolve();
            }
          })().catch((err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err) }));
          });
        });
      });
      control.listen(0, '127.0.0.1', () => {
        const status = annexServer.getStatus();
        console.info(`ANNEX_SESSION ${JSON.stringify({ port: status.port, pairingPort: status.pairingPort, pin: status.pin, pairingUrl: status.pairingUrl, controlPort: (control.address() as { port: number }).port })}`);
      });
    });
  }, 24 * 60 * 60 * 1000);
});
