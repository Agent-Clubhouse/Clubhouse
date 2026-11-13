import { afterAll, afterEach, beforeAll, beforeEach as rawBeforeEach, describe, expect, it as rawIt, vi } from 'vitest';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { app, ipcMain } from 'electron';
import type { ImportPlan, ImportStatus } from '../../../../shared/project-import';
import type { DurableAgentConfig } from '../../../../shared/types';
import { CheckpointFixtureLifetime } from '../../../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration } from '../../../../../test/dispatcher-work-owner';

const lifetime = vi.hoisted(() => ({
  current: undefined as CheckpointFixtureLifetime | undefined,
  closing: false,
  controllers: new Set<AbortController>(),
  releases: [] as Array<() => void>,
}));

const fixture = vi.hoisted(() => {
  const f = require('fs') as typeof import('fs');
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const root = f.realpathSync.native(f.mkdtempSync(p.join(o.tmpdir(), 'public-project-import-')));
  const userData = p.join(root, 'user-data');
  f.mkdirSync(userData);
  return {
    root, base: p.join(root, 'app'), userData,
    dispatcher: p.join(root, 'dispatcher'), source: p.join(root, 'source'),
  };
});
const current = vi.hoisted(() => ({
  service: undefined as import('../../project-import/service').ProjectImportService | undefined,
  remoteFailure: undefined as Error | undefined,
  afterRemote: undefined as (() => void | Promise<void>) | undefined,
  afterRename: undefined as ((from: string, to: string) => void | Promise<void>) | undefined,
  afterWrite: undefined as ((file: string) => void | Promise<void>) | undefined,
  blockedFetch: false,
  partialRegistration: false,
  commit: '',
  releaseCommit: '',
  remoteCalls: [] as string[],
  gitCalls: [] as string[][],
}));

vi.mock('electron', async (original) => {
  const real = await original<typeof import('electron')>();
  return { ...real, app: { ...real.app, getPath: () => fixture.userData } };
});

vi.mock('child_process', async (original) => {
  const child = await original<typeof import('child_process')>();
  const { ownCheckpointExecFile } = await import('../../../../../test/checkpoint-fixture-lifetime');
  return {
    ...child,
    execFile: ownCheckpointExecFile(child.execFile, () => lifetime.current),
    spawn: ownCheckpointExecFile(child.spawn, () => lifetime.current),
  };
});

vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>();
  return {
    ...real,
    rename: async (...params: Parameters<typeof real.rename>) => {
      await real.rename(...params);
      await current.afterRename?.(String(params[0]), String(params[1]));
    },
    writeFile: async (...params: Parameters<typeof real.writeFile>) => {
      await real.writeFile(...params);
      await current.afterWrite?.(String(params[0]));
    },
  };
});

vi.mock('../../base-dir', () => ({ getBaseDirPath: () => fixture.base }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../badge-settings', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../../sound-service', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../../agent-system', async (original) => ({
  ...await original<typeof import('../../agent-system')>(),
  resolveOrchestrator: vi.fn(async (_project: string, cli?: string) => ({
    id: cli ?? 'copilot-cli', displayName: 'Fixture CLI',
    checkAvailability: async () => ({ available: true }),
  })),
}));
vi.mock('../../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../../dispatcher/dispatcher-settings')>(), isDispatcherEnabled: () => true,
}));
vi.mock('../../dispatcher/dispatcher-service', async (original) => ({
  ...await original<typeof import('../../dispatcher/dispatcher-service')>(),
  isDispatcherAgentId: (id: string) => id === 'dispatcher',
  resolveDispatcherIdentity: (projectPath: string, agentId: string) => ({ projectPath, agentId }),
  getDispatcherAgentId: () => 'dispatcher',
  dispatcherDisplayName: () => 'Dispatcher',
}));
vi.mock('./helper-delivery', () => ({ deliverHelperUpdate: vi.fn(async () => 'delivered') }));
vi.mock('./agent-lifecycle', async (original) => ({
  ...await original<typeof import('./agent-lifecycle')>(),
  wakeWiredAgent: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'running' }) }] })),
}));
vi.mock('../../project-import/service', async (original) => {
  const real = await original<typeof import('../../project-import/service')>();
  return { ...real, get projectImportService() { return current.service; } };
});

import { ProjectImportService } from '../../project-import/service';
import { ImportStore } from '../../project-import/store';
import { ACTIVE_PHASES, ImportError } from '../../project-import/types';
import { createImportGit, importGitEnvironment, parseRemoteIdentity, type ImportGit } from '../../project-import/git';
import { registerProjectFolder } from '../../project-add';
import * as projectStore from '../../project-store';
import * as agentConfig from '../../agent-config';
import * as gitService from '../../git-service';
import * as grantsStore from '../../agent-grants-store';
import * as agentSettings from '../../agent-settings-service';
import * as policyService from '../../orchestration-policy';
import { getConnectionDirection } from '../../connection-grants-store';
import { appLog } from '../../log-service';
import { registerClubhouseMcpTools } from './register-all';
import { buildToolName, callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { setDispatcherAgent } from '../dispatcher-gate';
import { setMcpCaller } from '../mcp-call-gate';
import { callKey, recordGrantRequest, listGrantRequests, _resetGrantRequestsForTesting } from '../../grant-requests';
import { setAgentGrant } from '../../agent-grants-service';
import { updateAgentGrantChanges } from '../../agent-grants-store';
import { answerGrantRequest } from '../../grant-request-answers';
import { runGrantCommand, toMobileGrantRequest } from '../../mobile-grant-requests';
import { registerAgentHandlers } from '../../../ipc/agent-handlers';
import { registerProjectImportHandlers } from '../../../ipc/project-import-handlers';
import { IPC } from '../../../../shared/ipc-channels';
import { withSettingsSurface } from '../../settings-audit';
import { managedAgents } from '../../managed-agents';
import { _resetDispatcherBootstrapForTesting } from '../dispatcher-bootstrap';
import { wakeWiredAgent } from './agent-lifecycle';
import { resolveOrchestrator } from '../../agent-system';
import { bindingManager } from '../binding-manager';
import { dispatcherWireBindingSource } from '../../dispatcher-wire-source';
import { getOrchestrationPolicy, setOrchestrationPolicy } from '../../orchestration-policy';
import { registerPersistedBindingSource, _resetPersistedBindingSourcesForTesting } from '../../persisted-bindings';

function owner(): CheckpointFixtureLifetime {
  if (!lifetime.current) throw new Error('Public import fixture has no owner');
  return lifetime.current;
}
const it = ownedRegistration(rawIt, 1, (promise) => { owner().observeRaw(promise); });
const beforeEach = ownedRegistration(rawBeforeEach, 0, (promise) => { owner().observeRaw(promise); });
const performDescriptor = Object.getOwnPropertyDescriptor(ProjectImportService.prototype, 'perform');
if (!performDescriptor || typeof performDescriptor.value !== 'function') throw new Error('Import job observation is unavailable');
Object.defineProperty(ProjectImportService.prototype, 'perform', {
  ...performDescriptor,
  value: new Proxy(performDescriptor.value, {
    apply(target, receiver, args: unknown[]) {
      const controller = args[1];
      if (!(controller instanceof AbortController)) throw new Error('Import job has no owned controller');
      lifetime.controllers.add(controller);
      if (lifetime.closing) controller.abort();
      const result: unknown = Reflect.apply(target, receiver, args);
      if (!(result instanceof Promise)) throw new Error('Import job has no completion promise');
      return owner().observeDirect(result);
    },
  }),
});

const sourceEnvironment = () => ({
  PATH: process.env.PATH, HOME: fixture.root, USERPROFILE: fixture.root, XDG_CONFIG_HOME: path.join(fixture.root, 'xdg'),
});
const empty = path.join(fixture.root, 'empty.config');
fs.writeFileSync(empty, '', { flag: 'wx', mode: 0o600 });
const candidate = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
  .map((dir) => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'))
  .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
if (!candidate) throw new Error('The isolated fixture requires installed Git');
const binary = fs.realpathSync.native(candidate);
const git = (...args: string[]) => execFileSync(binary, ['-c', 'protocol.file.allow=always', ...args], {
  cwd: fixture.source, env: importGitEnvironment(sourceEnvironment(), empty), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const event = {} as Electron.IpcMainInvokeEvent;
let serial = 0;
let store: ImportStore;
let runner: ImportGit;
let destination: string;
let url: string;
let terminal: Promise<void>;
let finish!: () => void;
let fetchEntered: Promise<void>;
let entered!: () => void;

async function call(name: string, args: Record<string, unknown>, actor = 'dispatcher') {
  const result = await callTool(actor, name, args);
  const text = result.content[0]?.text ?? '';
  return { result, body: text.startsWith('{') ? JSON.parse(text) : undefined, text };
}

async function preview(branch?: string): Promise<ImportPlan> {
  const result = await call('preview_repository_import', { url, destination, ...(branch && { branch }) });
  expect(result.result.isError, result.text).not.toBe(true);
  expect(result.body.status).toBe('ready');
  return result.body.plan;
}

const startArgs = (plan: ImportPlan) => ({ planId: plan.id, destination: plan.destination });
const start = (plan: ImportPlan) => call('import_repository', startArgs(plan));

async function approveDesktop(tool = 'import_repository') {
  const request = listGrantRequests().find((r) => r.toolName === tool);
  if (!request) throw new Error(`No genuine human review for ${tool}`);
  expect(await withSettingsSurface('ui', undefined, () => handlers.get(IPC.AGENT.ANSWER_GRANT_REQUEST)!(event, request.requestId, true))).toEqual({ ok: true });
  return request;
}

async function completeImport() {
  const plan = await preview();
  expect((await start(plan)).body.status).toBe('approval_required');
  await approveDesktop();
  const started = await start(plan);
  expect(started.body.status).toBe('started');
  await terminal;
  const status = await call('get_repository_import', { importId: started.body.receipt.id });
  expect(status.body.phase).toBe('completed');
  return { plan, receipt: status.body as ImportStatus };
}

beforeAll(async () => {
  fs.mkdirSync(fixture.source);
  git('init', '-q', '--initial-branch=trunk', '--template=');
  fs.writeFileSync(path.join(fixture.source, 'readme.txt'), 'fixture content\n');
  git('add', '.');
  git('-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'seed');
  git('branch', 'release');
  current.commit = git('rev-parse', 'HEAD');
  git('switch', '-q', 'release');
  fs.writeFileSync(path.join(fixture.source, 'selected-branch.txt'), 'Only on the selected release branch\n');
  git('add', '.');
  git('-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'distinct selected branch tip');
  current.releaseCommit = git('rev-parse', 'HEAD');
  git('switch', '-q', 'trunk');
  fs.mkdirSync(path.join(fixture.dispatcher, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(fixture.dispatcher, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: 'dispatcher', name: 'Dispatcher', color: 'indigo', createdAt: new Date().toISOString(), orchestrator: 'copilot-cli' },
  ]));
  await managedAgents().ensureBuiltins();
});

rawBeforeEach(() => {
  lifetime.current?.assertRetired();
  lifetime.current = new CheckpointFixtureLifetime();
  lifetime.closing = false;
  lifetime.controllers.clear();
  lifetime.releases = [];
});

beforeEach(async () => {
  current.remoteFailure = undefined;
  current.afterRemote = undefined;
  current.afterRename = undefined;
  current.afterWrite = undefined;
  current.blockedFetch = false;
  current.partialRegistration = false;
  current.remoteCalls = [];
  current.gitCalls = [];
  destination = path.join(fixture.root, `checkout-${++serial}`);
  url = `https://github.com/fixture/repository-${serial}.git`;
  store = new ImportStore(path.join(fixture.base, `import-${serial}.json`));
  terminal = new Promise((resolve) => { finish = resolve; });
  fetchEntered = new Promise((resolve) => { entered = resolve; });
  const write = store.update.bind(store);
  vi.spyOn(store, 'update').mockImplementation(async (change) => {
    const state = await write(change);
    if (state.receipts.some((r) => !ACTIVE_PHASES.has(r.phase))) finish();
    return state;
  });
  const safeGit = createImportGit(sourceEnvironment);
  runner = {
    remote: async (remoteUrl, branch) => {
      current.remoteCalls.push(remoteUrl);
      if (current.remoteFailure) throw current.remoteFailure;
      const metadata = parseRemoteIdentity(remoteUrl, git('ls-remote', '--symref', fixture.source, 'HEAD', 'refs/heads/*'), branch);
      await current.afterRemote?.();
      return metadata;
    },
    run: async (args, options) => {
      current.gitCalls.push(args);
      if (args[0] === 'fetch' && current.blockedFetch) {
        entered();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new ImportError('cancelled', 'Fixture fetch cancelled'));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      // Only this deterministic fixture adapter admits its own local source. Production stays HTTPS-only.
      const local = args[0] === 'fetch' ? ['-c', 'protocol.file.allow=always', ...args.map((arg) => arg === 'origin' ? fixture.source : arg)] : args;
      return safeGit.run(local, options);
    },
  };
  current.service = new ProjectImportService({
    store, git: runner,
    register: (folder, guard) => registerProjectFolder(folder, current.partialRegistration ? {
      ...guard!,
      beforeGitignore: async () => { throw new ImportError('unsafe_gitignore', 'Fixture registration guard refused'); },
    } : guard),
  });
  _resetForTesting();
  _resetGrantRequestsForTesting();
  _resetDispatcherBootstrapForTesting();
  handlers.clear();
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => { handlers.set(channel, handler); });
  registerAgentHandlers();
  registerProjectImportHandlers();
  registerClubhouseMcpTools();
  _resetPersistedBindingSourcesForTesting();
  bindingManager._resetForTesting();
  registerPersistedBindingSource(dispatcherWireBindingSource);
  agentRegistry.register('dispatcher', { projectPath: fixture.dispatcher, orchestrator: 'copilot-cli', runtime: 'headless', nonce: `session-${serial}`, launchAccess: { access: 'full_access', freeAgentMode: true } });
  setMcpCaller('dispatcher', fixture.dispatcher, {});
  setDispatcherAgent('dispatcher', true);
  await updateAgentGrantChanges('dispatcher', () => undefined);
  vi.mocked(appLog).mockClear();
  vi.mocked(wakeWiredAgent).mockClear();
});

afterEach(async () => {
  lifetime.closing = true;
  for (const controller of lifetime.controllers) controller.abort();
  for (const release of lifetime.releases) release();
  await owner().close(() => agentConfig.settleAgentsFileChecksForTests(), () => {
    agentConfig.clearAgentConfigCache();
  });
  owner().assertRetired();
});

afterAll(() => {
  lifetime.current?.assertRetired();
  Object.defineProperty(ProjectImportService.prototype, 'perform', performDescriptor);
  agentRegistry.untrack('dispatcher');
  agentRegistry.untrack('other');
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('public Dispatcher repository import (#2808)', () => {
  let imported: Awaited<ReturnType<typeof completeImport>>;
  const prepareImportedProject = async () => { imported = await completeImport(); };

  it('registers the complete public composition: preview -> exact Needs you -> real UI answer -> start -> progress -> real project, once', async () => {
    const catalog = await getScopedToolList('dispatcher');
    expect(catalog.map((t) => t.name)).toEqual(expect.arrayContaining(['preview_repository_import', 'import_repository', 'get_repository_import', 'cancel_repository_import', 'create_managed_agent']));
    const plan = await preview('release');
    expect(plan).toMatchObject({ url, destination, defaultBranch: 'trunk', branch: 'release', commit: current.releaseCommit, headCommit: current.commit });
    expect(fs.existsSync(destination)).toBe(false);
    expect((await start(plan)).body.status).toBe('approval_required');
    const review = listGrantRequests()[0];
    expect(review.kind).toBe('call');
    expect(review.importReview).toEqual(plan);
    expect(JSON.parse(review.argumentsText!)).toEqual({ ...startArgs(plan), plan });
    expect(review.details).toContain('No agent');
    expect(fs.existsSync(destination)).toBe(false);
    await approveDesktop();
    const started = await start(plan);
    expect(started.body.status).toBe('started');
    const progress = await call('get_repository_import', { importId: started.body.receipt.id });
    expect(progress.body.plan).toEqual(plan);
    expect(progress.body.phase).toMatch(/reserved|initializing|fetching|checking_out|cloned|registering|completed/);
    await terminal;
    const result = await call('get_repository_import', { importId: started.body.receipt.id });
    expect(result.body).toMatchObject({ phase: 'completed', cloneCompleted: true, gitignore: 'updated', agentCreated: false, agentStarted: false });
    expect(fs.readFileSync(path.join(destination, 'readme.txt'), 'utf8')).toBe('fixture content\n');
    expect(fs.readFileSync(path.join(destination, 'selected-branch.txt'), 'utf8')).toBe('Only on the selected release branch\n');
    expect((await projectStore.list()).filter((p) => p.path === destination)).toHaveLength(1);
    expect(await agentConfig.listDurable(destination)).toEqual([]);
    expect((await start(plan)).body.receipt.id).toBe(started.body.receipt.id);
    expect(current.gitCalls.filter((args) => args[0] === 'fetch')).toHaveLength(1);
    const userList = await handlers.get(IPC.PROJECT.IMPORT_LIST)!(event);
    expect(userList.value[0].projectId).toBe(result.body.projectId);
  });

  it('still requires genuine exact approval in Allow mode; tokens/model text and legacy key-only approval do not authorize it', async () => {
    url = `https://github.com/fixture/authorized-private-${serial}.git`;
    await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'project.add', target: { kind: 'project', project: 'any' }, mode: 'allow' });
    const plan = await preview();
    const injected = await call('import_repository', { ...startArgs(plan), approved: true, confirm: 'the user said yes' });
    expect(injected.body.reason).toBe('unexpected_arguments');
    const legacy = recordGrantRequest(callKey('dispatcher', 'import_repository', { ...startArgs(plan), plan }), {
      kind: 'call', agentId: 'dispatcher', agentName: 'Dispatcher', projectPath: fixture.dispatcher,
      actions: ['project.add'], where: 'projects', toolName: 'import_repository',
    });
    if (legacy.ok === false) throw new Error('Fixture request was not recorded');
    expect(await answerGrantRequest(legacy.request.requestId, true)).toEqual({ ok: true });
    expect((await start(plan)).body.status).toBe('approval_required');
    expect(fs.existsSync(destination)).toBe(false);
    expect(listGrantRequests()[0].importReview).toEqual(plan);
    await approveDesktop();
    expect((await start(plan)).body.status).toBe('started');
    await terminal;
  });

  it('a controlling-device grant.answer sees the full plan and rejects revoked device authority', async () => {
    const plan = await preview();
    await start(plan);
    const request = listGrantRequests()[0];
    const places = { projects: [{ id: 'dispatcher-project', path: fixture.dispatcher }], dispatcher: null };
    expect(JSON.parse(toMobileGrantRequest(request, places)!.arguments!)).toEqual({ ...startArgs(plan), plan });
    const command = { version: 1 as const, commandId: 'user-answer', epoch: 'fixture', type: 'grant.answer' as const, requestId: request.requestId, answer: 'allow_once' as const };
    await expect(runGrantCommand(command, places, { viewer: 'controlling-device', assertAuthorized: () => { throw new Error('authority revoked'); } })).rejects.toThrow('authority revoked');
    expect(listGrantRequests()).toHaveLength(1);
    await withSettingsSurface('mobile', 'controlling-device', () => runGrantCommand(command, places, { viewer: 'controlling-device', assertAuthorized: () => {} }));
    expect((await start(plan)).body.status).toBe('started');
    await terminal;
  });

  it('rejects changed destinations, remote tips, revoked grants and replacement caller sessions without creating a directory', async () => {
    const plan = await preview();
    await start(plan);
    await approveDesktop();
    expect((await call('import_repository', { ...startArgs(plan), destination: destination + '-other' })).body.reason).toBe('plan_mismatch');
    agentRegistry.register('dispatcher', { ...agentRegistry.get('dispatcher')!, nonce: 'different-caller-session' });
    expect((await start(plan)).body.status).toBe('approval_required');
    await approveDesktop();
    current.afterRemote = async () => {
      current.afterRemote = undefined;
      await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'project.add', target: { kind: 'project', project: 'any' }, mode: 'off' });
    };
    const revoked = await start(plan);
    expect(revoked.body.reason).toMatch(/not_permitted|authorization_changed/);
    expect(fs.existsSync(destination)).toBe(false);
    await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'project.add', target: { kind: 'project', project: 'any' }, mode: 'ask' });
    vi.spyOn(runner, 'remote').mockResolvedValue({ ...plan, commit: 'a'.repeat(40) });
    expect((await start(plan)).body.reason).toBe('remote_changed');
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('revalidates current main plan and parent identity after the real answer, before side effects', async () => {
    const plan = await preview();
    await start(plan);
    await approveDesktop();
    await store.update((state) => { state.plans[0].headCommit = 'b'.repeat(40); });
    expect((await start(plan)).body.reason).toBe('remote_changed');
    expect(fs.existsSync(destination)).toBe(false);

    const parent = path.join(fixture.root, `approved-parent-${serial}`);
    fs.mkdirSync(parent);
    destination = path.join(parent, 'new-checkout');
    const parentPlan = await preview();
    await start(parentPlan);
    await approveDesktop();
    fs.renameSync(parent, parent + '-preserved');
    fs.mkdirSync(parent);
    expect((await start(parentPlan)).body.reason).toBe('placement_changed');
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('sanitizes public/private/auth failures and exposes explicit empty/default/selected-branch outcomes through the public tool', async () => {
    expect((await preview()).url).toBe(url);
    current.remoteFailure = new ImportError('git_failed', 'Restore existing authorized GitHub sign-in outside agent messages. Never send credentials here.');
    const expired = await call('preview_repository_import', { url, destination: destination + '-private' });
    expect(expired.body.reason).toBe('git_failed');
    expect(expired.text).toContain('outside agent messages');
    current.remoteFailure = new Error('password=private-secret github.com/private-org/internal-project');
    const privateFailure = await call('preview_repository_import', { url, destination: destination + '-private' });
    expect(privateFailure.body.reason).toBe('operation_failed');
    expect(privateFailure.text).not.toMatch(/private-secret|private-org|internal-project/);
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toMatch(/private-secret|private-org|internal-project/);
    current.remoteFailure = undefined;
    expect((await call('preview_repository_import', { url, destination, branch: 'missing' })).body.reason).toBe('missing_branch');
    vi.spyOn(runner, 'remote').mockImplementation(async (remoteUrl) => parseRemoteIdentity(remoteUrl, '', undefined));
    expect((await call('preview_repository_import', { url, destination })).body.reason).toBe('empty_repository');
    vi.mocked(runner.remote).mockImplementation(async (remoteUrl) => parseRemoteIdentity(remoteUrl, `${current.commit}\tHEAD\n${current.commit}\trefs/heads/trunk`, undefined));
    expect((await call('preview_repository_import', { url, destination })).body.reason).toBe('missing_default_branch');
    expect(fs.existsSync(destination)).toBe(false);
    vi.mocked(runner.remote).mockRestore();
    const { receipt } = await completeImport();
    vi.mocked(resolveOrchestrator).mockRejectedValueOnce(new Error('password=private-secret at github.com/private-org/internal-project'));
    const agentFailure = await call('create_managed_agent', { project: destination, importId: receipt.id, name: 'owner', settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', access: 'ask' } });
    expect(agentFailure.body).toMatchObject({ status: 'refused', operation: 'agent_choices', reason: 'operation_failed' });
    expect(agentFailure.text).not.toMatch(/private-secret|private-org|internal-project/);
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toMatch(/private-secret|private-org|internal-project/);
    expect(await agentConfig.listDurable(destination)).toEqual([]);
  });

  it('refuses unsafe URLs/placement and offers actual duplicate project reuse rather than another checkout', async () => {
    for (const input of ['https://user:secret@github.com/owner/repo', 'git@github.com:owner/repo', 'https://github.com/owner/../repo', 'https://example.com/owner/repo']) {
      const result = await call('preview_repository_import', { url: input, destination });
      expect(result.body.reason).toBe('unsupported_url');
      expect(result.text).not.toContain('secret@');
    }
    expect((await call('preview_repository_import', { url, destination: 'relative' })).body.reason).toBe('invalid_destination');
    fs.mkdirSync(destination);
    expect((await call('preview_repository_import', { url, destination })).body.reason).toBe('destination_exists');
    destination += '-new';
    const { receipt } = await completeImport();
    const duplicate = await call('preview_repository_import', { url, destination: destination + '-duplicate' });
    expect(duplicate.body).toMatchObject({ status: 'existing_project', projectId: receipt.projectId });
    expect(fs.existsSync(destination + '-duplicate')).toBe(false);
    expect(duplicate.text).toContain('Open/reuse');
  });

  it('cancels the exact owned running receipt, preserves user content, and reports final cancellation without restarting', async () => {
    current.blockedFetch = true;
    const plan = await preview();
    await start(plan);
    await approveDesktop();
    const started = await start(plan);
    await fetchEntered;
    const id = started.body.receipt.id;
    agentRegistry.register('other', { projectPath: fixture.dispatcher, orchestrator: 'copilot-cli', runtime: 'headless' });
    setMcpCaller('other', fixture.dispatcher, {});
    setDispatcherAgent('other', true);
    expect((await call('get_repository_import', { importId: id }, 'other')).body.reason).toBe('import_not_found');
    expect((await call('cancel_repository_import', { importId: id, destination: destination + '-wrong' })).body.reason).toBe('plan_mismatch');
    const file = path.join(destination, 'human-notes.txt');
    fs.writeFileSync(file, 'preserve this user modification');
    expect((await call('get_repository_import', { importId: id })).body.phase).toBe('fetching');
    const cancelled = await handlers.get(IPC.PROJECT.IMPORT_CANCEL)!(event, id, destination);
    expect(cancelled.value.status).toBe('cancellation_requested');
    await terminal;
    expect((await call('get_repository_import', { importId: id })).body).toMatchObject({ phase: 'cancelled', failedAt: 'fetching', reason: 'cancelled' });
    expect(fs.readFileSync(file, 'utf8')).toBe('preserve this user modification');
    expect((await start(plan)).body.receipt.id).toBe(id);
    expect((await call('cancel_repository_import', { importId: id, destination })).body.status).toBe('not_running');
  });

  it('keeps the real project id after guarded registration failure and never replays an interrupted receipt', async () => {
    current.partialRegistration = true;
    const plan = await preview();
    await start(plan);
    await approveDesktop();
    const started = await start(plan);
    await terminal;
    const id = started.body.receipt.id;
    const partial = await call('get_repository_import', { importId: id });
    expect(partial.body).toMatchObject({ phase: 'partial', cloneCompleted: true, gitignore: 'failed', reason: 'gitignore_failed' });
    expect((await projectStore.list()).some((p) => p.id === partial.body.projectId)).toBe(true);
    expect(partial.body.recovery).toContain('do not clone again');
    await store.update((state) => { state.receipts[0].phase = 'registering'; });
    current.service = new ProjectImportService({ store, git: runner });
    _resetGrantRequestsForTesting();
    const interrupted = await call('get_repository_import', { importId: id });
    expect(interrupted.body).toMatchObject({ phase: 'partial', projectId: partial.body.projectId, reason: 'registration_receipt_interrupted' });
    expect((await start(plan)).body.status).toBe('existing_import');
    expect(current.gitCalls.filter((args) => args[0] === 'fetch')).toHaveLength(1);
  });

  it('keeps a terminal-notified public import owned until its full detached job settles', async () => {
    const plan = await preview();
    await start(plan);
    await approveDesktop();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    lifetime.releases.push(release);
    vi.mocked(store.update).mockImplementation(async (change) => {
      const state = await ImportStore.prototype.update.call(store, change);
      if (state.receipts.some((receipt) => !ACTIVE_PHASES.has(receipt.phase))) {
        finish();
        await released;
      }
      return state;
    });
    const started = await start(plan);
    await terminal;
    expect((await call('get_repository_import', { importId: started.body.receipt.id })).body.phase).toBe('completed');
    expect(owner().evidence().teardown.directPending).toBe(1);
  });

  describe('agent choices with a prepared real public import', () => {
    beforeEach(prepareImportedProject);

    it('composes real template choices and create-only builder with persistent retry/restart idempotence, not just unconnected builder tests', async () => {
      const { receipt } = imported;
      const template = await managedAgents().saveTemplate({
        name: `Public import template ${serial}`, description: 'Fixture choices',
        setup: { blocks: [], skills: [], mcps: [] },
        settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'high', access: 'ask', orchestration: { orchestrate: true, crossProjectHelpers: false } },
      });
      const args = { project: destination, importId: receipt.id, name: 'import-owner', templateId: template.id, connectToDispatcher: false };
      const asked = await call('create_managed_agent', args);
      expect(asked.body.status, asked.text).toBe('needs_approval');
      const request = listGrantRequests()[0];
      expect(request.agentReview).toMatchObject({
        importId: receipt.id, projectId: receipt.projectId, templateName: template.name, connectToDispatcher: false,
        settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'high', access: 'ask', freeAgentMode: false, orchestration: { orchestrate: true, connectToDispatcher: false } },
      });
      expect(await agentConfig.listDurable(destination)).toEqual([]);
      await approveDesktop('create_managed_agent');
      await managedAgents().saveTemplate({ ...template, description: 'The main template changed after human review.' });
      expect((await call('create_managed_agent', args)).body.status).toBe('needs_approval');
      expect(await agentConfig.listDurable(destination)).toEqual([]);
      expect(JSON.parse(listGrantRequests()[0].argumentsText!).template.description).toBe('The main template changed after human review.');
      await approveDesktop('create_managed_agent');
      const ambientProbe = vi.spyOn(gitService, 'isInsideGitRepo').mockResolvedValue(false);
      const created = await call('create_managed_agent', args);
      expect(ambientProbe).not.toHaveBeenCalled();
      ambientProbe.mockRestore();
      expect(created.body, created.text).toMatchObject({ status: 'sleeping', importId: receipt.id, projectId: receipt.projectId, agentCreated: true, agentStarted: false, connectedToDispatcher: false });
      expect((await agentConfig.listDurable(destination)).map((a) => a.id)).toEqual([created.body.id]);
      expect(current.gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(true);
      expect(current.gitCalls.some((args) => args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree')).toBe(true);
      expect((await call('create_managed_agent', args)).body).toMatchObject({ status: 'already_created', id: created.body.id });
      current.service = new ProjectImportService({ store, git: runner });
      _resetDispatcherBootstrapForTesting();
      _resetGrantRequestsForTesting();
      expect((await call('create_managed_agent', args)).body).toMatchObject({ status: 'already_created', id: created.body.id });
      expect(await agentConfig.listDurable(destination)).toHaveLength(1);
      const changed = await call('create_managed_agent', { ...args, name: 'different-owner' });
      expect(changed.body.reason).toBe('agent_choice_changed');
      const omitted = await call('create_managed_agent', { project: destination, name: 'different-owner' });
      expect(omitted.body.reason).toBe('import_receipt_required');
      expect(omitted.body.message).toContain(receipt.id);
      const outcome = await call('get_repository_import', { importId: receipt.id });
      expect(outcome.body.agentCreation).toMatchObject({ phase: 'completed', agentId: created.body.id });
      expect(outcome.body.agentStarted).toBe(false);
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it('creation/connection approval is not start permission: the actual registered wake needs its own grant and user answer', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'connected-owner', connectToDispatcher: true, settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', access: 'ask' } };
      expect((await call('create_managed_agent', args)).body.status).toBe('needs_approval');
      expect(listGrantRequests()[0].actions).toContain('connection.bootstrap');
      await approveDesktop('create_managed_agent');
      const created = await call('create_managed_agent', args);
      expect(created.body, created.text).toMatchObject({ status: 'sleeping', connectedToDispatcher: true, agentStarted: false });
      expect(wakeWiredAgent).not.toHaveBeenCalled();
      const binding = bindingManager.getBindingsForAgent('dispatcher').find((b) => b.targetId === created.body.id);
      if (!binding) throw new Error('Authorized bootstrap did not expose the actual wire');
      const wake = buildToolName(binding, 'wake_agent');
      await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'agent.wake', target: { kind: 'connected' }, mode: 'off' });
      await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'agent.wake', target: { kind: 'connected', wakeOn: true }, mode: 'off' });
      expect((await call(wake, { message: 'Explicitly requested fixture task' })).result.isError).toBe(true);
      expect(wakeWiredAgent).not.toHaveBeenCalled();
      await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'agent.wake', target: { kind: 'connected', wakeOn: true }, mode: 'ask' });
      const waiting = await call(wake, { message: 'Explicitly requested fixture task' });
      expect(waiting.text).toContain('Needs you');
      expect(wakeWiredAgent).not.toHaveBeenCalled();
      await approveDesktop(wake);
      expect((await call(wake, { message: 'Explicitly requested fixture task' })).body.status).toBe('running');
      expect(wakeWiredAgent).toHaveBeenCalledTimes(1);
      expect((await call(wake, { message: 'Explicitly requested fixture task' })).text).toContain('Needs you');
      expect(wakeWiredAgent).toHaveBeenCalledTimes(1);
      await withSettingsSurface('ui', undefined, () => setOrchestrationPolicy(destination, created.body.id, { connectToDispatcher: false }, { surface: 'ui' }));
      current.service = new ProjectImportService({ store, git: runner });
      _resetDispatcherBootstrapForTesting();
      _resetGrantRequestsForTesting();
      expect((await call('create_managed_agent', args)).body).toMatchObject({ status: 'already_created', id: created.body.id });
      expect((await getOrchestrationPolicy(destination, created.body.id)).connectToDispatcher).toBe(false);
      expect(wakeWiredAgent).toHaveBeenCalledTimes(1);
      expect(await agentConfig.listDurable(destination)).toHaveLength(1);
    });

    it('preserves partial agent worktree/user files on failure and refuses creation replay after restart', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'partial-owner', connectToDispatcher: false, settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', access: 'ask' } };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const run = runner.run.bind(runner);
      let preservedFile = '';
      vi.spyOn(runner, 'run').mockImplementation(async (gitArgs, options) => {
        if (gitArgs[0] === 'worktree' && gitArgs[1] === 'add') {
          preservedFile = path.join(gitArgs[3], 'human-notes.txt');
          fs.writeFileSync(preservedFile, 'do not delete');
          throw new ImportError('git_failed', 'Fixture worktree failure');
        }
        return run(gitArgs, options);
      });
      const result = await call('create_managed_agent', args);
      expect(result.body, result.text).toMatchObject({ reason: 'agent_creation_failed' });
      expect(fs.readFileSync(preservedFile, 'utf8')).toBe('do not delete');
      const agents = await agentConfig.listDurable(destination);
      expect(agents).toHaveLength(1);
      expect(agents[0].creation).toMatchObject({ state: 'failed', preserveOnInterruption: true });
      current.service = new ProjectImportService({ store, git: runner });
      expect((await call('create_managed_agent', args)).body.reason).toBe('agent_creation_interrupted');
      const agentsFile = path.join(destination, '.clubhouse', 'agents.json');
      const interrupted: DurableAgentConfig[] = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      if (!interrupted[0].creation) throw new Error('Expected the preserved creation record');
      interrupted[0].creation = { ...interrupted[0].creation, state: 'creating', owner: undefined, heartbeatAt: undefined };
      fs.writeFileSync(agentsFile, JSON.stringify(interrupted));
      agentConfig.clearAgentConfigCache();
      expect(await agentConfig.recoverInterruptedCreations(destination)).toEqual([agents[0].id]);
      expect((await agentConfig.listDurable(destination))[0].creation).toMatchObject({ state: 'failed', preserveOnInterruption: true });
      expect(fs.readFileSync(preservedFile, 'utf8')).toBe('do not delete');
      expect(await agentConfig.listDurable(destination)).toHaveLength(1);
      expect((await call('get_repository_import', { importId: receipt.id })).body).toMatchObject({
        phase: 'completed', projectId: receipt.projectId, agentCreation: { phase: 'failed' },
      });
    });
  });

  describe('terminal receipt recovery after prepared registration', () => {
    let plan: ImportPlan;
    let started: Awaited<ReturnType<typeof start>>;
    let resume!: () => void;
    let registered: boolean;
    beforeEach(async () => {
      registered = false;
      let arrived!: () => void;
      const entered = new Promise<void>((resolve) => { arrived = resolve; });
      const released = new Promise<void>((resolve) => { resume = resolve; });
      lifetime.releases.push(() => { resume(); arrived(); });
      current.service = new ProjectImportService({
        store, git: runner,
        register: async (...params) => {
          const result = await registerProjectFolder(...params);
          registered = true;
          arrived();
          await released;
          return result;
        },
      });
      plan = await preview();
      expect((await start(plan)).body.status).toBe('approval_required');
      await approveDesktop();
      started = await start(plan);
      expect(started.body.status).toBe('started');
      await entered;
    });

    it('retains honest terminal public/user status when the final ledger write fails, without replay or unhandled async failure', async () => {
      expect(registered).toBe(true);
      expect((await call('get_repository_import', { importId: started.body.receipt.id })).body.phase).toBe('registering');
      const failedHistory = new Promise<void>((resolve) => {
        vi.mocked(appLog).mockImplementation((_namespace, _level, message) => {
          if (message.includes('Import receipt could not be saved')) setImmediate(resolve);
        });
      });
      let completionSaveReached = false;
      vi.mocked(store.update).mockImplementation((change) => ImportStore.prototype.update.call(store, (state) => {
        change(state);
        const terminal = state.receipts.find((r) => !ACTIVE_PHASES.has(r.phase));
        if (terminal) {
          if (terminal.phase === 'completed' && terminal.projectId) completionSaveReached = true;
          throw new ImportError('history_unavailable', 'Fixture secret diagnostic must never escape');
        }
      }));
      resume();
      await failedHistory;
      expect(completionSaveReached).toBe(true);
      const status = await call('get_repository_import', { importId: started.body.receipt.id });
      expect(status.body).toMatchObject({ phase: 'partial', cloneCompleted: true, reason: 'history_unavailable' });
      expect(status.body.message).toContain('receipt could not be saved');
      expect(status.text).not.toContain('secret diagnostic');
      expect((await projectStore.list()).some((p) => p.id === status.body.projectId)).toBe(true);
      expect((await handlers.get(IPC.PROJECT.IMPORT_LIST)!(event)).value[0].phase).toBe('partial');
      expect((await start(plan)).body.receipt.id).toBe(started.body.receipt.id);
      expect(current.gitCalls.filter((args) => args[0] === 'fetch')).toHaveLength(1);
    });
  });

  describe('agent boundaries with a prepared real public import', () => {
    beforeEach(prepareImportedProject);

    it.each(['not-git', 'error'])('refuses %s from the protected creation probe without a folder/bootstrap fallback', async (outcome) => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'probe-owner', blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const ambientProbe = vi.spyOn(gitService, 'isInsideGitRepo').mockResolvedValue(false);
      const run = runner.run.bind(runner);
      vi.spyOn(runner, 'run').mockImplementation((gitArgs, options) => {
        if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--is-inside-work-tree') {
          if (outcome === 'error') throw new ImportError('git_failed', 'Fixture protected probe refused');
          return Promise.resolve('false\n');
        }
        return run(gitArgs, options);
      });
      const result = await call('create_managed_agent', args);
      expect(result.body).toMatchObject({ status: 'partial', agentStarted: false });
      expect(ambientProbe).not.toHaveBeenCalled();
      ambientProbe.mockRestore();
      expect(fs.existsSync(path.join(destination, '.clubhouse', 'agents', 'probe-owner'))).toBe(false);
      expect(current.gitCalls.some((command) => command[0] === 'worktree' || command[0] === 'commit')).toBe(false);
      expect((await agentConfig.listDurable(destination))[0].creation?.state).toBe('failed');
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation.phase).toBe('failed');
    });

    it('does not claim an outside folder after the actual branch-return parent substitution', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'parent-owner', blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const outside = path.join(fixture.root, `outside-${serial}`);
      fs.mkdirSync(outside);
      const run = runner.run.bind(runner);
      vi.spyOn(runner, 'run').mockImplementation(async (gitArgs, options) => {
        const result = await run(gitArgs, options);
        if (gitArgs[0] === 'branch') fs.symlinkSync(outside, path.join(destination, '.clubhouse', 'agents'), 'dir');
        return result;
      });
      const result = await call('create_managed_agent', args);
      expect(result.body).toMatchObject({ status: 'partial', agentStarted: false });
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(current.gitCalls.some((command) => command[0] === 'worktree')).toBe(false);
      expect((await agentConfig.listDurable(destination))).toHaveLength(1);
      expect((await agentConfig.listDurable(destination))[0].creation?.state).toBe('failed');
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation.phase).toBe('failed');
    });

    it('rechecks the exact template after real worktree creation and late saveSetup preparation', async () => {
      const { receipt } = imported;
      const service = managedAgents();
      const template = await service.saveTemplate({
        name: `Late template ${serial}`, description: 'Originally reviewed',
        setup: { blocks: [], skills: [], mcps: [] },
        settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', access: 'ask', effort: 'high' },
      });
      const args = { project: destination, importId: receipt.id, name: 'late-template-owner', templateId: template.id };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      let built = false;
      const run = runner.run.bind(runner);
      vi.spyOn(runner, 'run').mockImplementation(async (gitArgs, options) => {
        const result = await run(gitArgs, options);
        if (gitArgs[0] === 'worktree') built = true;
        return result;
      });
      const check = service.checkSetup.bind(service);
      const lateCheck = vi.spyOn(service, 'checkSetup').mockImplementation(async (...params) => {
        const result = await check(...params);
        if (built) {
          built = false;
          await service.saveTemplate({ ...template, description: 'Changed during final setup preparation' });
        }
        return result;
      });
      const result = await call('create_managed_agent', args);
      lateCheck.mockRestore();
      expect(result.body).toMatchObject({ status: 'partial', agentStarted: false });
      const agents = await agentConfig.listDurable(destination);
      expect(agents).toHaveLength(1);
      expect(fs.existsSync(agents[0].worktreePath!)).toBe(true);
      expect(agents[0].managed).toBeUndefined();
      expect(agents[0].effort).toBeUndefined();
      expect(agents[0].repositoryImportCreation?.state).toBe('failed');
      expect((await call('create_managed_agent', args)).body.reason).toBe('agent_creation_interrupted');
    });

    it('refuses template grants and completion when genuine permission revocation reaches the final grant-store preparation', async () => {
      const { receipt } = imported;
      await setAgentGrant(fixture.dispatcher, 'dispatcher', { action: 'agent.read', target: { kind: 'any' }, mode: 'allow' });
      const template = await managedAgents().saveTemplate({
        name: `Late grant ${serial}`, description: 'Bounded template grant',
        setup: { blocks: [], skills: [], mcps: [] },
        settings: { orchestrator: 'copilot-cli', access: 'ask', grants: [{ action: 'agent.read', target: { kind: 'any' }, mode: 'allow' }] },
      });
      const args = { project: destination, importId: receipt.id, name: 'late-grant-owner', templateId: template.id };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      let targetId: string | undefined;
      const service = managedAgents();
      const saveSetup = service.saveSetup.bind(service);
      const completedSetup = vi.spyOn(service, 'saveSetup').mockImplementation(async (...params) => {
        if (params[0] === destination) {
          await grantsStore.updateAgentGrantChanges(`unrelated-template-${serial}`, (saved) => saved);
          expect(revocation).toBeUndefined();
          expect(preparations).toBe(0);
        }
        const saved = await saveSetup(...params);
        if (params[0] === destination) {
          targetId = params[1];
          const committed: DurableAgentConfig[] = JSON.parse(fs.readFileSync(path.join(destination, '.clubhouse', 'agents.json'), 'utf8'));
          expect(committed.find((agent) => agent.id === targetId)?.managed).toBeDefined();
        }
        return saved;
      });
      const update = grantsStore.updateAgentGrantChanges;
      let revocation: Promise<{ error?: unknown }> | undefined;
      let enteredRevocation!: () => void;
      let preparations = 0;
      const revoked = new Promise<void>((resolve) => { enteredRevocation = resolve; });
      const lateGrants = vi.spyOn(grantsStore, 'updateAgentGrantChanges').mockImplementation((agentId, change, precondition) => {
        if (agentId === 'dispatcher') {
          enteredRevocation();
          return update(agentId, change, precondition);
        }
        if (agentId !== targetId) return update(agentId, change, precondition);
        if (!precondition) throw new Error('The imported template grant must carry its live approval');
        return update(agentId, change, {
          prepare: async () => {
            await precondition.prepare();
            if (++preparations !== 2) return;
            revocation = withSettingsSurface('ui', undefined, () => setAgentGrant(fixture.dispatcher, 'dispatcher', {
              action: 'agent.read', target: { kind: 'any' }, mode: 'off',
            })).then(() => ({}), (error: unknown) => ({ error }));
            await revoked;
          },
          check: () => precondition.check(),
        });
      });
      const result = await call('create_managed_agent', args);
      expect(revocation).toBeDefined();
      expect((await revocation)?.error).toBeUndefined();
      lateGrants.mockRestore();
      completedSetup.mockRestore();
      expect(result.body).toMatchObject({ status: 'partial', agentStarted: false });
      const agents = await agentConfig.listDurable(destination);
      expect(agents).toHaveLength(1);
      expect(agents[0].managed).toBeDefined();
      expect(agents[0].repositoryImportCreation?.state).toBe('failed');
      expect(grantsStore.getAgentGrantChanges(agents[0].id)?.template ?? []).toEqual([]);
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation.phase).toBe('failed');
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it.each(['corrupt', 'unavailable'])('keeps positively registered ordinary creation independent of %s import history, without importing-project bypass', async (failure) => {
      const ordinary = await projectStore.add(fixture.source);
      const history = fs.readFileSync(store.file);
      const retainedHistory = store.file + '.prepared';
      if (failure === 'corrupt') fs.writeFileSync(store.file, 'malformed private diagnostic');
      else {
        fs.renameSync(store.file, retainedHistory);
        fs.mkdirSync(store.file);
      }
      const read = vi.spyOn(store, 'get');
      const args = { project: ordinary.path, name: `ordinary-${serial}`, blocks: [], skills: [], mcps: [] };
      const created = await call('create_managed_agent', args);
      expect(created.body, created.text).toMatchObject({ status: 'sleeping', connectedToDispatcher: false });
      expect(read).not.toHaveBeenCalled();
      expect((await agentConfig.listDurable(ordinary.path)).some((agent) => agent.id === created.body.id)).toBe(true);
      read.mockRestore();
      if (failure === 'unavailable') {
        fs.rmdirSync(store.file);
        fs.renameSync(retainedHistory, store.file);
      } else fs.writeFileSync(store.file, history);
      const { receipt } = imported;
      fs.writeFileSync(store.file, 'malformed private diagnostic');
      const refused = await call('create_managed_agent', { project: destination, name: 'cannot-reclassify' });
      expect(refused.body.reason).toBe('history_corrupt');
      expect(refused.text).not.toContain('private diagnostic');
      expect(await agentConfig.listDurable(destination)).toEqual([]);
      expect(receipt.projectId).toBeDefined();
    });

    it('retains the actual created id and durable association after final agent-link save failure, then reconciles without creation or reconnection', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'receipt-owner', connectToDispatcher: true, blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const write = ImportStore.prototype.update.bind(store);
      vi.mocked(store.update).mockImplementation((change) => ImportStore.prototype.update.call(store, (state) => {
        change(state);
        if (state.receipts.some((r) => r.agentCreation?.phase === 'completed')) throw new ImportError('history_unavailable', 'Fixture private diagnostic');
      }));
      const result = await call('create_managed_agent', args);
      expect(result.body).toMatchObject({ status: 'partial', reason: 'agent_receipt_save_failed', agentCreated: true, agentStarted: false, connectedToDispatcher: false });
      expect(result.text).not.toContain('private diagnostic');
      const agents = await agentConfig.listDurable(destination);
      expect(agents).toHaveLength(1);
      expect(result.body.id).toBe(agents[0].id);
      expect(agents[0].creation).toBeUndefined();
      expect(agents[0].repositoryImportCreation).toMatchObject({ importId: receipt.id, state: 'completed' });
      expect(JSON.parse(fs.readFileSync(path.join(destination, '.clubhouse', 'agents.json'), 'utf8'))[0].repositoryImportCreation).toEqual(agents[0].repositoryImportCreation);
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation).toMatchObject({ phase: 'completed', agentId: agents[0].id, receiptSaved: false });
      expect((await call('create_managed_agent', args)).body).toMatchObject({ status: 'partial', id: agents[0].id, agentCreated: true });
      vi.mocked(store.update).mockImplementation(write);
      current.service = new ProjectImportService({ store, git: runner });
      agentConfig.clearAgentConfigCache();
      _resetDispatcherBootstrapForTesting();
      _resetGrantRequestsForTesting();
      const commands = current.gitCalls.length;
      expect((await call('create_managed_agent', args)).body).toMatchObject({ status: 'already_created', id: agents[0].id });
      expect(current.gitCalls).toHaveLength(commands);
      expect(await agentConfig.listDurable(destination)).toHaveLength(1);
      expect((await getOrchestrationPolicy(destination, agents[0].id)).connectToDispatcher).toBe(false);
      expect(bindingManager.getBindingsForAgent('dispatcher').some((binding) => binding.targetId === agents[0].id)).toBe(false);
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation).toMatchObject({ phase: 'completed', agentId: agents[0].id });
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation.receiptSaved).toBeUndefined();
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it('residual connection commits keep exact approval live through real directions, policy and final success', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'guarded-connection', connectToDispatcher: true, blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const result = await call('create_managed_agent', args);
      expect(result.body, result.text).toMatchObject({ status: 'sleeping', connectedToDispatcher: true, agentCreated: true, agentStarted: false });
      expect((await getOrchestrationPolicy(destination, result.body.id)).connectToDispatcher).toBe(true);
      expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: result.body.id })?.enabledTools).toContain('wake_agent');
      expect(bindingManager.getBindingsForAgent('dispatcher').some((binding) => binding.targetId === result.body.id)).toBe(true);
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it('keeps imported creation ready across a clean-cache invalidation during its final authority preparation', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'invalidated-ready', connectToDispatcher: true, blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const configFile = path.join(destination, '.clubhouse', 'agents.json');
      let prepared = false;
      let invalidated = false;
      const afterInvalidation: DurableAgentConfig[] = [];
      current.afterRename = (_from, to) => {
        if (to !== configFile) return;
        const agents: DurableAgentConfig[] = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (invalidated) { afterInvalidation.push(agents[0]); return; }
        if (agents[0]?.creation?.stage === 'config_injected') prepared = true;
      };
      const resolve = vi.mocked(resolveOrchestrator).getMockImplementation();
      if (!resolve) throw new Error('Expected the inert fixture CLI resolver');
      vi.mocked(resolveOrchestrator).mockImplementation(async (...params) => {
        const provider = await resolve(...params);
        if (prepared && !invalidated && params[0] === destination) {
          invalidated = true;
          agentConfig.clearAgentConfigCache(destination);
        }
        return provider;
      });
      const result = await call('create_managed_agent', args);
      current.afterRename = undefined;
      expect(invalidated).toBe(true);
      expect(afterInvalidation[0]?.creation).toBeUndefined();
      expect(result.body, result.text).toMatchObject({ status: 'sleeping', connectedToDispatcher: true, agentCreated: true, agentStarted: false });
      const agents = await agentConfig.listDurable(destination);
      expect(agents).toHaveLength(1);
      expect(agents[0].creation).toBeUndefined();
      expect(agents[0].repositoryImportCreation?.state).toBe('completed');
      expect((await getOrchestrationPolicy(destination, agents[0].id)).connectToDispatcher).toBe(true);
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it('residual direction commit rechecks revoked connection permission after its actual atomic staging await', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'late-direction', connectToDispatcher: true, blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const connectionFile = path.join(app.getPath('userData'), 'connection-grants.json');
      const before = fs.existsSync(connectionFile) ? fs.readFileSync(connectionFile, 'utf8') : undefined;
      const open = fs.promises.open.bind(fs.promises);
      let revoked = false;
      const stage = vi.spyOn(fs.promises, 'open').mockImplementation(async (...params) => {
        const handle = await open(...params);
        if (String(params[0]).startsWith(connectionFile + '.tmp-')) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementation(async () => {
            await sync();
            revoked = true;
            await withSettingsSurface('ui', undefined, () => setAgentGrant(fixture.dispatcher, 'dispatcher', {
              action: 'connection.bootstrap', target: { kind: 'created_by_me' }, mode: 'off',
            }));
          });
        }
        return handle;
      });
      const result = await call('create_managed_agent', args);
      stage.mockRestore();
      expect(revoked).toBe(true);
      expect(result.body, result.text).toMatchObject({ status: 'partial', agentCreated: true, agentStarted: false, reason: 'agent_connection_failed' });
      expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: result.body.id })).toBeUndefined();
      expect(getConnectionDirection({ agentId: result.body.id }, { agentId: 'dispatcher' })).toBeUndefined();
      expect(fs.existsSync(connectionFile) ? fs.readFileSync(connectionFile, 'utf8') : undefined).toBe(before);
      expect((await getOrchestrationPolicy(destination, result.body.id)).connectToDispatcher).toBe(false);
      expect(bindingManager.getBindingsForAgent('dispatcher').some((binding) => binding.targetId === result.body.id)).toBe(false);
      expect((await agentConfig.listDurable(destination))).toHaveLength(1);
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it('residual policy commit refuses a changed original caller after post-builder resolveFor preparation and preserves saved directions', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'late-policy', connectToDispatcher: true, blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const setPolicy = policyService.setOrchestrationPolicy;
      const readDefaults = agentSettings.readProjectAgentDefaults;
      let connecting = false;
      let reads = 0;
      let changed = false;
      const policy = vi.spyOn(policyService, 'setOrchestrationPolicy').mockImplementation(async (...params) => {
        connecting = !!params[2] && typeof params[2] === 'object' && 'connectToDispatcher' in params[2] && params[2].connectToDispatcher === true;
        try { return await setPolicy(...params); } finally { connecting = false; }
      });
      const preparation = vi.spyOn(agentSettings, 'readProjectAgentDefaults').mockImplementation(async (...params) => {
        const result = await readDefaults(...params);
        if (connecting && ++reads === 2) {
          const original = agentRegistry.get('dispatcher');
          if (!original) throw new Error('Expected the fixture caller');
          agentRegistry.register('dispatcher', { ...original, nonce: `changed-policy-${serial}` });
          changed = true;
        }
        return result;
      });
      const result = await call('create_managed_agent', args);
      preparation.mockRestore();
      policy.mockRestore();
      expect(changed).toBe(true);
      expect(result.body, result.text).toMatchObject({ status: 'partial', agentCreated: true, agentStarted: false, reason: 'agent_connection_failed' });
      expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: result.body.id })).toBeDefined();
      expect(getConnectionDirection({ agentId: result.body.id }, { agentId: 'dispatcher' })).toBeDefined();
      expect((await getOrchestrationPolicy(destination, result.body.id)).connectToDispatcher).toBe(false);
      expect(bindingManager.getBindingsForAgent('dispatcher').some((binding) => binding.targetId === result.body.id)).toBe(false);
      expect((await agentConfig.listDurable(destination))[0].repositoryImportCreation?.state).toBe('completed');
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it('residual final connection inspection cannot return success after the original caller changes', async () => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'late-inspection', connectToDispatcher: true, blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const readPolicy = policyService.getOrchestrationPolicy;
      let changed = false;
      const inspection = vi.spyOn(policyService, 'getOrchestrationPolicy').mockImplementation(async (...params) => {
        const result = await readPolicy(...params);
        if (!changed && params[0] === destination && result?.connectToDispatcher) {
          const original = agentRegistry.get('dispatcher');
          if (!original) throw new Error('Expected the fixture caller');
          agentRegistry.register('dispatcher', { ...original, nonce: `changed-inspection-${serial}` });
          changed = true;
        }
        return result;
      });
      const result = await call('create_managed_agent', args);
      inspection.mockRestore();
      expect(changed, result.text).toBe(true);
      expect(result.body, result.text).toMatchObject({ status: 'partial', agentCreated: true, agentStarted: false, reason: 'agent_connection_failed' });
      expect((await getOrchestrationPolicy(destination, result.body.id)).connectToDispatcher).toBe(true);
      expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: result.body.id })).toBeDefined();
      const savedDirections = JSON.parse(fs.readFileSync(path.join(fixture.userData, 'connection-grants.json'), 'utf8'));
      expect(savedDirections.directions).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: { agentId: 'dispatcher' }, to: { agentId: result.body.id } }),
        expect.objectContaining({ from: { agentId: result.body.id }, to: { agentId: 'dispatcher' } }),
      ]));
      expect((await agentConfig.listDurable(destination))).toHaveLength(1);
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });

    it.each(['backup-write', 'backup-rename'])('residual %s refuses a substituted .clubhouse after main commit without touching outside backup bytes', async (boundary) => {
      const { receipt } = imported;
      const args = { project: destination, importId: receipt.id, name: 'backup-owner', blocks: [], skills: [], mcps: [] };
      await call('create_managed_agent', args);
      await approveDesktop('create_managed_agent');
      const directory = path.join(destination, '.clubhouse');
      const mainFile = path.join(directory, 'agents.json');
      const backupFile = path.join(directory, 'agents.json.bak');
      const outside = path.join(fixture.root, `outside-backup-${serial}`);
      const retained = path.join(fixture.root, `retained-clubhouse-${serial}`);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'agents.json.bak'), 'preserve outside backup bytes');
      fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve unrelated bytes');
      let changed = false;
      let committedCacheRecord: DurableAgentConfig | null | undefined;
      const substitute = async () => {
        if (changed) return;
        const agents: DurableAgentConfig[] = JSON.parse(fs.readFileSync(mainFile, 'utf8'));
        if (!agents[0]?.branchOwned) return;
        committedCacheRecord = await agentConfig.getDurableConfig(destination, agents[0].id);
        fs.renameSync(directory, retained);
        fs.symlinkSync(outside, directory, 'dir');
        changed = true;
      };
      current.afterRename = async (_from, to) => {
        if (boundary === 'backup-write' && to === mainFile) await substitute();
      };
      current.afterWrite = async (file) => {
        if (boundary === 'backup-rename' && file.startsWith(backupFile + '.tmp.')) await substitute();
      };
      const result = await call('create_managed_agent', args);
      current.afterRename = undefined;
      current.afterWrite = undefined;
      expect(changed).toBe(true);
      expect(result.body, result.text).toMatchObject({ status: 'partial', agentStarted: false, reason: 'agent_creation_failed' });
      expect(fs.readFileSync(path.join(outside, 'agents.json.bak'), 'utf8')).toBe('preserve outside backup bytes');
      expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserve unrelated bytes');
      expect(fs.readdirSync(outside).sort()).toEqual(['agents.json.bak', 'sentinel.txt']);
      const committed: DurableAgentConfig[] = JSON.parse(fs.readFileSync(path.join(retained, 'agents.json'), 'utf8'));
      expect(committed).toHaveLength(1);
      expect(committed[0].branchOwned).toBe(true);
      expect(committed[0].repositoryImportCreation?.importId).toBe(receipt.id);
      expect(committedCacheRecord).toMatchObject({ id: committed[0].id, branchOwned: true });
      fs.unlinkSync(directory);
      fs.renameSync(retained, directory);
      await owner().settleEpoch(() => agentConfig.settleAgentsFileChecksForTests());
      owner().mutateEpoch(() => agentConfig.clearAgentConfigCache(destination));
      // Reproduce a stale empty image without reading through the substituted directory.
      const read = fsPromises.readFile;
      let servedStaleImage = false;
      const staleRead = vi.spyOn(fsPromises, 'readFile').mockImplementation((...params) => {
        if (String(params[0]) === mainFile) {
          servedStaleImage = true;
          return Promise.resolve('[]');
        }
        return read(...params);
      });
      expect(await agentConfig.listDurable(destination)).toEqual([]);
      expect(servedStaleImage).toBe(true);
      staleRead.mockRestore();
      await owner().settleEpoch(() => agentConfig.settleAgentsFileChecksForTests());
      owner().mutateEpoch(() => agentConfig.clearAgentConfigCache(destination));
      const restored = await agentConfig.listDurable(destination);
      expect(restored).toHaveLength(1);
      expect(restored[0].id).toBe(committed[0].id);
      expect(restored[0].branchOwned).toBe(true);
      expect((await call('get_repository_import', { importId: receipt.id })).body.agentCreation.phase).toBe('failed');
      expect(wakeWiredAgent).not.toHaveBeenCalled();
    });
  });
});
