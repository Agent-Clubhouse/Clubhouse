import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';

let app: LaunchedApp | undefined;
test.afterEach(async () => { await app?.electronApp.close().catch(() => {}); app?.profile.dispose(); app = undefined; });

test('a group project runs its schedule and a coalesced board trigger on its host', async () => {
  test.setTimeout(120_000);
  app = await launchApp({ label: 'group-project-actions' });
  const w = app.window;
  const group = await w.evaluate(() => window.clubhouse.groupProject.create('Release')) as { id: string };
  await expect.poll(() => w.evaluate(() => window.clubhouse.actions.list().then(() => true).catch(() => false))).toBe(true);
  await w.evaluate(async (id) => {
    await window.clubhouse.actions.create({ name: 'Scheduled board post', trigger: { kind: 'schedule', preset: 'cron', cron: '* * * * *', missed: 'skip' }, steps: [{ kind: 'group_post', topic: 'schedule', text: 'Scheduled' }] }, id);
    await window.clubhouse.actions.create({ name: 'Group board posts', trigger: { kind: 'event', event: 'group_project.message_posted', source: { kind: 'group_project', groupProjectId: id, topic: 'updates' }, coalesceSeconds: 10 }, steps: [{ kind: 'group_post', topic: 'summary', text: 'Received updates' }] }, id);
    await window.clubhouse.groupProject.postBulletinMessage(id, 'updates', 'First');
    await window.clubhouse.groupProject.postBulletinMessage(id, 'updates', 'Second');
  }, group.id);
  await expect.poll(() => w.evaluate((id) => window.clubhouse.groupProject.getTopicMessages(id, 'summary').then((messages) => messages.length), group.id), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => w.evaluate((id) => window.clubhouse.groupProject.getTopicMessages(id, 'schedule').then((messages) => messages.length), group.id), { timeout: 75_000 }).toBeGreaterThan(0);
  const owned = await w.evaluate((id) => window.clubhouse.actions.list().then((actions) => actions.filter((a) => a.owner.kind === 'group_project' && a.owner.groupProjectId === id).length), group.id);
  expect(owned).toBe(2);
});
