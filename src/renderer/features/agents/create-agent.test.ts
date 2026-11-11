import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDurableAgent } from './create-agent';
import { useAgentStore } from '../../stores/agentStore';
import * as path from 'path';
import { createManagedDurableAgent } from '../managed/create-managed-agent';

const input = { name: 'plain-otter', color: 'emerald', model: 'default', useWorktree: false, orchestrator: 'claude-code' };
const project = { id: 'p1', path: '/tmp/ch' };

describe('createDurableAgent with Clubhouse features off (#2893)', () => {
  let order: string[];
  beforeEach(() => {
    vi.restoreAllMocks();
    order = [];
    vi.spyOn(window.clubhouse.agent, 'createDurable').mockImplementation(async () => { order.push('create'); return { id: 'a-new', name: 'plain-otter', color: 'emerald' } as never; });
    useAgentStore.setState({ spawnDurableAgent: vi.fn(async () => { order.push('spawn'); return 'a-new'; }) } as never);
  });

  it('turns them off before the first session starts', async () => {
    const off = vi.spyOn(window.clubhouse.managed, 'setClubhouseFeatures').mockImplementation(async () => { order.push('features'); return { ok: true, value: undefined }; });
    await expect(createDurableAgent(project, { ...input, clubhouseFeatures: false })).resolves.toBe('a-new');
    expect(off).toHaveBeenCalledWith('/tmp/ch', 'a-new', false);
    expect(order).toEqual(['create', 'features', 'spawn']);
  });

  it('leaves them alone by default', async () => {
    const off = vi.spyOn(window.clubhouse.managed, 'setClubhouseFeatures');
    await createDurableAgent(project, input);
    expect(off).not.toHaveBeenCalled();
    expect(order).toEqual(['create', 'spawn']);
  });

  it('does not start the agent with them on when turning them off fails', async () => {
    vi.spyOn(window.clubhouse.managed, 'setClubhouseFeatures').mockResolvedValue({ ok: false, code: 'failed', message: 'nope' });
    const onError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const del = vi.spyOn(window.clubhouse.agent, 'deleteDurable').mockImplementation(async () => { order.push('delete'); });
    await expect(createDurableAgent(project, { ...input, clubhouseFeatures: false }, { onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith('nope');
    // The half-made agent is removed before the error shows.
    expect(del).toHaveBeenCalledWith('/tmp/ch', 'a-new');
    expect(order).toEqual(['create', 'delete']);
  });

  it('still reports the first error when removing the half-made agent fails too', async () => {
    vi.spyOn(window.clubhouse.managed, 'setClubhouseFeatures').mockResolvedValue({ ok: false, code: 'failed', message: 'nope' });
    vi.spyOn(window.clubhouse.agent, 'deleteDurable').mockRejectedValue(new Error('busy'));
    const onError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createDurableAgent(project, { ...input, clubhouseFeatures: false }, { onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith('nope');
    expect(order).toEqual(['create']);
  });

  it('reports the existing agent id separately when its first start fails', async () => {
    useAgentStore.setState({ spawnDurableAgent: vi.fn().mockRejectedValue(new Error('Login expired.')) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const remove = vi.spyOn(window.clubhouse.agent, 'deleteDurable');
    const onError = vi.fn();
    await expect(createDurableAgent(project, input, { onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith('Login expired.', 'a-new');
    expect(remove).not.toHaveBeenCalled();
  });

  it('sends the plain worktree creation request id so membership sync can replace its row', async () => {
    const create = vi.mocked(window.clubhouse.agent.createDurable);
    create.mockImplementation(async (...args) => {
      const requestId = args[10]?.creationRequestId;
      expect(requestId).toMatch(/^creating_/);
      expect(useAgentStore.getState().agents[requestId!]).toMatchObject({ orchestrator: input.orchestrator, status: 'creating' });
      return { id: 'a-new', name: input.name, color: input.color, createdAt: '2026-11-10T00:00:00Z' };
    });
    await createDurableAgent({ id: project.id, path: path.resolve('project') }, { ...input, useWorktree: true });
    expect(create.mock.lastCall?.[10]).toEqual({ creationRequestId: expect.stringMatching(/^creating_/) });
  });
});

describe('createDurableAgent and the retired Clubhouse Mode (#2901)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window.clubhouse.agent, 'createDurable').mockResolvedValue({ id: 'a-new', name: 'plain-otter', color: 'emerald' } as never);
    vi.spyOn(window.clubhouse.agent, 'updateDurableConfig').mockResolvedValue(undefined as never);
    useAgentStore.setState({ spawnDurableAgent: vi.fn(async () => 'a-new') } as never);
  });

  it('writes nothing about Clubhouse Mode: main marks a new agent so the switch never takes it for a Clubhouse Mode one', async () => {
    await expect(createDurableAgent(project, input)).resolves.toBe('a-new');
    expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
  });
});

describe('managed creation results', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAgentStore.setState({ agents: {}, activeAgentId: null, projectActiveAgent: {} });
  });

  it.each([false, true])('returns the created id separately from a first-start failure (%s)', async (startFails) => {
    const config = { id: 'managed-new', name: input.name, color: input.color, createdAt: '2026-11-10T00:00:00Z' };
    vi.spyOn(window.clubhouse.managed, 'createAgent').mockResolvedValue({ ok: true, value: config });
    const error = new Error('Login expired.');
    const spawn = vi.fn().mockImplementation(async () => { if (startFails) throw error; return config.id; });
    useAgentStore.setState({ spawnDurableAgent: spawn });
    await expect(createManagedDurableAgent(project, input)).resolves.toEqual(
      startFails ? { status: 'start_failed', agentId: config.id, error } : { status: 'started', agentId: config.id },
    );
    expect(window.clubhouse.managed.createAgent).toHaveBeenCalledWith(project.path, expect.objectContaining({ creationRequestId: expect.stringMatching(/^creating_/) }));
    expect(Object.keys(useAgentStore.getState().agents)).toEqual([]);
  });

  it('rejects a creation failure without attempting the first start', async () => {
    vi.spyOn(window.clubhouse.managed, 'createAgent').mockResolvedValue({ ok: false, code: 'failed', message: 'Disk full.' });
    const spawn = vi.fn();
    useAgentStore.setState({ spawnDurableAgent: spawn });
    await expect(createManagedDurableAgent(project, input)).rejects.toThrow('Disk full.');
    expect(spawn).not.toHaveBeenCalled();
    expect(Object.keys(useAgentStore.getState().agents)).toEqual([]);
  });
});
