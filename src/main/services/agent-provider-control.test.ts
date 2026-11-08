import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRegistry } from './agent-registry';
import { withAgentActivity, withAgentTransition } from './agent-transition';
import { changeAgentProvider, previewAgentProvider } from './agent-provider-control';
const w = vi.hoisted(() => ({ config: {} as any, available: true, instructions: 'same', runtime: 'terminal', running: false, captureFailed: false, beforeCommit: undefined as undefined | (() => void), beforeAvailability: undefined as undefined | (() => void) }));
vi.mock('./agent-config', () => ({
  getDurableConfig: async () => w.config,
  flushAgentConfig: async () => {},
  updateDurableConfig: vi.fn(async (_p, _id, update, check) => { w.beforeCommit?.(); await check?.(); w.config.orchestrator = update.orchestrator; delete w.config.lastSessionId; }),
}));
vi.mock('./agent-system', () => ({
  resolveOrchestrator: async (_p: string, id = 'claude-code') => ({ id, getCapabilities: () => ({ permissions: true }), inspectInstructions: async () => id === 'codex-cli' ? w.instructions : 'same' }),
  checkAvailability: async () => { w.beforeAvailability?.(); return { available: w.available }; },
  isAgentRunning: () => w.running, isAgentStopping: () => false,
  waitForAgentStopped: async () => !w.running,
}));
vi.mock('./mobile-agents', () => ({ effectiveOrchestrators: () => [{ id: 'claude-code' }, { id: 'codex-cli' }] }));
vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: async () => ({}) }));
vi.mock('./free-agent-settings');
vi.mock('./chat-runtime-settings', () => ({ isChatEnabled: () => true, resolveRuntimeMode: () => ({ mode: w.runtime }) }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: vi.fn(() => undefined) } }));
vi.mock('./session-capture-barrier', () => ({ sessionCaptureFor: () => undefined, hasSessionCaptureFailure: () => w.captureFailed, noteSessionCaptureFailure: () => { w.captureFailed = true; } }));
import { updateDurableConfig } from './agent-config';
const actor = { key: 'phone:paired', assertAuthorized: () => {} };
const preview = () => previewAgentProvider('/fixture', 'a', 'codex-cli', actor);
beforeEach(() => {
  w.config = { id: 'a', name: 'Agent', orchestrator: 'claude-code', lastSessionId: 'claude-native', sessionHistory: [{ sessionId: 'claude-native', orchestrator: 'claude-code' }], worktreePath: '/fixture/work', orchestration: { control: 'hands-off' }, mcpIds: ['workiq'] };
  w.beforeCommit = undefined; w.runtime = 'terminal'; w.captureFailed = false; w.available = true; w.instructions = 'same'; w.running = false; w.beforeAvailability = undefined;
  vi.mocked(updateDurableConfig).mockClear(); vi.mocked(agentRegistry.get).mockReturnValue(undefined);
});
describe('guided provider control', () => {
  it('preserves identity/history/policy and writes only provider; never starts', async () => {
    const p = await preview();
    expect(p).toMatchObject({ canSave: true, activeProvider: null, contextTransferred: false, nextStart: 'new_session' });
    const original = structuredClone(w.config);
    expect(await changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).toMatchObject({ status: 'changed', state: 'sleeping' });
    expect(updateDurableConfig).toHaveBeenCalledWith('/fixture', 'a', { orchestrator: 'codex-cli' }, expect.any(Function));
    expect(w.config).toEqual({ ...original, orchestrator: 'codex-cli', lastSessionId: undefined });
  });
  it('rejects stale configuration and a token belonging to another caller', async () => {
    const p = await preview(); w.config.model = 'changed';
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    delete w.config.model;
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, { ...actor, key: 'phone:other' })).rejects.toMatchObject({ code: 'stale_state' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('refuses unavailable provider, instruction mismatch and a live agent', async () => {
    w.available = false; expect(await preview()).toMatchObject({ canSave: false, blocked: 'orchestrator_unavailable' });
    w.available = true; w.instructions = 'different'; expect(await preview()).toMatchObject({ blocked: 'instructions_not_equivalent' });
    w.instructions = 'same'; w.running = true; expect(await preview()).toMatchObject({ blocked: 'agent_running' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('blocks saving after a failed capture even though the process has stopped', async () => {
    w.captureFailed = true;
    const p = await preview();
    expect(p).toMatchObject({ state: 'sleeping', canSave: false, blocked: 'session_capture_failed' });
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'session_capture_failed' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('rechecks authorization after async capability checks', async () => {
    let revoked = false;
    w.beforeAvailability = () => { revoked = true; };
    await expect(previewAgentProvider('/fixture', 'a', 'codex-cli', { key: 'phone', assertAuthorized: () => { if (revoked) throw new Error('revoked'); } })).rejects.toThrow('revoked');
  });
  it('rechecks runtime after config preflight, immediately before mutation', async () => {
    const p = await preview();
    w.beforeCommit = () => { w.runtime = 'chat'; };
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    expect(w.config.orchestrator).toBe('claude-code');
  });
  it('rejects a preview after the target runtime changes', async () => {
    const p = await preview(); w.runtime = 'chat';
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('detects an intervening lifecycle even if the saved config did not change', async () => {
    const p = await preview(); await withAgentActivity('a', async () => {});
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
  });
});
describe('transition reservation', () => {
  it('refuses a competing start/write until the reservation finishes', async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const active = withAgentTransition('b', async () => { entered(); await new Promise<void>((r) => { release = r; }); });
    await ready;
    await expect(withAgentActivity('b', async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
    release(); await active;
    await expect(withAgentActivity('b', async () => 'ok')).resolves.toBe('ok');
  });
  it('refuses a transition while an earlier write/start is in flight', async () => {
    let release!: () => void;
    const active = withAgentActivity('c', () => new Promise<void>((r) => { release = r; }));
    await expect(withAgentTransition('c', async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
    release(); await active;
  });
});
