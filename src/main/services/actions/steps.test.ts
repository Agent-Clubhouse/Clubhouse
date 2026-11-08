import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimes = new Map<string, { kind: string; isRunning: () => boolean; getState: () => string; sendMessage: ReturnType<typeof vi.fn>; onStateChange: (l: (s: string) => void) => () => void }>();
vi.mock('../agent-runtime', () => ({
  getAgentRuntime: (id: string) => runtimes.get(id),
  isAgentStoppingError: () => false,
}));

import { resetAppEventBus } from '../app-event-bus';
import { createStepRunner, type StepDeps } from './steps';
import type { StepContext } from './engine';

const ctx: StepContext = {
  action: { id: 'a1', name: 'Morning', trigger: { kind: 'once', at: 1 }, steps: [], overlap: 'skip', owner: { kind: 'user' }, enabled: true, createdAt: 0, updatedAt: 0 },
  runId: 'r1',
  chain: ['a1'],
};

function deps(over: Partial<StepDeps> = {}): StepDeps {
  return {
    agentExists: (id) => id !== 'gone',
    agentName: (id) => ({ pm: 'pm', lead: 'release-lead' } as Record<string, string>)[id],
    agentWorktree: (id) => (id === 'lead' ? '/p1/.wt/lead' : undefined),
    isRunning: (id) => runtimes.has(id),
    project: (id) => (id === 'p1' ? { id: 'p1', path: '/p1', name: 'web', orchestrator: 'codex-cli' } : undefined),
    wake: vi.fn(async () => ({ ok: true, status: 'running', text: '{}' })),
    sleep: vi.fn(async () => ({ ok: true, status: 'sleeping', text: '{}' })),
    startQuick: vi.fn(async () => ({ id: 'quick_1', name: 'Morning' })),
    agentAccess: () => 'auto_edit',
    notify: vi.fn(() => ({ shown: true })),
    sleepWaitMs: 20,
    ...over,
  };
}

beforeEach(() => {
  runtimes.clear();
  resetAppEventBus();
});

describe('step runner', () => {
  it('wakes a sleeping agent with the prompt as its first message', async () => {
    const d = deps();
    const r = await createStepRunner(d).run({ kind: 'wake', agentId: 'pm', prompt: 'Post the plan' }, ctx);
    expect(r).toMatchObject({ outcome: 'done', agentId: 'pm', detail: 'Woke pm with the message' });
    expect(d.wake).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'pm', mission: '[Clubhouse action “Morning”] Post the plan' }));
  });

  it('queues a message for a busy chat agent', async () => {
    const sendMessage = vi.fn(async () => ({ delivery: 'queued' }));
    runtimes.set('pm', { kind: 'chat', isRunning: () => true, getState: () => 'running', sendMessage, onStateChange: () => () => undefined });
    const d = deps();
    const r = await createStepRunner(d).run({ kind: 'message', agentId: 'pm', text: 'hi' }, ctx);
    expect(r.outcome).toBe('done');
    expect(sendMessage).toHaveBeenCalledWith('[Clubhouse action “Morning”] hi', expect.objectContaining({ source: 'action', delivery: 'queued' }));
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('fails plainly when the target is gone or can’t wake', async () => {
    expect(await createStepRunner(deps()).run({ kind: 'wake', agentId: 'gone' }, ctx)).toMatchObject({ outcome: 'failed', detail: 'The agent is gone.' });
    const d = deps({ wake: vi.fn(async () => ({ ok: false, text: 'Failed to wake agent: codex is not installed' })) });
    expect(await createStepRunner(d).run({ kind: 'wake', agentId: 'pm' }, ctx)).toMatchObject({ outcome: 'failed', detail: 'Couldn’t wake pm: Failed to wake agent: codex is not installed' });
  });

  it('waits for a busy chat turn before sleeping', async () => {
    let listener: ((s: string) => void) | undefined;
    runtimes.set('pm', { kind: 'chat', isRunning: () => true, getState: () => 'running', sendMessage: vi.fn(), onStateChange: (l) => { listener = l; return () => undefined; } });
    const d = deps();
    const pending = createStepRunner(d).run({ kind: 'sleep', agentId: 'pm' }, ctx);
    await Promise.resolve();
    expect(d.sleep).not.toHaveBeenCalled();
    listener?.('idle');
    expect(await pending).toMatchObject({ outcome: 'done', detail: 'Put pm to sleep' });
  });

  it('starts a quick agent in another agent’s worktree, named after the action', async () => {
    const d = deps();
    const r = await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', worktreeAgentId: 'lead', prompt: 'Tidy notes' }, ctx);
    expect(r).toMatchObject({ outcome: 'done', agentId: 'quick_1', projectId: 'p1' });
    expect(d.startQuick).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/p1/.wt/lead', orchestrator: 'codex-cli', name: 'Morning' }));
    expect(await createStepRunner(d).run({ kind: 'quick', projectId: 'p9', prompt: 'x' }, ctx)).toMatchObject({ outcome: 'failed' });
  });

  it('notifying with notifications off is not a failure', async () => {
    const d = deps({ notify: vi.fn(() => ({ shown: false, reason: 'notifications are off in Settings' })) });
    expect(await createStepRunner(d).run({ kind: 'notify', text: 'x' }, ctx)).toMatchObject({ outcome: 'done', detail: 'Not shown: notifications are off in Settings' });
  });

  it('starts an agent’s quick agent at most at the agent’s own Access level', async () => {
    const d = deps();
    const agentCtx = { ...ctx, action: { ...ctx.action, owner: { kind: 'agent' as const, agentId: 'lead' } } };
    await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', prompt: 'x', access: 'full_access' }, agentCtx);
    await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', prompt: 'x' }, agentCtx);
    await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', prompt: 'x', access: 'plan' }, agentCtx);
    // A person's action: the chosen level, or none (the app's Default access).
    await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', prompt: 'x' }, ctx);
    const levels = vi.mocked(d.startQuick).mock.calls.map((c) => c[0].access);
    expect(levels).toEqual(['auto_edit', 'auto_edit', 'plan', undefined]);
  });
});
