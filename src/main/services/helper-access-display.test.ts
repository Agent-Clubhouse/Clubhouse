import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentRegistration } from './agent-registry';
import type { OrchestrationAccess } from '../../shared/orchestration-policy';
import { accessNote } from '../../shared/helper-policy-display';
import { resolveHelperAccess } from '../../shared/orchestration-policy';
const m = vi.hoisted(() => ({ get: vi.fn(), live: vi.fn(), runtime: vi.fn() }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: m.get } }));
vi.mock('./agent-system', () => ({ isAgentRunning: m.live }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: m.runtime }));
import { readHelperAccessNoteForDisplay } from './helper-access-display';
const registration = (): AgentRegistration => ({ projectPath: '/selected/project', cwd: '/selected/worktree', runtime: 'pty', nonce: 'PRIVATE_NONCE', orchestrator: 'claude-code', launchAccess: { freeAgentMode: true, permissionMode: 'auto', access: 'auto' } });
const policy = (value: OrchestrationAccess = 'same') => ({ state: 'ok' as const, value, inputs: [] });
const read = (access = policy(), receipts: Array<{ current(): boolean }> = []) => ({ value: readHelperAccessNoteForDisplay('selected', '/selected/project', 'Selected', access, { receipts }), receipts });
beforeEach(() => { m.get.mockReturnValue(registration()); m.live.mockReturnValue(true); m.runtime.mockReset(); });
it.each(['same', 'standard', 'auto', 'bypass'] as const)('shares the exact local note for recorded current ceiling and policy=%s', (access) => {
  const r = m.get(), result = read(policy(access));
  expect(result.value).toMatchObject({ state: 'ok', value: accessNote(resolveHelperAccess(r.launchAccess, access, r.orchestrator), true, 'Selected'), inputs: [{ source: 'host-cache' }] });
  expect(result.receipts[0].current()).toBe(true); expect(JSON.stringify(result.value)).not.toMatch(/PRIVATE_|nonce|projectPath|worktree|permissionMode|freeAgentMode/);
  expect(m.runtime).not.toHaveBeenCalled();
});
it.each(['plan', 'ask', 'auto_edit'] as const)('preserves recorded five-level %s ceiling below legacy Free Agent Mode', (access) => {
  m.get.mockReturnValue({ ...registration(), launchAccess: { freeAgentMode: false, access } });
  expect(read().value).toMatchObject({ state: 'ok', value: accessNote(resolveHelperAccess({ freeAgentMode: false, access }, 'same', 'claude-code'), true, 'Selected') });
});
it.each(['missing-registration', 'missing-launch', 'missing-mode', 'malformed-mode', 'malformed-flag', 'malformed-access', 'contradictory-access', 'missing-nonce', 'wrong-project', 'unknown-policy', 'missing-provider'] as const)('keeps %s evidence unknown without saved/default inference', (kind) => {
  const r = registration();
  if (kind === 'missing-registration') m.get.mockReturnValue(undefined);
  else {
    if (kind === 'missing-launch') r.launchAccess = undefined;
    if (kind === 'missing-mode') r.launchAccess = { freeAgentMode: true };
    if (kind === 'malformed-mode') r.launchAccess = { freeAgentMode: true, permissionMode: 'bad' as never };
    if (kind === 'malformed-flag') r.launchAccess = { freeAgentMode: 'true' as never };
    if (kind === 'malformed-access') r.launchAccess = { freeAgentMode: false, access: 'bad' as never };
    if (kind === 'contradictory-access') r.launchAccess = { freeAgentMode: false, access: 'full_access' };
    if (kind === 'missing-nonce') r.nonce = undefined;
    if (kind === 'missing-provider') r.orchestrator = '';
    if (kind === 'wrong-project') r.projectPath = '/other/project';
    m.get.mockReturnValue(r);
  }
  const access = kind === 'unknown-policy' ? { state: 'unavailable' as const, inputs: [] } : policy();
  const receipts: Array<{ current(): boolean }> = [], value = readHelperAccessNoteForDisplay('selected', '/selected/project', 'Selected', access, { receipts });
  expect(value.state).toBe('unavailable'); expect(JSON.stringify(value)).not.toMatch(/Ask first|Full access|PRIVATE_|nonce/); expect(receipts[0].current()).toBe(true);
});
it('shows only the general local launch rule while stopped, not a retained live level', () => {
  m.live.mockReturnValue(false); const result = read();
  expect(result.value).toMatchObject({ state: 'ok', value: 'Never more than Selected’s level when a helper starts.' });
  m.live.mockReturnValue(true); expect(result.receipts[0].current()).toBe(false);
});
it.each(['level', 'nonce', 'replacement', 'untrack', 'stop', 'provider', 'project', 'cwd', 'kind'] as const)('keeps the actual admitted registration/current record through late %s changes', (kind) => {
  const r = registration(); m.get.mockReturnValue(r); const result = read(); expect(result.value.state).toBe('ok'); expect(result.receipts[0].current()).toBe(true);
  if (kind === 'level') r.launchAccess = { freeAgentMode: false, access: 'plan' };
  if (kind === 'nonce') r.nonce = 'PRIVATE_NEW';
  if (kind === 'replacement') m.get.mockReturnValue({ ...r });
  if (kind === 'untrack') m.get.mockReturnValue(undefined);
  if (kind === 'stop') m.live.mockReturnValue(false);
  if (kind === 'provider') r.orchestrator = 'copilot-cli';
  if (kind === 'project') r.projectPath = '/other';
  if (kind === 'cwd') r.cwd = '/other';
  if (kind === 'kind') r.runtime = 'headless';
  expect(result.receipts[0].current()).toBe(false);
});
it.each(['same', 'generation', 'native', 'session', 'replacement', 'missing-generation'] as const)('binds same-object chat identity and display generation: %s', (change) => {
  const r = registration(); r.runtime = 'chat'; m.get.mockReturnValue(r);
  let run = change === 'missing-generation' ? undefined : 'run1', native = 'native1', session = 'session1';
  const runtime = { kind: 'chat', getDisplayRunId: () => run, getNativeSessionId: () => native, getSessionId: () => session }; m.runtime.mockReturnValue(runtime);
  const result = read(); expect(result.value.state).toBe(change === 'missing-generation' ? 'unavailable' : 'ok'); expect(result.receipts[0].current()).toBe(true);
  if (change === 'generation') run = 'run2';
  if (change === 'native') native = 'native2';
  if (change === 'session') session = 'session2';
  if (change === 'replacement') m.runtime.mockReturnValue({ ...runtime });
  expect(result.receipts[0].current()).toBe(change === 'same' || change === 'missing-generation');
});
it('uses the actually registered helper provider ranking without next-start provider inference', () => {
  m.get.mockReturnValue({ ...registration(), orchestrator: 'copilot-cli' });
  expect(read(policy('auto')).value).toMatchObject({ state: 'ok', value: 'Selected runs at Auto now, so helpers get Ask first.' });
});
