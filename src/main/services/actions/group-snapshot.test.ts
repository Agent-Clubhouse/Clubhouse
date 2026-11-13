import { expect, it } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import { groupActionSummaries } from './group-snapshot';

it('shares only read-only summaries of network groups hosted here', () => {
  const project = (id: string, reach: 'local' | 'network'): GroupProject => ({
    id, name: id, description: '', instructions: '', createdAt: '', metadata: {}, scope: { level: 'app', reach },
  });
  const action = (id: string, groupProjectId: string) => ({ id, name: id, enabled: true, owner: { kind: 'group_project' as const, groupProjectId } });
  const groups = [project('hosted', 'network'), project('local', 'local'), project('remote', 'network')];
  const actions = [action('shared', 'hosted'), action('private', 'local'), action('foreign', 'remote'), { id: 'personal', name: 'personal', enabled: true, owner: { kind: 'user' as const } }];
  expect(groupActionSummaries(groups, actions, (group) => group.id !== 'remote')).toEqual([
    { id: 'shared', name: 'shared', enabled: true, groupProjectId: 'hosted', groupProjectName: 'hosted' },
  ]);
});
