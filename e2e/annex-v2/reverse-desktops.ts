import { test as base, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
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
import { assertAcceptAudit, assertDialAudit, captureOwnedReverseAudit, installMainGuard, readMainDialAudit, sentinel, transparentForward, type GuardGlobal, type OwnedAuditPeer } from '../../test/annex-v2/reverse-parity-fixture';

function auditError(error: unknown): unknown {
  if (error instanceof AggregateError) return { message: error.message, stack: error.stack, errors: error.errors.map(auditError) };
  return error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
}

/** Evaluated only in a test-owned Electron main process; no shipped switch or production seam. */
async function guardMain(app: LaunchedApp, sentinelPort: number, auditPath: string) {
  const calibration = await app.electronApp.evaluate(installMainGuard, { profile: app.userDataDir, sentinelPort, auditPath });
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
    const auditPaths = new Map<LaunchedApp, string>();
    const closures = new Map<LaunchedApp, Promise<void>>();
    const fakes: FakeClis[] = [];
    let guard: Awaited<ReturnType<typeof sentinel>> | undefined;
    let forward: Awaited<ReturnType<typeof transparentForward>> | undefined;
    const listenerPorts: number[] = [];
    const gitConfig = path.join(scratch, 'gitconfig');
    await fs.promises.writeFile(gitConfig, '');
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, args: string[]) => promisify(execFile)('git', args, { cwd, env: gitEnv });
    const errors: unknown[] = [];
    const closeApp = (app: LaunchedApp): Promise<void> => {
      let closing = closures.get(app);
      if (!closing) {
        closing = (async () => {
          const failures: unknown[] = [];
          try { await app.electronApp.close(); untrackOpenApp(app.electronApp); }
          catch (error) { failures.push(error); }
          // The cached launch handles, not Playwright's post-close process(), gate disposal.
          try { app.profile.dispose(); }
          catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, 'Reverse desktop did not close cleanly');
        })();
        closures.set(app, closing);
      }
      return closing;
    };
    try {
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
      guard = await sentinel();
      for (const [label, desk] of [['A', a], ['B', b]] as const) {
        const auditPath = path.join(scratch, `${label}-exit-audit.json`);
        auditPaths.set(desk.app, auditPath);
        await guardMain(desk.app, guard.port, auditPath);
      }
      for (const desk of [b, a]) {
        await desk.app.window.evaluate(async () => {
          const experimental = await window.clubhouse.app.getExperimentalSettings();
          await window.clubhouse.app.saveExperimentalSettings({ ...experimental, annex: true });
          const settings = await window.clubhouse.annex.getSettings();
          await window.clubhouse.annex.saveSettings({ ...settings, enableServer: true, enableClient: false });
        });
        await expect.poll(async () => (await desk.app.window.evaluate(() => window.clubhouse.annex.getStatus())).port, { timeout: 15_000 }).toBeGreaterThan(0);
      }
      for (const desk of [a, b]) {
        const status = await desk.app.window.evaluate(() => window.clubhouse.annex.getStatus());
        desk.fingerprint = status.fingerprint.toLowerCase();
        listenerPorts.push(status.port!);
      }
      const target = await b.app.window.evaluate(() => window.clubhouse.annex.getStatus());
      forward = await transparentForward(target.port!);
      await a.app.electronApp.evaluate((_electron, port) => {
        const guard = (globalThis as GuardGlobal).__reverseP8;
        if (!guard) throw new Error('Reverse dial guard disappeared');
        guard.setForward(port);
      }, forward.port);
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
          const peer = (app: LaunchedApp, index: number): OwnedAuditPeer => ({
            quiesce: (sourcePorts) => app.electronApp.evaluate((_electron, { port, sourcePorts }) => {
              const guard = (globalThis as GuardGlobal).__reverseP8;
              if (!guard) throw new Error('Reverse dial guard disappeared');
              return guard.seal(sourcePorts === undefined ? undefined : { port, sourcePorts });
            }, { port: listenerPorts[index], sourcePorts }),
            close: () => closeApp(app),
            readFinal: async () => {
              const auditPath = auditPaths.get(app);
              if (!auditPath) throw new Error('Missing reverse desktop audit path');
              await info.attach(`reverse-exit-audit-${index}`, { path: auditPath, contentType: 'application/json' });
              return readMainDialAudit(auditPath);
            },
          });
          const captured = await captureOwnedReverseAudit(forward, [peer(apps[0], 0), peer(apps[1], 1)]);
          if (captured.status === 'failed') errors.push(...captured.errors);
          const capturePath = info.outputPath('reverse-dial-audit.json');
          await fs.promises.writeFile(capturePath, JSON.stringify({
            audits: captured.audits, listenerPorts, sentinelAccepts: guard.accepts(),
            forwardSourcePorts: captured.forward.sourcePorts, forwardTargetSourcePorts: captured.forward.targetSourcePorts,
            capture: { ...captured, errors: captured.status === 'failed' ? captured.errors.map(auditError) : [] },
          }));
          await info.attach('reverse-dial-audit', { path: capturePath, contentType: 'application/json' });
          if (captured.status === 'complete') {
            const audits = captured.audits;
            for (const audit of audits) expect(audit).toMatchObject({ installed: true, sealed: true, phase: 'exit', pending: 0 });
            assertDialAudit(audits[0].attempts, { host: '127.0.0.1', port: forward.port }, captured.forward.sourcePorts, guard.accepts());
            assertDialAudit(audits[1].attempts, null, [], guard.accepts());
            assertAcceptAudit(audits[0].accepts, listenerPorts[0], []);
            assertAcceptAudit(audits[1].accepts, listenerPorts[1], captured.forward.targetSourcePorts);
            expect(audits[0].attempts.some((attempt) => attempt.outcome === 'connected')).toBe(true);
          }
        } catch (error) { errors.push(error); }
      }
      for (const app of [...apps].reverse()) if (!closures.has(app)) {
        try { await closeApp(app); }
        catch (error) { errors.push(error); }
      }
      try { await forward?.close(); }
      catch (error) { errors.push(error); }
      try { await guard?.close(); }
      catch (error) { errors.push(error); }
      if (apps.every((app) => app.profile.disposed)) {
        for (const cli of fakes) await cli.cleanup();
        await fs.promises.rm(scratch, { recursive: true, force: true });
      } else {
        errors.push(new Error('Retaining profiles, fake CLIs and capture files because an owned desktop has not exited'));
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Reverse desktop fixture failed');
  },
});

export { expect };
