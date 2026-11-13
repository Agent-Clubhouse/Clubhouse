import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, Project } from '../../shared/types';

const fixtures = vi.hoisted(() => ({
  projects: [
    { id: 'one', name: 'Same name', path: '/projects/one' },
    { id: 'two', name: 'Same name', path: '/projects/two' },
  ] as Project[],
  agents: new Map<string, DurableAgentConfig[]>(),
  unreadable: new Set<string>(),
}));
vi.mock('./project-store', () => ({
  peekProjectsChecked: vi.fn(async () => ({ projects: fixtures.projects, readable: true })),
}));
vi.mock('./agent-config', () => ({
  peekDurableConfigsChecked: vi.fn(async (projectPath: string) => ({
    agents: fixtures.agents.get(projectPath) ?? [], readable: !fixtures.unreadable.has(projectPath),
  })),
}));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: vi.fn() } }));
vi.mock('./group-project-registry', () => ({ groupProjectRegistry: { peek: vi.fn() } }));
vi.mock('./canvas-store-reader', () => ({
  getTargetCanvasIndex: vi.fn(async () => ({ stores: [] })),
  readCanvasForNavigation: vi.fn(),
}));

import { groupProjectRegistry } from './group-project-registry';
import { getTargetCanvasIndex, readCanvasForNavigation } from './canvas-store-reader';
import { resolveAgentNavigationTarget, resolveTargetCanvasIndex, readTargetCanvasForNavigation } from './connection-target-navigation';

const config = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id, name: 'Renamed target', color: 'teal', createdAt: '2026-11-12', ...extra,
});
const gp = { id: 'gp_actual', name: 'Renamed project', description: '', instructions: '', createdAt: '2026-11-12', metadata: {} };

beforeEach(() => {
  fixtures.agents.clear();
  fixtures.unreadable.clear();
  fixtures.agents.set('/projects/one', [config('same-name-wrong-id')]);
  fixtures.agents.set('/projects/two', [config('actual')]);
  vi.mocked(groupProjectRegistry.peek).mockResolvedValue([gp]);
});

describe('read-only connection target resolution', () => {
  it('resolves actual IDs across projects despite identical/renamed labels, and refuses duplicate, deleted or partial identities', async () => {
    expect(await resolveAgentNavigationTarget('actual')).toEqual({ project: fixtures.projects[1], config: config('actual') });
    expect(await resolveAgentNavigationTarget('Renamed target')).toEqual({ error: expect.stringMatching(/unavailable.*retry Open/) });
    fixtures.agents.set('/projects/one', [config('actual')]);
    expect(await resolveAgentNavigationTarget('actual')).toEqual({ error: expect.stringMatching(/more than one project/) });
    fixtures.agents.set('/projects/one', []);
    fixtures.agents.set('/projects/two', [config('actual', { disposedAt: 'today' })]);
    expect(await resolveAgentNavigationTarget('actual')).toEqual({ error: expect.stringMatching(/unavailable/) });
    fixtures.unreadable.add('/projects/one');
    expect(await resolveAgentNavigationTarget('actual')).toEqual({ error: expect.stringMatching(/could not be read/) });
  });

  it('uses the read-only canonical GP ID, not its label, and rechecks deletion after the disk load', async () => {
    expect(await resolveTargetCanvasIndex('group-project', 'gp_actual')).toEqual({ stores: [], groupProjects: [gp] });
    expect(getTargetCanvasIndex).toHaveBeenCalledWith('group-project', 'gp_actual');
    expect(await resolveTargetCanvasIndex('group-project', 'Renamed project')).toEqual({
      stores: [], error: expect.stringMatching(/no longer exists/),
    });
    vi.mocked(readCanvasForNavigation).mockImplementation(async () => {
      vi.mocked(groupProjectRegistry.peek).mockResolvedValue([]);
      return { canvases: [], wires: [], zoneWires: [] };
    });
    await expect(readTargetCanvasForNavigation('group-project', 'gp_actual', 'two')).rejects.toThrow(/deleted before the Canvas opened/);
  });
});
