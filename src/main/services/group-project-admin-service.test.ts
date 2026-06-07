import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrapGroupProjectAdmin } from './group-project-admin-service';
import { groupProjectRegistry } from './group-project-registry';
import { getProjectAdmins } from '../../shared/group-project-admin';

describe('bootstrapGroupProjectAdmin', () => {
  beforeEach(() => {
    groupProjectRegistry._resetForTesting();
  });

  it('makes the first joining agent the project admin', async () => {
    groupProjectRegistry._setForTesting({
      id: 'gp_1', name: 'P', description: '', instructions: '',
      createdAt: '2020-01-01T00:00:00Z', metadata: {},
    });
    await bootstrapGroupProjectAdmin('gp_1', 'agent-first');
    expect(getProjectAdmins(groupProjectRegistry.getSync('gp_1')?.metadata)).toEqual(['agent-first']);
  });

  it('is a no-op when an admin already exists', async () => {
    groupProjectRegistry._setForTesting({
      id: 'gp_1', name: 'P', description: '', instructions: '',
      createdAt: '2020-01-01T00:00:00Z', metadata: { admins: ['existing-lead'] },
    });
    await bootstrapGroupProjectAdmin('gp_1', 'agent-second');
    expect(getProjectAdmins(groupProjectRegistry.getSync('gp_1')?.metadata)).toEqual(['existing-lead']);
  });

  it('does nothing for an unknown project', async () => {
    await expect(bootstrapGroupProjectAdmin('gp_missing', 'agent')).resolves.toBeUndefined();
  });
});
