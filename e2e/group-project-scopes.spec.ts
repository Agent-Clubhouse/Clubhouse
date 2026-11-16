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

async function createGroup(window: Page, name: string, covers?: string) {
  await window.getByRole('button', { name: 'New group project', exact: true }).click();
  await window.getByLabel('New group project name').fill(name);
  if (covers) await window.getByLabel('Covers').selectOption({ label: covers });
  await window.getByRole('button', { name: 'Create group project' }).click();
  // Creating opens the new group on its Board.
  await expect(window.getByRole('heading', { name })).toBeVisible();
  await expect(window.getByTestId('group-project-section-board')).toBeVisible();
}

const back = (window: Page) => window.getByRole('button', { name: /^Back to / });
const row = (window: Page, name: string) => window.getByTestId('group-projects-hub').getByRole('button', { name, exact: true });

test('groups in app and two project scopes list apart, narrow to a project, keep their own grants, and delete one at a time', async () => {
  fakes = await installFakeClis({});
  const dirA = makeProject('gp-scope-a-', [{ id: 'durable_gps_alpha', name: 'alpha' }, { id: 'durable_gps_beta', name: 'beta' }]);
  const dirB = makeProject('gp-scope-b-', [{ id: 'durable_gps_gamma', name: 'gamma' }]);
  const nameA = path.basename(dirA);
  const nameB = path.basename(dirB);
  profile = createDisposableProfile({ label: 'gp-scopes' });
  app = await launchApp({ profile, env: fakes.env });
  const { window, electronApp } = app;
  await addProject(electronApp, window, dirA);
  await addProject(electronApp, window, dirB);

  await window.getByTestId('app-row-group-projects').click();
  await expect(window.getByTestId('group-projects-hub')).toBeVisible();

  // One app-wide group (starts with no members) and one group for each project.
  await createGroup(window, 'Everyone');
  await back(window).click();
  await createGroup(window, 'Team A', nameA);
  await back(window).click();
  await createGroup(window, 'Team B', nameB);
  await back(window).click();

  const hub = window.getByTestId('group-projects-hub');
  await expect(hub.getByRole('region', { name: nameA }).getByRole('button', { name: 'Team A', exact: true })).toBeVisible();
  await expect(hub.getByRole('region', { name: nameB }).getByRole('button', { name: 'Team B', exact: true })).toBeVisible();
  await expect(hub.getByRole('region', { name: 'App-wide' }).getByRole('button', { name: 'Everyone', exact: true })).toBeVisible();

  // Grants: a project group starts with its project's agents, and lead and admin are per member.
  await row(window, 'Team A').click();
  await window.getByRole('button', { name: 'Permissions', exact: true }).click();
  const alphaLead = window.getByLabel('Lead for alpha');
  const alphaAdmin = window.getByLabel('Admin for alpha');
  const betaLead = window.getByLabel('Lead for beta');
  await expect(alphaLead).toHaveValue('off');
  await expect(alphaAdmin).toHaveValue('off');
  await alphaLead.selectOption('allow');
  await expect(alphaLead).toHaveValue('allow');
  await expect(alphaAdmin).toHaveValue('off');
  await expect(betaLead).toHaveValue('off');
  // Team A holds only its own project's agents.
  await expect(window.getByLabel('Lead for gamma')).toHaveCount(0);
  await back(window).click();

  // The project view: that project's groups and the app-wide ones, with an escape to every group.
  await selectProject(window, nameA);
  await window.getByTestId('start-page-group-projects').click();
  await expect(window.getByRole('heading', { name: `${nameA} and app-wide`, level: 2 })).toBeVisible();
  await expect(row(window, 'Team A')).toBeVisible();
  await expect(row(window, 'Everyone')).toBeVisible();
  await expect(row(window, 'Team B')).toHaveCount(0);
  await window.getByRole('button', { name: 'All groups', exact: true }).click();
  await expect(row(window, 'Team B')).toBeVisible();
  await expect(row(window, 'Team A')).toBeVisible();

  // Delete one group. The others, and their grants, stay.
  await row(window, 'Team B').click();
  await window.getByRole('button', { name: 'Details', exact: true }).click();
  await window.getByRole('button', { name: 'Delete group project' }).click();
  const dialog = window.getByRole('dialog', { name: 'Delete Team B?' });
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog).not.toBeVisible();
  await back(window).click();
  await expect(row(window, 'Team B')).toHaveCount(0);
  await expect(row(window, 'Team A')).toBeVisible();
  await expect(row(window, 'Everyone')).toBeVisible();
  await row(window, 'Team A').click();
  await window.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(window.getByLabel('Lead for alpha')).toHaveValue('allow');
});
