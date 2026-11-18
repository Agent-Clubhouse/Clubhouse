import { test, expect } from './reverse-desktops';
import type { GroupProject } from '../../src/shared/group-project-types';

test.setTimeout(300_000);

test('both host orientations carry host notices, replica pulls, board reads and replica writes over one forward', async ({ reverse }) => {
  for (const [replica, host] of reverse.directions) {
    const group = await host.app.window.evaluate(async (agentId) => {
      const group = await window.clubhouse.groupProject.create('Reverse hosted board', { scope: { level: 'app', reach: 'network' } }) as GroupProject;
      await window.clubhouse.groupProject.addMember(group.id, agentId);
      return group;
    }, host.agentId);
    await expect.poll(async () => replica.app.window.evaluate((id) => window.clubhouse.groupProject.get(id), group.id), { timeout: 30_000 }).toMatchObject({ id: group.id });
    const message = `host notice from ${host.agentId}`;
    await host.app.window.evaluate(({ id, message }) => window.clubhouse.groupProject.postBulletinMessage(id, 'general', message), { id: group.id, message });
    await expect.poll(async () => replica.app.window.evaluate((id) => window.clubhouse.groupProject.getAllMessages(id), group.id), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ body: message })]));
    await replica.app.window.evaluate(({ id, description }) => window.clubhouse.groupProject.update(id, { description }), {
      id: group.id, description: `replica update from ${replica.agentId}`,
    });
    await expect.poll(async () => host.app.window.evaluate((id) => window.clubhouse.groupProject.get(id), group.id))
      .toMatchObject({ description: `replica update from ${replica.agentId}` });
    const board = await replica.app.window.evaluate(({ machine, id }) => window.clubhouse.annexClient.gpBulletinTopic(machine, id, 'general'), {
      machine: host.fingerprint, id: group.id,
    });
    expect(board).toEqual(expect.arrayContaining([expect.objectContaining({ body: message })]));
    const roster = await replica.app.window.evaluate((id) => window.clubhouse.groupProject.getRoster(id), group.id);
    expect(roster).toMatchObject({ status: 'available', complete: true });
  }
});
