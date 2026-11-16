/**
 * #3552: several groups in different scopes, in one app. An app-wide group and a
 * group for each of two projects; the project view of the hub; grants for one
 * member; and deleting one group while the others stay. Fake CLIs only. No agent
 * runs, so no prompt is sent: membership and grants are records.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchApp, type LaunchedApp } from './launch';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { addProject, selectProject } from './smoke-helpers';

let app: LaunchedApp | undefined;
let profile: DisposableProfile | undefined;
let fakes: FakeClis | undefined;
const dirs: string[] = [];

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function makeProject(prefix: string, agents: Array<{ id: string; name: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify(agents.map((a) => ({ ...a, color: 'indigo', createdAt: now }))));
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${prefix}\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

async function createGroup(page: Page, name: string, covers?: string) {
  await page.getByRole('button', { name: 'New group project', exact: true }).click();
  await page.getByLabel('New group project name').fill(name);
  if (covers) await page.getByLabel('Covers').selectOption({ label: covers });
  await page.getByRole('button', { name: 'Create group project' }).click();
  // Creating opens the new group on its Board.
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByTestId('group-project-section-board')).toBeVisible();
}

const back = (page: Page) => page.getByRole('button', { name: /^Back to / });
const row = (page: Page, name: string) => page.getByTestId('group-projects-hub').getByRole('button', { name, exact: true });

test('groups in app and two project scopes list apart, narrow to a project, keep their own grants, and delete one at a time', async () => {
  fakes = await installFakeClis({});
  const dirA = makeProject('gp-scope-a-', [{ id: 'durable_gps_alpha', name: 'alpha' }, { id: 'durable_gps_beta', name: 'beta' }]);
  const dirB = makeProject('gp-scope-b-', [{ id: 'durable_gps_gamma', name: 'gamma' }]);
  const nameA = path.basename(dirA);
  const nameB = path.basename(dirB);
  profile = createDisposableProfile({ label: 'gp-scopes' });
  app = await launchApp({ profile, env: fakes.env });
  const { window: page, electronApp } = app;
  await addProject(electronApp, page, dirA);
  await addProject(electronApp, page, dirB);

  await page.getByTestId('app-row-group-projects').click();
  await expect(page.getByTestId('group-projects-hub')).toBeVisible();

  // One app-wide group (starts with no members) and one group for each project.
  await createGroup(page, 'Everyone');
  await back(page).click();
  await createGroup(page, 'Team A', nameA);
  await back(page).click();
  await createGroup(page, 'Team B', nameB);
  await back(page).click();

  const hub = page.getByTestId('group-projects-hub');
  await expect(hub.getByRole('region', { name: nameA }).getByRole('button', { name: 'Team A', exact: true })).toBeVisible();
  await expect(hub.getByRole('region', { name: nameB }).getByRole('button', { name: 'Team B', exact: true })).toBeVisible();
  await expect(hub.getByRole('region', { name: 'App-wide' }).getByRole('button', { name: 'Everyone', exact: true })).toBeVisible();

  // Grants: a project group starts with its project's agents, and lead and admin are per member.
  await row(page, 'Team A').click();
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  const alphaLead = page.getByLabel('Lead for alpha');
  const alphaAdmin = page.getByLabel('Admin for alpha');
  const betaLead = page.getByLabel('Lead for beta');
  await expect(alphaLead).toHaveValue('off');
  await expect(alphaAdmin).toHaveValue('off');
  await alphaLead.selectOption('allow');
  await expect(alphaLead).toHaveValue('allow');
  await expect(alphaAdmin).toHaveValue('off');
  await expect(betaLead).toHaveValue('off');
  // Team A holds only its own project's agents.
  await expect(page.getByLabel('Lead for gamma')).toHaveCount(0);
  await back(page).click();

  // The project view: that project's groups and the app-wide ones, with an escape to every group.
  await selectProject(page, nameA);
  await page.getByTestId('start-page-group-projects').click();
  await expect(page.getByRole('heading', { name: `${nameA} and app-wide`, level: 2 })).toBeVisible();
  await expect(row(page, 'Team A')).toBeVisible();
  await expect(row(page, 'Everyone')).toBeVisible();
  await expect(row(page, 'Team B')).toHaveCount(0);
  await page.getByRole('button', { name: 'All groups', exact: true }).click();
  await expect(row(page, 'Team B')).toBeVisible();
  await expect(row(page, 'Team A')).toBeVisible();

  // Delete one group. It is in the command palette until it is deleted.
  const paletteOption = (name: string) => page.locator('[data-testid="command-palette-overlay"] [role="option"]').filter({ hasText: name });
  const searchPalette = async (query: string) => {
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette-overlay')).toBeVisible();
    await page.locator('[data-testid="command-palette-overlay"] input').fill(query);
  };
  await searchPalette('Team B');
  await expect(paletteOption('Team B').first()).toBeVisible();
  await page.keyboard.press('Escape');
  const idB = await page.evaluate(async () => ((await window.clubhouse.groupProject.list()) as Array<{ id: string; name: string }>).find((g) => g.name === 'Team B')!.id);

  await row(page, 'Team B').click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Delete group project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Team B?' });
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog).not.toBeVisible();

  // Nothing of it is left open: no Board or section, no row, no palette entry, no record. The others stay.
  await expect(page.getByTestId('group-project-section-details')).toHaveCount(0);
  await expect(page.getByTestId('group-project-section-board')).toHaveCount(0);
  await back(page).click();
  await expect(row(page, 'Team B')).toHaveCount(0);
  await expect(row(page, 'Team A')).toBeVisible();
  await expect(row(page, 'Everyone')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search group projects' }).fill('Team B');
  // Search words match a project's name too, so another group may match; the deleted one never does.
  await expect(row(page, 'Team B')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await searchPalette('Team B');
  await expect(paletteOption('Team B')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const listed = async () => page.evaluate(async () => ((await window.clubhouse.groupProject.list()) as Array<{ id: string; name: string }>).map((g) => g.id));
  expect(await listed()).not.toContain(idB);
  await row(page, 'Team A').click();
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(page.getByLabel('Lead for alpha')).toHaveValue('allow');

  // After a restart it is still gone, and the grant is still there.
  await app.electronApp.close();
  app = await launchApp({ profile, env: fakes.env });
  await app.window.getByTestId('app-row-group-projects').click();
  await expect(row(app.window, 'Team A')).toBeVisible();
  await expect(row(app.window, 'Everyone')).toBeVisible();
  await expect(row(app.window, 'Team B')).toHaveCount(0);
  expect(await app.window.evaluate(async () => ((await window.clubhouse.groupProject.list()) as Array<{ id: string }>).length)).toBe(2);
  await row(app.window, 'Team A').click();
  await app.window.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(app.window.getByLabel('Lead for alpha')).toHaveValue('allow');
});
