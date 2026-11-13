import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchApp } from './launch';
import { installFakeClis } from './chat-fake-cli';
import { createDisposableProfile } from './app-profile';
import { addProject } from './smoke-helpers';

test('group project lead and admin grants persist independently', async () => {
  const fakes = await installFakeClis({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-grants-e2e-'));
  const profile = createDisposableProfile({ label: 'gp-grants' });
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: 'durable_grants_dev', name: 'dev', color: 'indigo', createdAt: new Date().toISOString() },
  ]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# grant fixture\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp({ profile, env: fakes.env });
    await addProject(app.electronApp, app.window, dir);
    await app.window.getByTestId('nav-settings').click();
    await app.window.getByTestId('settings-nav-app-group-projects').click();
    await app.window.getByLabel('New group project name').fill('Grant fixture');
    await app.window.getByRole('button', { name: 'Create group project' }).click();
    await app.window.getByRole('button', { name: 'Grant fixture', exact: true }).click();
    const lead = app.window.getByLabel('Lead for dev');
    const admin = app.window.getByLabel('Admin for dev');
    await expect(lead).toHaveValue('off');
    await expect(admin).toHaveValue('off');
    await lead.selectOption('allow');
    await expect(lead).toHaveValue('allow');
    await expect(admin).toHaveValue('off');
    await admin.selectOption('ask');
    await expect(admin).toHaveValue('ask');
    await app.electronApp.close();
    app = await launchApp({ profile, env: fakes.env });
    await app.window.getByTestId('nav-settings').click();
    await app.window.getByTestId('settings-nav-app-group-projects').click();
    await app.window.getByRole('button', { name: 'Grant fixture', exact: true }).click();
    await expect(app.window.getByLabel('Lead for dev')).toHaveValue('allow');
    await expect(app.window.getByLabel('Admin for dev')).toHaveValue('ask');
  } finally {
    await app?.electronApp.close().catch(() => {});
    await fakes.cleanup();
    profile.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
