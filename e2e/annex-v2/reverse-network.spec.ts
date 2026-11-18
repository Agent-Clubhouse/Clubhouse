import { test, expect } from './reverse-desktops';
import type { GroupProject } from '../../src/shared/group-project-types';

test.setTimeout(300_000);

test('both host orientations carry host notices, replica writes and host-approved creates over one forward', async ({ reverse }) => {
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

    await host.app.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(true));
    const name = `Host-approved create from ${replica.agentId}`;
    const ask = (retryOf?: string) => replica.app.window.evaluate(({ machine, name, retryOf }) =>
      window.clubhouse.groupProject.createOnHost(machine, name, { scope: { level: 'app', reach: 'network' } }, retryOf),
    { machine: host.fingerprint, name, retryOf });
    const waiting = await ask();
    expect(waiting.status).toBe('waiting');
    const requests = () => host.app.window.evaluate(async (name) =>
      (await window.clubhouse.agent.listGrantRequests()).filter((request) => request.remoteCreateReview?.name === name), name);
    await expect.poll(requests, { timeout: 15_000 }).toHaveLength(1);
    const countNamed = (desk: typeof host) => desk.app.window.evaluate(async (name) => {
      const groups = await window.clubhouse.groupProject.list() as GroupProject[];
      return groups.filter((group) => group.name === name).length;
    }, name);
    for (const desk of [replica, host]) expect(await countNamed(desk)).toBe(0);
    expect((await ask(waiting.requestId)).status).toBe('waiting');
    expect(await requests()).toHaveLength(1);
    const [request] = await requests();
    const dispatcher = await host.app.window.evaluate(() => window.clubhouse.dispatcher.get());
    expect(request.agentId).toBe(dispatcher.agentId);
    expect(await host.app.window.evaluate((id) => window.clubhouse.agent.answerGrantRequest(id, true), request.requestId)).toMatchObject({ ok: true });
    let created: Awaited<ReturnType<typeof ask>> | undefined;
    await expect.poll(async () => { created = await ask(waiting.requestId); return created.status; }, { timeout: 60_000 }).toBe('created');
    if (created?.status !== 'created') throw new Error('The host did not create the approved group project');
    expect(await ask(waiting.requestId)).toMatchObject({ status: 'created', groupProjectId: created.groupProjectId });
    for (const desk of [replica, host]) await expect.poll(() => countNamed(desk)).toBe(1);
  }
});
