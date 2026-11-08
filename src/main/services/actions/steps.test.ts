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

  it('a message step wakes a sleeping agent only for an owner that may wake it (D131)', async () => {
    const owner = { kind: 'agent', agentId: 'lead' } as const;
    const agentCtx = { ...ctx, action: { ...ctx.action, owner } };
    const wakeRefusal = vi.fn(() => 'release-lead doesn’t have the Clubhouse permission agent.wake on that agent.');
    const d = deps({ wakeRefusal });
    const r = await createStepRunner(d).run({ kind: 'message', agentId: 'pm', text: 'hi' }, agentCtx);
    expect(r).toMatchObject({ outcome: 'failed', detail: 'pm is asleep, so the message wasn’t sent. release-lead doesn’t have the Clubhouse permission agent.wake on that agent.' });
    expect(wakeRefusal).toHaveBeenCalledWith(owner, 'pm');
    expect(d.wake).not.toHaveBeenCalled();
    // Awake, it gets the message without being woken.
    runtimes.set('pm', { kind: 'chat', isRunning: () => true, getState: () => 'idle', sendMessage: vi.fn(async () => ({ delivery: 'delivered' })), onStateChange: () => () => undefined });
    expect((await createStepRunner(d).run({ kind: 'message', agentId: 'pm', text: 'hi' }, agentCtx)).outcome).toBe('done');
    // An owner that may wake it wakes it with the message.
    runtimes.clear();
    const may = deps({ wakeRefusal: () => null });
    expect(await createStepRunner(may).run({ kind: 'message', agentId: 'pm', text: 'hi' }, agentCtx)).toMatchObject({ outcome: 'done', detail: 'Woke pm with the message' });
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

  it('starts every quick agent headless at Full access, whoever owns the action', async () => {
    const d = deps();
    const agentCtx = { ...ctx, action: { ...ctx.action, owner: { kind: 'agent' as const, agentId: 'lead' } } };
    await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', prompt: 'x' }, agentCtx);
    await createStepRunner(d).run({ kind: 'quick', projectId: 'p1', prompt: 'x', orchestrator: 'copilot-cli' }, ctx);
    const calls = vi.mocked(d.startQuick).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.access)).toEqual(['full_access', 'full_access']);
    expect(calls.map((c) => c.headless)).toEqual([true, true]);
    expect(calls.some((c) => 'interactive' in c)).toBe(false);
  });

  it('a run an event set off says what happened', async () => {
    const d = deps();
    const evCtx: StepContext = { ...ctx, trigger: { kind: 'event', at: 1, detail: 'web is pushed, pulled or fetched (main)' } };
    await createStepRunner(d).run({ kind: 'message', agentId: 'pm', text: 'Tag the release.' }, evCtx);
    expect(d.wake).toHaveBeenCalledWith(expect.objectContaining({
      mission: '[Clubhouse action “Morning”] Tag the release.\nWhat happened: web is pushed, pulled or fetched (main).',
    }));
  });

  describe('the Dispatcher as a target (#3042)', () => {
    const deliver = vi.fn(async (): Promise<{ delivered: true; woke: boolean } | { delivered: false; text: string; skipped?: boolean }> => ({ delivered: true, woke: true }));
    const withDispatcher = (over: Partial<StepDeps> = {}) => deps({
      agentName: (id) => (id === 'disp' ? 'Rosie' : id),
      dispatcher: { is: (id) => id === 'disp', deliver },
      ...over,
    });
    const owned = (owner: StepContext['action']['owner']): StepContext => ({
      ...ctx, action: { ...ctx.action, owner }, trigger: { kind: 'event', at: 1, detail: 'release-lead goes to sleep' },
    });

    beforeEach(() => deliver.mockClear());

    it('goes through its one delivery path, never the plain wake', async () => {
      const d = withDispatcher();
      const r = await createStepRunner(d).run({ kind: 'message', agentId: 'disp', text: 'Check its handoff.' }, owned({ kind: 'dispatcher' }));
      expect(r).toMatchObject({ outcome: 'done', detail: 'Woke Rosie with the message', agentId: 'disp' });
      expect(d.wake).not.toHaveBeenCalled();
      // Its own subscription sends as itself: waking yourself needs no grant.
      expect(deliver).toHaveBeenCalledWith({
        senderId: 'disp', targetId: 'disp', targetName: 'Rosie', actionId: 'a1', actionName: 'Morning', owner: { kind: 'dispatcher' },
        text: '[Clubhouse action “Morning”] Check its handoff.\nWhat happened: release-lead goes to sleep.',
        routed: [{ fromClubhouse: true, text: 'Action “Morning”: Check its handoff.\nWhat happened: release-lead goes to sleep.' }],
      });
    });

    it('an agent’s action wakes it only as that agent, and an undelivered message is a failure', async () => {
      deliver.mockResolvedValueOnce({ delivered: false, text: 'Rosie is asleep, and waking it asks the user first.' });
      const r = await createStepRunner(withDispatcher()).run({ kind: 'message', agentId: 'disp', text: 'hi' }, owned({ kind: 'agent', agentId: 'lead' }));
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'lead' }));
      expect(r).toMatchObject({ outcome: 'failed', detail: 'Couldn’t deliver the message: Rosie is asleep, and waking it asks the user first.' });
    });

    it('a message to an awake Dispatcher is sent, and a delivery error is a failure', async () => {
      deliver.mockResolvedValueOnce({ delivered: true, woke: false });
      expect(await createStepRunner(withDispatcher()).run({ kind: 'message', agentId: 'disp', text: 'hi' }, owned({ kind: 'app' })))
        .toMatchObject({ outcome: 'done', detail: 'Sent the message to Rosie' });
      deliver.mockRejectedValueOnce(new Error('pipe closed'));
      expect(await createStepRunner(withDispatcher()).run({ kind: 'message', agentId: 'disp', text: 'hi' }, owned({ kind: 'app' })))
        .toMatchObject({ outcome: 'failed', detail: 'Couldn’t deliver the message to Rosie: pipe closed' });
    });

    it('a message Clubhouse found it didn’t need to send is a finished step, not a failure (#3040)', async () => {
      deliver.mockResolvedValueOnce({ delivered: false, skipped: true, text: 'Nothing needed checking.' });
      expect(await createStepRunner(withDispatcher()).run({ kind: 'message', agentId: 'disp', text: 'hi' }, owned({ kind: 'app' })))
        .toMatchObject({ outcome: 'done', detail: 'Nothing needed checking.', agentId: 'disp' });
    });
  });
});
