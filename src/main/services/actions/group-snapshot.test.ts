import { expect, it } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import type { Action } from '../../../shared/actions';
import { groupActionSummaries } from './group-snapshot';

it('shares only read-only summaries of network groups hosted here', () => {
  const project = (id: string, reach: 'local' | 'network'): GroupProject => ({
    id, name: id, description: '', instructions: '', createdAt: '', metadata: {}, scope: { level: 'app', reach },
  });
  const action = (id: string, groupProjectId: string): Action => ({ id, name: id, enabled: true, owner: { kind: 'group_project', groupProjectId }, trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' }, steps: [{ kind: 'group_post', topic: 'general', text: 'Private text' }], overlap: 'skip', createdAt: 1, updatedAt: 1 });
  const groups = [project('hosted', 'network'), project('local', 'local'), project('remote', 'network')];
  const actions: Action[] = [action('shared', 'hosted'), action('private', 'local'), action('foreign', 'remote'), { ...action('personal', 'hosted'), owner: { kind: 'user' } }];
  expect(groupActionSummaries(groups, actions, (group) => group.id !== 'remote')).toEqual([
    { id: 'shared', name: 'shared', enabled: true, groupProjectId: 'hosted', groupProjectName: 'hosted', description: 'Every day at 9:00 AM → Post to general' },
  ]);
});
