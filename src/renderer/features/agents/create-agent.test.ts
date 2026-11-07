import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDurableAgent } from './create-agent';
import { useAgentStore } from '../../stores/agentStore';

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
});

describe('createDurableAgent in a Clubhouse Mode project (#2901)', () => {
  let order: string[];
  beforeEach(() => {
    vi.restoreAllMocks();
    order = [];
    vi.spyOn(window.clubhouse.agent, 'createDurable').mockImplementation(async () => { order.push('create'); return { id: 'a-new', name: 'plain-otter', color: 'emerald' } as never; });
    vi.spyOn(window.clubhouse.agent, 'updateDurableConfig').mockImplementation(async () => { order.push('override'); });
    vi.spyOn(window.clubhouse.app, 'getClubhouseModeSettings').mockResolvedValue({ enabled: false, projectOverrides: { '/tmp/ch': true } } as never);
    useAgentStore.setState({ spawnDurableAgent: vi.fn(async () => { order.push('spawn'); return 'a-new'; }) } as never);
  });

  it('turns Clubhouse Mode off for the plain agent before its first start', async () => {
    await expect(createDurableAgent(project, input)).resolves.toBe('a-new');
    expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/tmp/ch', 'a-new', { clubhouseModeOverride: true });
    expect(order).toEqual(['create', 'override', 'spawn']);
  });

  it('leaves it alone in a project without Clubhouse Mode', async () => {
    await createDurableAgent({ id: 'p2', path: '/tmp/other' }, input);
    expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    expect(order).toEqual(['create', 'spawn']);
  });

  it('removes the agent unstarted when the override can\'t be saved', async () => {
    vi.mocked(window.clubhouse.agent.updateDurableConfig).mockRejectedValue(new Error('disk full'));
    const del = vi.spyOn(window.clubhouse.agent, 'deleteDurable').mockImplementation(async () => { order.push('delete'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    await expect(createDurableAgent(project, input, { onError })).resolves.toBeNull();
    expect(del).toHaveBeenCalledWith('/tmp/ch', 'a-new');
    expect(onError).toHaveBeenCalledWith("Couldn't turn Clubhouse Mode off for it: disk full");
    expect(order).toEqual(['create', 'delete']);
  });
});
