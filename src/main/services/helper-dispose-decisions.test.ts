/**
 * Dispose decisions for a helper whose orchestrator is in another project
 * (#2513): the request records the helper's project, and everything about the
 * helper is read from there while the orchestrator is reached by id.
 */
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, HelperDisposeChecks } from '../../shared/types';

const { configs, sent } = vi.hoisted(() => ({
  configs: new Map<string, DurableAgentConfig[]>(),
  sent: [] as string[],
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-config', () => ({
  getDurableConfig: vi.fn(async (p: string, id: string) => (configs.get(p) ?? []).find((a) => a.id === id) ?? null),
  getDisposeChecks: vi.fn(async (): Promise<HelperDisposeChecks> => ({ dirty: 0, unpushed: 0, unmerged: 0 })),
  disposeHelper: vi.fn(async () => ({ ok: true, message: 'Disposed' })),
}));
vi.mock('./agent-system', () => ({ isAgentRunning: vi.fn(() => false), killAgent: vi.fn() }));
vi.mock('./orchestration-policy', () => ({
  withAgentLock: vi.fn(async (_p: string, _id: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./agent-runtime', () => ({
  getAgentRuntime: vi.fn((id: string) => (id === 'durable_orch'
    ? { sendMessage: async (text: string) => { sent.push(text); return { delivery: 'prompt' }; } }
    : undefined)),
}));

import * as agentConfig from './agent-config';
import { disposeHelperForUser, reportDisposeDecision } from './helper-dispose-decisions';
import { recordDisposeRequest, _resetDisposeRequestsForTesting } from './helper-dispose-requests';

const orchestratorProject = path.join(os.tmpdir(), 'clubhouse-dispose-decisions', 'orchestrator');
const helperProject = path.join(os.tmpdir(), 'clubhouse-dispose-decisions', 'helper');
const clean: HelperDisposeChecks = { dirty: 0, unpushed: 0, unmerged: 0 };

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig =>
  ({ id, name: id.replace('durable_', ''), color: 'blue', createdAt: '2026-10-31', ...extra }) as DurableAgentConfig;

beforeEach(() => {
  configs.clear();
  sent.length = 0;
  configs.set(orchestratorProject, [agent('durable_orch')]);
  configs.set(helperProject, [agent('durable_far', { parentAgentId: 'durable_orch', parentProjectPath: orchestratorProject })]);
});
afterEach(() => {
  vi.clearAllMocks();
  _resetDisposeRequestsForTesting();
});

describe('a helper in another project', () => {
  it('reports the decision on a request recorded with the helper\'s project to the orchestrator', async () => {
    recordDisposeRequest(helperProject, 'durable_far', 'durable_orch', {
      projectPath: helperProject, orchestratorId: 'durable_orch', helperId: 'durable_far', helperName: 'far', checks: clean, forceRequested: false,
    });
    expect(await reportDisposeDecision(helperProject, 'durable_far', 'declined')).toEqual({ ok: true, delivered: true, message: 'Reported' });
    expect(sent).toEqual(['[Clubhouse] The user declined your request to dispose of far. Nothing was changed.']);
    // Answered once.
    expect((await reportDisposeDecision(helperProject, 'durable_far', 'declined')).ok).toBe(false);
  });

  it('disposes it in its own project, checked against its orchestrator', async () => {
    const result = await disposeHelperForUser(helperProject, 'durable_far', { force: false });
    expect(result).toEqual({ ok: true, message: 'Disposed' });
    expect(agentConfig.getDisposeChecks).toHaveBeenCalledWith(helperProject, 'durable_far');
    expect(agentConfig.disposeHelper).toHaveBeenCalledWith(helperProject, 'durable_far', { force: false, expectedParentId: 'durable_orch' });
  });
});
