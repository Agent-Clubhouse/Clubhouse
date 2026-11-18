import { test as base, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { launchApp, type LaunchedApp } from '../launch';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { addProject, assertRunLayout, createDurableAgent } from '../smoke-helpers';
import { isNewLayout } from '../layout';
import { untrackOpenApp } from '../e2e-cleanup';
import type { McpToolResult } from '../../src/main/services/clubhouse-mcp/types';
import { assertDialAudit, assertListenerAudit, childGuardEnv, sentinel, transparentForward, type DialAttempt, type ListenerAccept } from '../../test/annex-v2/reverse-parity-fixture';

interface MainGuard {
  read(): { installed: boolean; attempts: DialAttempt[]; accepts: ListenerAccept[] };
}
type GuardGlobal = typeof globalThis & { __reverseP8?: MainGuard };

/** Evaluated only in a test-owned Electron main process; no shipped switch or production seam. */
async function guardMain(app: LaunchedApp, forward: number | null, sentinelPort: number) {
  const calibration = await app.electronApp.evaluate(async ({ app: electron }, input) => {
    const fs = process.getBuiltinModule('fs');
    const net = process.getBuiltinModule('net');
    if (fs.realpathSync(electron.getPath('userData')) !== fs.realpathSync(input.profile)) throw new Error('Wrong reverse fixture profile');
    const state = globalThis as GuardGlobal;
    if (state.__reverseP8) throw new Error('Reverse dial guard already installed');
    const original = net.Socket.prototype.connect;
    const attempts: DialAttempt[] = [];
    const accepts: ListenerAccept[] = [];
    const emit = net.Server.prototype.emit;
    const listenerEmit: typeof emit = function (this: net.Server, event: string | symbol, ...args: unknown[]) {
      const socket = args[0];
      if (event === 'connection' && socket instanceof net.Socket && socket.localPort && socket.remotePort) {
        accepts.push({ localPort: socket.localPort, remotePort: socket.remotePort });
      }
      return Reflect.apply(emit, this, [event, ...args]);
    };
    net.Server.prototype.emit = listenerEmit;
    const patched: typeof original = function (this: net.Socket, ...args: unknown[]) {
      const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
      let host: string, port: number;
      if (first && typeof first === 'object') {
        if ('path' in first && first.path && !('port' in first)) return Reflect.apply(original, this, args);
        if (!('port' in first)) throw new Error('Unrecognized reverse fixture dial');
        port = Number(first.port);
        host = 'host' in first && typeof first.host === 'string' ? first.host : 'localhost';
      } else if (typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first)) {
        port = Number(first);
        host = typeof args[1] === 'string' ? args[1] : 'localhost';
      } else if (typeof first === 'string') {
        return Reflect.apply(original, this, args);
      } else {
        throw new Error('Unrecognized reverse fixture dial');
      }
      const allowed = input.forward !== null && host === '127.0.0.1' && port === input.forward;
      const attempt: DialAttempt = { host, port, allowed, outcome: allowed ? 'pending' : 'denied' };
      attempts.push(attempt);
      if (!allowed) {
        process.nextTick(() => this.destroy(Object.assign(new Error('Reverse fixture blocked direct dial'), { code: 'ERR_REVERSE_DIAL_BLOCKED' })));
        return this;
      }
      this.once('connect', () => { attempt.outcome = 'connected'; attempt.localPort = this.localPort; });
      this.once('error', (error: NodeJS.ErrnoException) => { attempt.outcome = 'error'; attempt.error = error.code; });
      return Reflect.apply(original, this, args);
    };
    net.Socket.prototype.connect = patched;
    state.__reverseP8 = { read: () => ({ installed: net.Socket.prototype.connect === patched && net.Server.prototype.emit === listenerEmit, attempts, accepts }) };
    Object.assign(process.env, input.childEnv);
    return new Promise<string>((resolve) => {
      const socket = net.connect(input.sentinelPort, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve('escaped'); });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
    });
  }, { profile: app.userDataDir, forward, sentinelPort, childEnv: childGuardEnv(forward === null ? null : { port: forward }) });
  expect(calibration).toBe('ERR_REVERSE_DIAL_BLOCKED');
}

export async function connectMcp(desk: ReverseDesk) {
  let report: Awaited<ReturnType<FakeClis['report']>>;
  await expect.poll(async () => {
    report = await desk.fakes.report('claude', desk.agentId);
    return report.env.CLUBHOUSE_AGENT_ID;
  }, { timeout: 20_000 }).toBe(desk.agentId);
  const env = report!.env;
  let session: string | null = null, id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${env.CLUBHOUSE_MCP_PORT}/mcp/${desk.agentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clubhouse-Nonce': env.CLUBHOUSE_HOOK_NONCE ?? '', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.ok).toBe(true);
    session = response.headers.get('mcp-session-id') ?? session;
    const envelope = await response.json();
    if (envelope.error) throw new Error(JSON.stringify(envelope.error));
    return envelope.result;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reverse-parity-fixture', version: '1' } });
  return {
    names: async (): Promise<string[]> => (await rpc('tools/list')).tools.map((tool: { name: string }) => tool.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const result: McpToolResult = await rpc('tools/call', { name, arguments: args });
      const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      return { isError: result.isError === true, text };
    },
  };
}

export async function toolWithSuffix(mcp: Awaited<ReturnType<typeof connectMcp>>, suffix: string): Promise<string> {
  let name = '';
  await expect.poll(async () => {
    name = (await mcp.names()).find((candidate) => candidate.endsWith(suffix)) ?? '';
    return !!name;
  }).toBe(true);
  return name;
}

export interface ReverseDesk {
  app: LaunchedApp;
  fakes: FakeClis;
  root: string;
  projectId: string;
  agentId: string;
  fingerprint: string;
}

export interface ReverseDesktops {
  a: ReverseDesk;
  b: ReverseDesk;
  directions: Array<readonly [ReverseDesk, ReverseDesk]>;
  forward: Awaited<ReturnType<typeof transparentForward>>;
}

export const test = base.extend<{ reverse: ReverseDesktops; reverseScenario: 'quiet' | 'multi-turn' }>({
  reverseScenario: ['quiet', { option: true }],
  reverse: async ({ reverseScenario }, use, info) => {
    const cache = path.resolve('node_modules/.cache');
    await fs.promises.mkdir(cache, { recursive: true });
    const scratch = await fs.promises.mkdtemp(path.join(cache, 'reverse-hosted-'));
    const apps: LaunchedApp[] = [];
    const fakes: FakeClis[] = [];
    let guard: Awaited<ReturnType<typeof sentinel>> | undefined;
    let forward: Awaited<ReturnType<typeof transparentForward>> | undefined;
    const gitConfig = path.join(scratch, 'gitconfig');
    await fs.promises.writeFile(gitConfig, '');
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, args: string[]) => promisify(execFile)('git', args, { cwd, env: gitEnv });
    const errors: unknown[] = [];
    const listeners: number[][] = [];
    try {
      guard = await sentinel();
      forward = await transparentForward();
      const quiet = path.join(scratch, 'quiet.jsonl');
      const header = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
      await fs.promises.writeFile(quiet, `${header.join('\n')}\n`);
      const launch = async (label: string): Promise<ReverseDesk> => {
        const cli = await installFakeClis({ claude: reverseScenario === 'quiet' ? quiet : 'multi-turn' });
        fakes.push(cli);
        const root = path.join(scratch, label);
        await fs.promises.mkdir(root);
        await git(root, ['init', '--quiet', '--template=', '--initial-branch=main']);
        await git(root, ['config', 'user.name', 'Reverse Fixture']);
        await git(root, ['config', 'user.email', 'reverse@example.invalid']);
        await git(root, ['config', 'commit.gpgSign', 'false']);
        await git(root, ['config', 'core.hooksPath', path.join(scratch, 'no-hooks')]);
        await git(root, ['config', 'core.autocrlf', 'false']);
        await fs.promises.writeFile(path.join(root, '.gitignore'), '.clubhouse/\nfixtures/\n');
        await fs.promises.writeFile(path.join(root, 'fixture.txt'), `bytes from ${label}\n`);
        await git(root, ['add', '--', '.gitignore', 'fixture.txt']);
        await git(root, ['commit', '--quiet', '-m', 'Fixture baseline']);
        await git(root, ['config', 'remote.origin.url', 'https://example.invalid/reverse.git']);
        await git(root, ['config', `url.${pathToFileURL(path.join(scratch, 'absent.git')).href}.insteadOf`, 'https://example.invalid/reverse.git']);
        const app = await launchApp({
          label: `reverse-${label}`, args: ['--disable-gpu'],
          userDataFiles: {
            'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
            'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
            'dispatcher-settings.json': { setup: { status: 'done', upgrade: false } },
            'annex-settings.json': { enableServer: false, enableClient: false, loopbackOnly: true, deviceName: label, alias: label, icon: 'computer', color: 'indigo', autoReconnect: true },
          },
          env: { ...cli.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1' },
        });
        apps.push(app);
        await guardMain(app, label === 'A' ? forward!.port : null, guard!.port);
        await assertRunLayout(app.window);
        await addProject(app.electronApp, app.window, root);
        const agentId = await createDurableAgent(app.window, { projectName: label, name: `reverse-${label}`, orchestrator: 'claude-code' });
        if (!(await isNewLayout(app.window))) await app.window.getByTestId(`agent-item-${agentId}`).click();
        await expect(app.window.locator(`[data-testid="chat-view"][data-agent-pane="${agentId}"][data-view-context="main"]`)).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
        const projects: Array<{ id: string; path: string }> = await app.window.evaluate(() => window.clubhouse.project.list());
        const projectId = projects.find((project) => project.path === root)?.id;
        if (!projectId) throw new Error('The fixture project was not registered');
        return { app, fakes: cli, root, projectId, agentId, fingerprint: '' };
      };
      const a = await launch('A'), b = await launch('B');
      for (const desk of [b, a]) {
        await desk.app.window.evaluate(async () => {
          const experimental = await window.clubhouse.app.getExperimentalSettings();
          await window.clubhouse.app.saveExperimentalSettings({ ...experimental, annex: true });
          const settings = await window.clubhouse.annex.getSettings();
          await window.clubhouse.annex.saveSettings({ ...settings, enableServer: true, enableClient: false });
        });
        await expect.poll(async () => (await desk.app.window.evaluate(() => window.clubhouse.annex.getStatus())).port, { timeout: 15_000 }).toBeGreaterThan(0);
      }
      for (const desk of [a, b]) desk.fingerprint = (await desk.app.window.evaluate(() => window.clubhouse.annex.getStatus())).fingerprint.toLowerCase();
      const target = await b.app.window.evaluate(() => window.clubhouse.annex.getStatus());
      for (const desk of [a, b]) {
        const status = await desk.app.window.evaluate(() => window.clubhouse.annex.getStatus());
        if (!status.port || !('pairingPort' in status) || typeof status.pairingPort !== 'number' || status.pairingPort <= 0) throw new Error('Both real Annex listeners must be audited');
        listeners.push([status.port, status.pairingPort]);
      }
      forward.setTarget(target.port!);
      expect(guard.accepts()).toBe(0);
      for (const desk of [a, b]) await desk.app.window.evaluate(async () => {
        const settings = await window.clubhouse.annex.getSettings();
        await window.clubhouse.annex.saveSettings({ ...settings, enableClient: true });
      });
      const paired = await a.app.window.evaluate(({ address, pin, certificate }) => window.clubhouse.annexClient.pairWithEndpoint(address, pin, certificate), {
        address: `127.0.0.1:${forward.port}`, pin: target.pin, certificate: target.tlsCertificateFingerprint!,
      });
      expect(paired).toMatchObject({ success: true });
      const directions = [[a, b], [b, a]] as const;
      for (const [caller, receiver] of directions) {
        await expect.poll(async () => {
          const satellites: Array<{ fingerprint: string; state: string }> = await caller.app.window.evaluate(() => window.clubhouse.annexClient.getSatellites());
          return satellites.find((satellite) => satellite.fingerprint.toLowerCase() === receiver.fingerprint)?.state;
        }, { timeout: 45_000 }).toBe('connected');
        await caller.app.window.evaluate(({ id, address }) => window.clubhouse.mcpBinding.connectAcrossMachines(id, address, { twoWay: false }), {
          id: caller.agentId, address: `${receiver.agentId}@${receiver.fingerprint}`,
        });
      }
      await use({ a, b, directions: [...directions], forward });
    } catch (error) {
      errors.push(error);
    } finally {
      if (forward && guard && apps.length === 2) {
        try {
          const audits = [];
          for (const app of apps) {
            await app.window.evaluate(async () => {
              const settings = await window.clubhouse.annex.getSettings();
              await window.clubhouse.annex.saveSettings({ ...settings, enableServer: false, enableClient: false });
            });
            audits.push(await app.electronApp.evaluate(() => {
            const guard = (globalThis as GuardGlobal).__reverseP8;
            if (!guard) throw new Error('Reverse dial guard disappeared');
            return guard.read();
            }));
          }
          await info.attach('reverse-dial-audit', { body: JSON.stringify({ audits, listeners, sentinelAccepts: guard.accepts(), forwardSourcePorts: forward.sourcePorts, forwardTargetSourcePorts: forward.targetSourcePorts }), contentType: 'application/json' });
          for (const audit of audits) expect(audit.installed).toBe(true);
          assertDialAudit(audits[0].attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, guard.accepts());
          assertDialAudit(audits[1].attempts, null, [], guard.accepts());
          expect(listeners, 'Annex listener inventory is incomplete').toHaveLength(2);
          assertListenerAudit(audits[0].accepts, listeners[0]);
          assertListenerAudit(audits[1].accepts, listeners[1], { targetPort: listeners[1][0], sourcePorts: forward.targetSourcePorts });
          expect(audits[0].attempts.some((attempt) => attempt.outcome === 'connected')).toBe(true);
        } catch (error) { errors.push(error); }
      }
      for (const app of [...apps].reverse()) {
        try { await app.electronApp.close(); untrackOpenApp(app.electronApp); }
        catch (error) { errors.push(error); }
      }
      if (apps.every((app) => app.electronApp.process().exitCode !== null || app.electronApp.process().signalCode !== null)) {
        for (const app of apps) app.profile.dispose();
        await forward?.close();
        await guard?.close();
        for (const cli of fakes) await cli.cleanup();
        await fs.promises.rm(scratch, { recursive: true, force: true });
      } else {
        errors.push(new Error('Retaining fixture resources because an owned desktop has not exited'));
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Reverse desktop fixture failed');
  },
});

export { expect };
