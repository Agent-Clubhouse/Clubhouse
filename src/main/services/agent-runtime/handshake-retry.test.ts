import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators';
const state = vi.hoisted(() => ({ agents: [] as DurableAgentConfig[], projects: [] as { path: string }[], binary: '', prefix: '', env: { SAFE: 'synthetic' }, mode: { mode: 'chat' } as { mode: 'chat' | 'terminal'; driver?: 'codex_app_server' | 'copilot_sdk' | 'copilot_acp' }, active: undefined as unknown, registry: { generation: 0, pending: false }, defaults: { generation: 0, pending: false }, configGeneration: 0 }));
vi.mock('node:fs', async (actual) => {
  const real = await actual<typeof import('node:fs')>();
  return { ...real, lstatSync: vi.fn(real.lstatSync), openSync: vi.fn(real.openSync) };
});
vi.mock('../agent-config', () => ({ peekDurableConfigs: vi.fn(async () => state.agents), agentConfigGeneration: () => state.configGeneration }));
vi.mock('../project-store', () => ({ peekProjects: vi.fn(async () => state.projects), projectRegistryMutationState: () => ({ ...state.registry }) }));
vi.mock('../base-dir', () => ({ getBaseDirPath: () => state.projects[0]?.path || '/synthetic-unregistered' }));
vi.mock('../agent-settings-service', () => ({ projectSettingsMutationState: () => ({ ...state.defaults }) }));
vi.mock('../dispatcher/dispatcher-paths', () => ({ isDispatcherPath: () => false }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: () => state.active } }));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: vi.fn(async (_p: string, provider?: string) => ({ id: provider || 'codex-cli', getBinaryPath: () => state.binary }) as OrchestratorProvider),
  resolveCommandPrefix: vi.fn(async () => state.prefix),
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: () => state.mode }));
vi.mock('./chat-spawn', () => ({ chatLaunchEnvironment: vi.fn(() => state.env) }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
import { MAX_HANDSHAKE_INPUT_BYTES, retryAgentHandshake } from './handshake-retry';
import { FakeChatDriver } from './fake-chat-driver';
import { clearChatDrivers, registerChatDriver } from './chat-drivers';
import { clearDriverHealth, driverHealthKey, driverPausedReason, probeDriver, recordDriverFailure, DRIVER_FAILURE_THRESHOLD } from './chat-driver-health';
import { resolveCommandPrefix, resolveOrchestrator } from '../agent-system';
import { chatLaunchEnvironment } from './chat-spawn';
import { withAgentActivity } from '../agent-transition';
let dir: string, script: string, driver: FakeChatDriver;
const key = () => driverHealthKey(driver, state.binary, state.env, state.prefix);
function pause(k = key()) { for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure(k, 'failed', Date.now(), state.binary); }
beforeEach(() => {
  vi.clearAllMocks(); clearChatDrivers(); clearDriverHealth();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-2851-')); script = path.join(dir, 'init.sh');
  state.binary = path.join(dir, 'fake-cli'); fs.writeFileSync(state.binary, 'synthetic binary; never executed'); fs.writeFileSync(script, 'broken');
  state.registry = { generation: 0, pending: false }; state.defaults = { generation: 0, pending: false }; state.configGeneration = 0;
  state.prefix = `. "${script}"`; state.mode = { mode: 'chat' }; state.env = { SAFE: 'synthetic' }; state.active = undefined;
  state.projects = [{ path: dir }]; state.agents = [{ id: 'a', name: 'test', color: 'blue', createdAt: '', worktreePath: dir, orchestrator: 'codex-cli' }];
  driver = new FakeChatDriver('codex_app_server', 'codex-cli');
  driver.probe = vi.fn(async () => ({ handshakeOk: fs.readFileSync(script, 'utf8') === 'repaired', capabilities: driver.capabilities, cliVersion: '0.166.0', error: 'synthetic prefix failed' }));
  vi.spyOn(driver, 'start'); registerChatDriver(driver);
});
afterEach(() => { clearChatDrivers(); clearDriverHealth(); fs.rmSync(dir, { recursive: true, force: true }); });
describe('explicit scoped handshake retry', () => {
  it.each([
    ['copilot_sdk', 'copilot_acp'], ['copilot_acp', 'copilot_sdk'],
  ] as const)('does not probe %s selection through registered %s', async (selected, registered) => {
    clearChatDrivers();
    state.agents[0].orchestrator = 'copilot-cli';
    state.mode = { mode: 'chat', driver: selected };
    const other = new FakeChatDriver(registered, 'copilot-cli');
    const probe = vi.spyOn(other, 'probe');
    registerChatDriver(other);
    expect(await retryAgentHandshake(dir, 'a')).toMatchObject({ status: 'cannot_probe' });
    expect(probe).not.toHaveBeenCalled();
  });
  it('recovers a repaired same-path script with identical saved prefix/key and no session', async () => {
    const original = key(); pause('unrelated');
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) await probeDriver(driver, state.binary, state.env, state.prefix);
    expect(driverPausedReason(original)).toBeTruthy();
    fs.writeFileSync(script, 'repaired'); expect(key()).toBe(original);
    expect(await retryAgentHandshake(dir, 'a')).toMatchObject({ status: 'passed', driver: 'codex_app_server' });
    expect(driverPausedReason(original)).toBeUndefined(); expect(driver.probe).toHaveBeenCalledTimes(4); expect(driver.probe).toHaveBeenLastCalledWith(state.binary, state.env, { commandPrefix: state.prefix }); expect(driver.start).not.toHaveBeenCalled();
    expect(driverPausedReason('unrelated')).toBeTruthy();
    await probeDriver(driver, state.binary, state.env, state.prefix);
    expect(driver.probe).toHaveBeenCalledTimes(5); // explicit success was not cached as readiness
    expect(resolveCommandPrefix).toHaveBeenCalledWith(dir); expect(chatLaunchEnvironment).toHaveBeenCalledWith();
  });
  it('bypasses only its cached success and preserves failed retry backoff and unrelated keys', async () => {
    fs.writeFileSync(script, 'repaired'); await probeDriver(driver, state.binary, state.env, state.prefix); pause(); pause('unrelated');
    fs.writeFileSync(script, 'broken'); expect((await retryAgentHandshake(dir, 'a')).status).toBe('failed');
    expect(driver.probe).toHaveBeenCalledTimes(2); expect(driverPausedReason(key())).toBeTruthy(); expect(driverPausedReason('unrelated')).toBeTruthy();
  });
  it('deduplicates concurrent retries at the probe and counts one failure', async () => {
    let finish!: () => void; const wait = new Promise<void>((r) => { finish = r; });
    driver.probe = vi.fn(async () => { await wait; return { handshakeOk: false, capabilities: driver.capabilities }; });
    const checks = [retryAgentHandshake(dir, 'a'), retryAgentHandshake(dir, 'a')];
    await vi.waitFor(() => expect(driver.probe).toHaveBeenCalledTimes(1)); finish();
    expect((await Promise.all(checks)).map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(driverPausedReason(key())).toBeUndefined();
  });
  it.each(['provider', 'folder', 'driver', 'binary', 'prefix', 'env', 'lifecycle'])('discards a stale %s result without clearing its pause', async (change) => {
    pause(); const oldKey = key(); let finish!: () => void; const wait = new Promise<void>((r) => { finish = r; });
    driver.probe = vi.fn(async () => { await wait; return { handshakeOk: true, capabilities: driver.capabilities }; });
    const check = retryAgentHandshake(dir, 'a'); await vi.waitFor(() => expect(driver.probe).toHaveBeenCalledTimes(1));
    if (change === 'provider') { state.agents[0].orchestrator = 'claude-code'; state.configGeneration++; }
    if (change === 'folder') { state.agents[0].worktreePath = path.join(dir, 'other'); state.configGeneration++; }
    if (change === 'driver') registerChatDriver(new FakeChatDriver('codex_app_server', 'codex-cli'));
    if (change === 'binary') fs.writeFileSync(state.binary, 'replaced binary');
    if (change === 'prefix') state.prefix = 'changed';
    if (change === 'env') state.env = { SAFE: 'changed' };
    if (change === 'lifecycle') await withAgentActivity('a', async () => {});
    finish(); expect((await check).status).toBe('stale'); expect(driverPausedReason(oldKey)).toBeTruthy();
  });
  it.each([false, true])('an ordinary in-flight probe joined by explicit retry cannot cache success (stale=%s)', async (stale) => {
    pause(); const original = key(); let finish!: () => void; const wait = new Promise<void>((r) => { finish = r; });
    driver.probe = vi.fn(async () => { await wait; return { handshakeOk: true, capabilities: driver.capabilities }; });
    const ordinary = probeDriver(driver, state.binary, state.env, state.prefix);
    const explicit = retryAgentHandshake(dir, 'a');
    // Three context resolutions are not needed until receipt; wait for dispatch join.
    await vi.waitFor(() => expect(resolveCommandPrefix).toHaveBeenCalledTimes(2));
    await new Promise<void>((r) => setImmediate(r));
    const laterOrdinary = probeDriver(driver, state.binary, state.env, state.prefix);
    if (stale) state.agents[0].worktreePath = path.join(dir, 'moved');
    finish(); await ordinary; await laterOrdinary;
    expect((await explicit).status).toBe(stale ? 'stale' : 'passed');
    expect(driver.probe).toHaveBeenCalledTimes(1);
    await probeDriver(driver, state.binary, state.env, state.prefix);
    expect(driver.probe).toHaveBeenCalledTimes(2);
    if (stale) expect(driverPausedReason(original)).toBeTruthy();
  });
  it('an explicit in-flight probe cannot regain caching from later ordinary joins', async () => {
    let finish!: () => void; const wait = new Promise<void>((r) => { finish = r; });
    driver.probe = vi.fn(async () => { await wait; return { handshakeOk: true, capabilities: driver.capabilities }; });
    const explicit = retryAgentHandshake(dir, 'a'); await vi.waitFor(() => expect(driver.probe).toHaveBeenCalledTimes(1));
    const ordinary = probeDriver(driver, state.binary, state.env, state.prefix); finish(); await ordinary; await explicit;
    expect(driver.probe).toHaveBeenCalledTimes(1);
    await probeDriver(driver, state.binary, state.env, state.prefix); expect(driver.probe).toHaveBeenCalledTimes(2);
  });
  it.each(['dispatch', 'receipt'])('rejects changes during FINAL %s resolution after the last await', async (phase) => {
    pause(); const original = key(); fs.writeFileSync(script, 'repaired');
    let finish!: () => void; const wait = new Promise<void>((r) => { finish = r; }); let calls = 0;
    vi.mocked(resolveCommandPrefix).mockImplementation(async () => { if (++calls === (phase === 'dispatch' ? 2 : 3)) await wait; return state.prefix; });
    const check = retryAgentHandshake(dir, 'a');
    await vi.waitFor(() => expect(calls).toBe(phase === 'dispatch' ? 2 : 3));
    state.configGeneration++; state.agents[0] = { ...state.agents[0], worktreePath: path.join(dir, 'replaced') };
    finish(); expect((await check).status).toBe('stale');
    expect(driver.probe).toHaveBeenCalledTimes(phase === 'dispatch' ? 0 : 1); expect(driverPausedReason(original)).toBeTruthy();
  });
  it.each(['dispatch', 'receipt'])('rejects final %s interleavings for live state witnesses', async (phase) => {
    for (const change of ['registry', 'registry_completed', 'defaults', 'binary', 'lifecycle', 'launch_env', 'driver', 'external_settings']) {
      clearDriverHealth(); pause(); const original = key(); fs.writeFileSync(script, 'repaired');
      let finish!: () => void; const wait = new Promise<void>((r) => { finish = r; }); let calls = 0;
      vi.mocked(resolveCommandPrefix).mockImplementation(async () => { if (++calls === (phase === 'dispatch' ? 2 : 3)) await wait; return state.prefix; });
      vi.mocked(driver.probe).mockClear(); const check = retryAgentHandshake(dir, 'a');
      await vi.waitFor(() => expect(calls).toBe(phase === 'dispatch' ? 2 : 3));
      if (change === 'registry') { state.registry.generation++; state.registry.pending = true; state.projects = []; }
      if (change === 'registry_completed') { state.registry.generation++; state.projects = [{ path: path.join(dir, 'remapped') }]; }
      if (change === 'driver') registerChatDriver(new FakeChatDriver('codex_app_server', 'codex-cli'));
      if (change === 'external_settings') { fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true }); fs.writeFileSync(path.join(dir, '.clubhouse/settings.json'), '{"agentDefaults":{"commandPrefix":"changed"}}'); }
      if (change === 'defaults') { state.defaults.generation++; state.defaults.pending = true; }
      if (change === 'binary') fs.writeFileSync(state.binary, 'changed-'+Math.random());
      if (change === 'lifecycle') await withAgentActivity('a', async () => {});
      if (change === 'launch_env') state.env = { SAFE: 'changed' };
      finish(); expect((await check).status, change).toBe('stale');
      expect(driver.probe, change).toHaveBeenCalledTimes(phase === 'dispatch' ? 0 : 1); expect(driverPausedReason(original), change).toBeTruthy();
      state.registry.pending = false; state.defaults.pending = false; state.projects = [{ path: dir }]; state.env = { SAFE: 'synthetic' }; registerChatDriver(driver);
      fs.rmSync(path.join(dir, '.clubhouse'), { recursive: true, force: true });
    }
  });
  it.each(['registry', 'defaults'])('cannot probe with a preexisting pending %s write', async (kind) => {
    state[kind].pending = true;
    expect((await retryAgentHandshake(dir, 'a')).status).toBe('cannot_probe'); expect(driver.probe).not.toHaveBeenCalled();
  });
  it('revalidates at dispatch after asynchronous launch resolution', async () => {
    vi.mocked(resolveCommandPrefix).mockImplementationOnce(async () => { state.agents[0].orchestrator = 'claude-code'; state.configGeneration++; return state.prefix; });
    expect((await retryAgentHandshake(dir, 'a')).status).toBe('cannot_probe'); expect(driver.probe).not.toHaveBeenCalled();
  });
  it.each(['login', 'policy'])('distinguishes %s from a passed handshake and keeps failure state', async (reason) => {
    pause(); driver.probe = vi.fn(async () => ({ handshakeOk: true, capabilities: driver.capabilities, needsLogin: reason === 'login', cliVersion: reason === 'policy' ? '0.1.0' : '0.166.0' }));
    // Version policy fixture is injected below for a known blocked result.
    if (reason === 'policy') policy.blocked = true;
    expect((await retryAgentHandshake(dir, 'a')).status).toBe(reason === 'login' ? 'login_required' : 'policy_blocked');
    expect(driverPausedReason(key())).toBeTruthy();
  });
  it('validates registration before inspecting renderer-supplied project files', async () => {
    const unknown = path.join(dir, 'unregistered'); fs.mkdirSync(path.join(unknown, '.clubhouse'), { recursive: true });
    fs.writeFileSync(path.join(unknown, '.clubhouse/settings.json'), 'private');
    vi.mocked(fs.lstatSync).mockClear(); vi.mocked(fs.openSync).mockClear();
    expect(await retryAgentHandshake(unknown, 'a')).toMatchObject({ status: 'cannot_probe', message: 'Project is no longer registered.' });
    expect(vi.mocked(fs.lstatSync).mock.calls.some(([file]) => String(file).startsWith(unknown))).toBe(false);
    expect(driver.probe).not.toHaveBeenCalled();
  });
  it.each(['directory', 'oversized'])('refuses %s settings without reading their contents', async (kind) => {
    fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true }); const file = path.join(dir, '.clubhouse/settings.json');
    if (kind === 'directory') fs.mkdirSync(file);
    else { fs.writeFileSync(file, ''); fs.truncateSync(file, MAX_HANDSHAKE_INPUT_BYTES + 1); }
    expect((await retryAgentHandshake(dir, 'a')).status).toBe('cannot_probe'); expect(driver.probe).not.toHaveBeenCalled();
  });
  it.each(['disappear', 'replace'])('refuses observed post-lstat file %s instead of treating it as missing/current', async (change) => {
    fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true }); const file = path.join(dir, '.clubhouse/settings.json');
    fs.writeFileSync(file, '{}'); const real = process.getBuiltinModule('fs') as typeof import('node:fs'); let changed = false;
    vi.mocked(fs.openSync).mockImplementation((target, flags, mode) => {
      if (target === file && !changed) {
        changed = true;
        if (change === 'disappear') fs.unlinkSync(file);
        else { fs.writeFileSync(file + '.new', '{"replacement":true}'); fs.renameSync(file + '.new', file); }
      }
      return real.openSync(target, flags, mode);
    });
    expect((await retryAgentHandshake(dir, 'a')).status).toBe('cannot_probe'); expect(changed).toBe(true); expect(driver.probe).not.toHaveBeenCalled();
  });
  it('keeps raw binary/prefix/environment diagnostics out of receipts', async () => {
    driver.probe = vi.fn(async () => ({ handshakeOk: false, error: 'SECRET_BINARY SECRET_PREFIX SECRET_ENV', capabilities: driver.capabilities }));
    expect(JSON.stringify(await retryAgentHandshake(dir, 'a'))).not.toMatch(/SECRET_|synthetic binary/);
    vi.mocked(resolveOrchestrator).mockRejectedValueOnce(new Error('SECRET_BINARY'));
    expect(JSON.stringify(await retryAgentHandshake(dir, 'a'))).not.toContain('SECRET_BINARY');
  });
  it('refuses unknown/mismatched targets or disabled chat without probing', async () => {
    expect((await retryAgentHandshake(dir, 'unknown')).status).toBe('cannot_probe');
    expect((await retryAgentHandshake('/unregistered', 'a')).status).toBe('cannot_probe');
    state.mode = { mode: 'terminal' }; expect((await retryAgentHandshake(dir, 'a')).status).toBe('cannot_probe');
    state.mode = { mode: 'chat' }; state.active = { projectPath: '/other', orchestrator: 'codex-cli' };
    expect((await retryAgentHandshake(dir, 'a')).status).toBe('cannot_probe'); expect(driver.probe).not.toHaveBeenCalled();
    expect(resolveOrchestrator).toHaveBeenCalled();
  });
});
const policy = vi.hoisted(() => ({ blocked: false }));
vi.mock('./chat-version-policy', () => ({ evaluateCliVersion: () => policy.blocked ? { status: 'known_bad', message: 'Synthetic policy block' } : { status: 'supported' } }));
beforeEach(() => { policy.blocked = false; });
