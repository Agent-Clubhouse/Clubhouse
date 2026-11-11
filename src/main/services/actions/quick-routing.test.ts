import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelperRouting } from '../../../shared/helper-routing';

const h = vi.hoisted(() => ({ running: true, exits: new Set<(id: string) => void>() }));
vi.mock('../agent-system', () => ({ isAgentRunning: () => h.running }));
vi.mock('../agent-exit-broadcast', () => ({
  onAgentExit: (fn: (id: string) => void) => { h.exits.add(fn); return () => { h.exits.delete(fn); }; },
}));
vi.mock('../clubhouse-mcp/tools/helper-tools', () => ({
  withStartLock: (fn: () => Promise<unknown>) => fn(),
  currentHelperLoad: vi.fn(async () => ({ 'codex-cli': { live: 1, reserved: 0 } })),
}));
vi.mock('../helper-routing', () => ({
  planHelperStart: vi.fn(),
  readHelperAuto: vi.fn(async () => ({ effective: true })),
  decideAutoPlan: vi.fn(),
  autoOffRefusal: vi.fn(() => ({ message: 'Auto is turned off.' })),
}));
vi.mock('../helper-auto-state', () => ({ commitAutoDecision: vi.fn(), settleAutoDecision: vi.fn() }));
vi.mock('../quick-agent-service', () => ({ startQuickAgent: vi.fn(async () => ({ id: 'quick_1', name: 'Review' })) }));

import { startActionQuickAgent } from './quick-routing';
import { decideAutoPlan, planHelperStart, readHelperAuto } from '../helper-routing';
import { commitAutoDecision, settleAutoDecision } from '../helper-auto-state';
import { startQuickAgent } from '../quick-agent-service';

const request = { project: { id: 'p1', path: '/p1' }, prompt: 'Review changes', orchestrator: 'auto', headless: true };
const routing: HelperRouting = {
  mode: 'auto', balanced: true, decidedAt: '2026-11-11T00:00:00Z', policyVersion: 1,
  requested: { provider: 'auto', model: null, effort: null, difficulty: 'medium' },
  resolved: { provider: 'codex-cli', model: 'gpt-5.3-codex', effort: 'high', difficulty: 'medium' },
  source: { provider: 'auto', model: 'builtin_mapping', effort: 'builtin_mapping' },
  reason: 'lower_load', fallback: 'none', context: { status: 'none' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.running = true;
  h.exits.clear();
  vi.mocked(readHelperAuto).mockResolvedValue({ effective: true } as Awaited<ReturnType<typeof readHelperAuto>>);
  vi.mocked(planHelperStart).mockResolvedValue({ ok: true, plan: { routing } });
  vi.mocked(decideAutoPlan).mockReturnValue({
    ok: true, plan: { routing, provider: 'codex-cli', model: 'gpt-5.3-codex', effort: 'high', decision: { decisionId: 'd1' } as NonNullable<import('../helper-routing').StartPlan['decision']> },
  });
});

describe('Action quick-agent routing', () => {
  it('uses helper Auto with medium difficulty and returns its receipt', async () => {
    expect(await startActionQuickAgent(request)).toMatchObject({ id: 'quick_1', routing });
    expect(planHelperStart).toHaveBeenCalledWith({ cli: 'auto', difficulty: 'medium', projectPath: '/p1', auto: { effective: true } });
    expect(decideAutoPlan).toHaveBeenCalledWith({ routing }, { 'codex-cli': { live: 1, reserved: 0 } });
    expect(startQuickAgent).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: 'codex-cli', model: 'gpt-5.3-codex', effort: 'high' }));
    expect(commitAutoDecision).toHaveBeenCalledWith('d1', 'quick_1');
    expect(settleAutoDecision).toHaveBeenCalledWith('d1', 'started');
  });

  it('keeps an explicit provider and model unchanged', async () => {
    const explicit = { ...request, orchestrator: 'claude-code', model: 'opus' };
    await startActionQuickAgent(explicit);
    expect(startQuickAgent).toHaveBeenCalledWith(explicit);
    expect(planHelperStart).not.toHaveBeenCalled();
  });

  it('reports the plain refusal when no Auto candidate can run', async () => {
    vi.mocked(decideAutoPlan).mockReturnValue({ ok: false, code: 'no_candidate', message: 'No provider is available now.', userReason: 'no provider is available now.' });
    await expect(startActionQuickAgent(request)).rejects.toThrow('No provider is available now.');
    expect(startQuickAgent).not.toHaveBeenCalled();
  });

  it('releases the reservation when starting fails', async () => {
    vi.mocked(startQuickAgent).mockRejectedValueOnce(new Error('CLI missing'));
    await expect(startActionQuickAgent({ ...request, difficulty: 'hard' })).rejects.toThrow('CLI missing');
    expect(planHelperStart).toHaveBeenCalledWith(expect.objectContaining({ difficulty: 'hard' }));
    expect(settleAutoDecision).toHaveBeenCalledWith('d1', 'spawn_failed');
  });

  it('releases a finished quick agent even if no later load read ever saw its transient registration', async () => {
    await startActionQuickAgent(request);
    for (const exit of h.exits) exit('unrelated');
    expect(h.exits.size).toBe(1);
    for (const exit of h.exits) exit('quick_1');
    expect(settleAutoDecision).toHaveBeenLastCalledWith('d1', 'left_asleep');
    expect(h.exits.size).toBe(0);
  });

  it('releases a quick agent that exited before its start returned', async () => {
    h.running = false;
    await startActionQuickAgent(request);
    expect(settleAutoDecision).toHaveBeenLastCalledWith('d1', 'left_asleep');
    expect(h.exits.size).toBe(0);
  });
});
