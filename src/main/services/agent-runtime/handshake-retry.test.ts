import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators';
const state = vi.hoisted(() => ({ agents: [] as DurableAgentConfig[], projects: [] as { path: string }[], binary: '', prefix: '', env: { SAFE: 'synthetic' }, mode: { mode: 'chat' } as { mode: 'chat' | 'terminal'; driver?: 'codex_app_server' }, active: undefined as unknown }));
vi.mock('../agent-config', () => ({ peekDurableConfigs: vi.fn(async () => state.agents) }));
vi.mock('../project-store', () => ({ peekProjects: vi.fn(async () => state.projects) }));
vi.mock('../dispatcher/dispatcher-paths', () => ({ isDispatcherPath: () => false }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: () => state.active } }));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: vi.fn(async (_p: string, provider?: string) => ({ id: provider || 'codex-cli', getBinaryPath: () => state.binary }) as OrchestratorProvider),
  resolveProfileEnv: vi.fn(async () => state.env), resolveCommandPrefix: vi.fn(async () => state.prefix),
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: () => state.mode }));
vi.mock('./chat-spawn', () => ({ chatLaunchEnvironment: vi.fn((env) => env) }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
import { retryAgentHandshake } from './handshake-retry';
import { FakeChatDriver } from './fake-chat-driver';
import { clearChatDrivers, registerChatDriver } from './chat-drivers';
import { clearDriverHealth, driverHealthKey, driverPausedReason, probeDriver, recordDriverFailure, DRIVER_FAILURE_THRESHOLD } from './chat-driver-health';
import { resolveCommandPrefix, resolveProfileEnv, resolveOrchestrator } from '../agent-system';
import { chatLaunchEnvironment } from './chat-spawn';
import { withAgentActivity } from '../agent-transition';
let dir: string, script: string, driver: FakeChatDriver;
const key = () => driverHealthKey(driver, state.binary, state.env, state.prefix);
function pause(k = key()) { for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure(k, 'failed', Date.now(), state.binary); }
beforeEach(() => {
  vi.clearAllMocks(); clearChatDrivers(); clearDriverHealth();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-2851-')); script = path.join(dir, 'init.sh');
  state.binary = path.join(dir, 'fake-cli'); fs.writeFileSync(state.binary, 'synthetic binary; never executed'); fs.writeFileSync(script, 'broken');
  state.prefix = `. "${script}"`; state.mode = { mode: 'chat' }; state.env = { SAFE: 'synthetic' }; state.active = undefined;
  state.projects = [{ path: dir }]; state.agents = [{ id: 'a', name: 'test', color: 'blue', createdAt: '', worktreePath: dir, orchestrator: 'codex-cli' }];
  driver = new FakeChatDriver('codex_app_server', 'codex-cli');
  driver.probe = vi.fn(async () => ({ handshakeOk: fs.readFileSync(script, 'utf8') === 'repaired', capabilities: driver.capabilities, cliVersion: '0.166.0', error: 'synthetic prefix failed' }));
  vi.spyOn(driver, 'start'); registerChatDriver(driver);
});
afterEach(() => { clearChatDrivers(); clearDriverHealth(); fs.rmSync(dir, { recursive: true, force: true }); });
describe('explicit scoped handshake retry', () => {
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
    expect(resolveProfileEnv).toHaveBeenCalledWith(dir, 'codex-cli'); expect(resolveCommandPrefix).toHaveBeenCalledWith(dir); expect(chatLaunchEnvironment).toHaveBeenCalledWith(state.env);
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
    if (change === 'provider') state.agents[0].orchestrator = 'claude-code';
    if (change === 'folder') state.agents[0].worktreePath = path.join(dir, 'other');
    if (change === 'driver') registerChatDriver(new FakeChatDriver('codex_app_server', 'codex-cli'));
    if (change === 'binary') fs.writeFileSync(state.binary, 'replaced binary');
    if (change === 'prefix') state.prefix = 'changed';
    if (change === 'env') state.env = { SAFE: 'changed' };
    if (change === 'lifecycle') await withAgentActivity('a', async () => {});
    finish(); expect((await check).status).toBe('stale'); expect(driverPausedReason(oldKey)).toBeTruthy();
  });
  it('revalidates at dispatch after asynchronous launch resolution', async () => {
    vi.mocked(resolveCommandPrefix).mockImplementationOnce(async () => { state.agents[0].orchestrator = 'claude-code'; return state.prefix; });
    expect((await retryAgentHandshake(dir, 'a')).status).toBe('stale'); expect(driver.probe).not.toHaveBeenCalled();
  });
  it.each(['login', 'policy'])('distinguishes %s from a passed handshake and keeps failure state', async (reason) => {
    pause(); driver.probe = vi.fn(async () => ({ handshakeOk: true, capabilities: driver.capabilities, needsLogin: reason === 'login', cliVersion: reason === 'policy' ? '0.1.0' : '0.166.0' }));
    // Version policy fixture is injected below for a known blocked result.
    if (reason === 'policy') policy.blocked = true;
    expect((await retryAgentHandshake(dir, 'a')).status).toBe(reason === 'login' ? 'login_required' : 'policy_blocked');
    expect(driverPausedReason(key())).toBeTruthy();
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
