import { describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ get: vi.fn(), resolveMembers: vi.fn(), getMembership: vi.fn(), digest: vi.fn() }));
const readCanvas = vi.hoisted(() => vi.fn());
const checkGuidance = vi.hoisted(() => vi.fn());
vi.mock('./group-project-host', () => ({ groupProjectHost: host }));
vi.mock('./group-project-canvas-inventory', () => ({ readGroupProjectCanvasInventory: readCanvas }));
vi.mock('./connection-guidance', () => ({ assertGroupProjectGuidanceDeletable: checkGuidance }));
// Lead and admin are grants on the group project (#3360): the impact lists their holders.
vi.mock('./group-project-roles', () => ({ listGroupProjectRoles: () => [{ agentId: 'lead', lead: 'allow', admin: 'ask' }] }));
import { readGroupProjectDeletionInventory } from './group-project-delete-inventory';

describe('group project deletion inventory', () => {
  it('collects member names, canvases, board counts, grants and machine addresses', async () => {
    host.get.mockResolvedValue({ id: 'gp', seq: 4, metadata: { admins: ['retired-role'] } });
    host.resolveMembers.mockResolvedValue([{ address: 'ada@machine', name: 'Ada' }, { address: 'bob', name: 'Bob' }]);
    host.getMembership.mockResolvedValue({ version: 1, explicit: [], excluded: [{ address: 'excluded' }] });
    host.digest.mockResolvedValue([{ messageCount: 2 }, { messageCount: 3 }]);
    readCanvas.mockResolvedValue({ canvases: ['Home / One', 'Work / Two'], revision: 'canvas-revision' });
    expect(await readGroupProjectDeletionInventory('gp')).toMatchObject({
      members: ['Ada (ada@machine)', 'Bob (bob)'], canvases: ['Home / One', 'Work / Two'],
      exclusions: ['excluded'], grants: ['lead: admin (ask)', 'lead: lead (allow)'], messages: 5, topics: 2, machines: ['machine'],
      revisions: expect.arrayContaining(['4', 'canvas-revision']),
    });
  });

  it('refuses a missing or non-host record', async () => {
    host.get.mockResolvedValue(null);
    await expect(readGroupProjectDeletionInventory('missing')).rejects.toThrow('unavailable');
  });

  it('refuses an impact check when saved guidance cannot be safely read', async () => {
    checkGuidance.mockImplementationOnce(() => { throw new Error('Saved connection guidance could not be read.'); });
    await expect(readGroupProjectDeletionInventory('gp')).rejects.toThrow('Saved connection guidance');
  });
});
