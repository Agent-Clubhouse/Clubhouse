/**
 * #3357: group project membership is a record, not canvas wires.
 *
 * A new group project in a project's scope gets every top-level durable agent
 * as a member with no wires drawn; a helper joins only when added; an
 * excluded agent stays out; and after a restart the bindings are exactly the
 * record's members. No agent is started, so no CLI runs and no tokens are
 * spent: bindings exist for sleeping agents too.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchApp, type LaunchedApp } from './launch';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { addProject, clickExplorerTab } from './smoke-helpers';

const LEAD = 'durable_gpm_lead';
const DEV = 'durable_gpm_dev';
const HELPER = 'durable_gpm_helper';

let app: LaunchedApp | undefined;
let profile: DisposableProfile | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  projectDir = undefined;
});

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-membership-e2e-'));
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: LEAD, name: 'lead', color: 'emerald', createdAt: now },
    { id: DEV, name: 'dev', color: 'indigo', createdAt: now },
    { id: HELPER, name: 'helper', color: 'amber', createdAt: now, parentAgentId: LEAD },
  ]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# group project membership e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

async function members(window: Page, gpId: string): Promise<string[]> {
  const bindings = await window.evaluate(() => window.clubhouse.mcpBinding.getBindings()) as Array<{ agentId: string; targetId: string }>;
  return bindings.filter((b) => b.targetId === gpId).map((b) => b.agentId).sort();
}

test('auto-join, an added helper and an exclusion survive a restart', async () => {
  projectDir = makeProject();
  profile = createDisposableProfile({ label: 'gp-membership' });
  app = await launchApp({ profile });
  await addProject(app.electronApp, app.window, projectDir);

  const projectId = await app.window.evaluate(async (dir) => {
    const projects = await window.clubhouse.project.list() as Array<{ id: string; path: string }>;
    return projects.find((p) => p.path.endsWith(dir.split(/[\\/]/).pop()!))!.id;
  }, projectDir);
  const gp = await app.window.evaluate((id) => window.clubhouse.groupProject.create('Release', { projectId: id }), projectId) as { id: string };

  // Every top-level durable agent in scope, with no wires: not the helper.
  await expect.poll(() => members(app!.window, gp.id), { timeout: 15_000 }).toEqual([DEV, LEAD]);

  // A helper joins only when added; an excluded agent leaves.
  await app.window.evaluate(({ id, agent }) => window.clubhouse.groupProject.addMember(id, agent), { id: gp.id, agent: HELPER });
  await app.window.evaluate(({ id, agent }) => window.clubhouse.groupProject.excludeMember(id, agent), { id: gp.id, agent: DEV });
  await expect.poll(() => members(app!.window, gp.id), { timeout: 15_000 }).toEqual([HELPER, LEAD]);

  // After a restart the bindings are the record's members, and the exclusion holds.
  await app.electronApp.close();
  app = await launchApp({ profile });
  await expect.poll(() => members(app!.window, gp.id), { timeout: 20_000 }).toEqual([HELPER, LEAD]);
  const view = await app.window.evaluate((id) => window.clubhouse.groupProject.listMembers(id), gp.id);
  expect(view.excluded.map((e) => e.agentId)).toEqual([DEV]);
  expect(view.autoJoin).toBe(true);
});

test('removing a group project card keeps its members and board on another canvas', async () => {
  projectDir = makeProject();
  profile = createDisposableProfile({ label: 'gp-multiple-canvases' });
  app = await launchApp({ profile });
  const { electronApp, window } = app;
  await addProject(electronApp, window, projectDir);
  const projectId = await window.evaluate(async (dir) => {
    const projects = await window.clubhouse.project.list() as Array<{ id: string; path: string }>;
    return projects.find((p) => p.path.endsWith(dir.split(/[\\/]/).pop()!))!.id;
  }, projectDir);
  const gp = await window.evaluate((id) => window.clubhouse.groupProject.create('Shared release', { projectId: id }), projectId) as { id: string };
  await window.evaluate((id) => window.clubhouse.groupProject.postBulletinMessage(id, 'notes', 'Board survives'), gp.id);
  await expect.poll(() => members(window, gp.id), { timeout: 15_000 }).toEqual([DEV, LEAD]);

  await clickExplorerTab(electronApp, window, 'explorer-tab-plugin:canvas');
  const workspace = window.getByTestId('canvas-workspace');
  await expect(workspace).toBeVisible();
  const tabs = window.getByRole('tablist', { name: 'Canvases' }).getByRole('tab');
  const firstId = await tabs.first().getAttribute('data-testid');
  expect(firstId).toBeTruthy();
  const attach = async () => {
    await workspace.click({ button: 'right', position: { x: 220, y: 180 } });
    await window.getByTestId('canvas-context-menu-plugin:group-project:group-project').click();
    const card = workspace.locator('[data-testid^="canvas-view-cv_"]').first();
    await card.getByLabel('Existing group project').selectOption({ label: 'Shared release' });
    await card.getByRole('button', { name: 'Add existing' }).click();
    await expect(card.getByTestId('group-project-member-count')).toHaveText('2 agents');
    return card;
  };
  await attach();
  await window.getByTestId('canvas-add-button').click();
  await window.getByTestId('canvas-add-new').click();
  await expect(tabs).toHaveCount(2);
  const secondCard = await attach();
  await secondCard.getByRole('button', { name: 'Remove from this canvas' }).click();
  await expect(workspace.locator('[data-testid^="canvas-view-cv_"]')).toHaveCount(0);
  await expect.poll(() => members(window, gp.id)).toEqual([DEV, LEAD]);
  const saved = await window.evaluate(async (id) => ({
    project: await window.clubhouse.groupProject.get(id),
    membership: await window.clubhouse.groupProject.listMembers(id),
    board: await window.clubhouse.groupProject.getTopicMessages(id, 'notes'),
  }), gp.id);
  expect(saved.project).toBeTruthy();
  expect(saved.membership.members.map((member) => member.agentId).sort()).toEqual([DEV, LEAD]);
  expect(JSON.stringify(saved.board)).toContain('Board survives');
  await window.getByTestId(firstId!).click();
  await expect(workspace.getByTestId('group-project-member-count')).toHaveText('2 agents');
});
