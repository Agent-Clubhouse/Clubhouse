import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, seedProfile, type DisposableProfile } from './app-profile';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp, type LaunchOptions } from './launch';
import { addProject } from './smoke-helpers';
import { BETA_FLAGS, betaFiles } from './stable-state-seeds.mjs';

/**
 * Which layout each saved state starts on, and what comes through the switch:
 * a fresh install, a stable upgrader and a saved false here, and a beta user with
 * everything on also here for the classic path. The same beta user on the default
 * path is in e2e/stable-mode.spec.ts.
 *
 * This build plays both sides of the upgrade: a classic session writes the state,
 * then a launch with no saved flag reads it. An upgrade from a released build is
 * not run. See docs/ci.md for the budget: this runs in the Stable-mode E2E job.
 */

const STABLE_BUILD = { CLUBHOUSE_TEST_STABLE_BUILD: '1' };
const OVERRIDES_KEY = 'clubhouse_keyboard_shortcut_overrides';
const CHROME_KEY = 'clubhouse_chrome_v2';
const ONBOARDING_KEY = 'clubhouse_onboarding';
const FLAGS_FILE = 'experimental-settings.json';

let app: LaunchedApp | undefined;
let profile: DisposableProfile | undefined;
let fakes: FakeClis | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

async function launch(opts: LaunchOptions = {}): Promise<Page> {
  app = await launchApp({ profile, env: STABLE_BUILD, ...opts });
  return app.window;
}

async function quit(): Promise<void> {
  await app?.electronApp.close();
  app = undefined;
}

function makeProject(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-layout-')), name);
  tempDirs.push(path.dirname(dir));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# layout default e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

async function expectNewLayout(w: Page): Promise<void> {
  await expect(w.locator('[data-testid="chrome-title-bar"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toBeVisible();
  expect(await w.evaluate(() => (window.clubhouse as { newChromeLayout?: unknown }).newChromeLayout)).toBe(true);
}

async function expectClassicLayout(w: Page): Promise<void> {
  await expect(w.locator('[data-testid="title-bar"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="chrome-title-bar"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toHaveCount(0);
  expect(await w.evaluate(() => (window.clubhouse as { newChromeLayout?: unknown }).newChromeLayout)).toBe(false);
}

const savedFlagsText = (target: DisposableProfile) => fs.promises.readFile(path.join(target.userDataDir, FLAGS_FILE), 'utf8');
const savedNewChrome = async (target: DisposableProfile) => JSON.parse(await savedFlagsText(target)).newChrome;
const readStorage = (w: Page, key: string) => w.evaluate((k) => localStorage.getItem(k), key);
const onboardingCompleted = async (w: Page) => JSON.parse(await readStorage(w, ONBOARDING_KEY) ?? '{}').completed;
const projectOrder = (w: Page) => w.evaluate(async () => (await window.clubhouse.project.list() as Array<{ id: string }>).map((p) => p.id));
const treeOrder = (w: Page) => w.locator('[data-testid^="project-group-"]').evaluateAll(
  (rows) => rows.map((row) => (row as HTMLElement).dataset.testid!.replace('project-group-', '')),
);

async function openSettingsPage(w: Page, label: string): Promise<void> {
  const nav = w.getByRole('button', { name: label, exact: true });
  if (!(await nav.isVisible().catch(() => false))) await w.locator('[data-testid="nav-settings"]').click();
  await nav.click();
}

const classicToggle = (w: Page) => w.getByRole('switch', { name: 'Classic layout' });
const restartButton = (w: Page) => w.getByRole('button', { name: 'Restart', exact: true });

test('fresh install: the new layout, its first-run page, and onboarding counted as done', async () => {
  profile = createDisposableProfile({ label: 'layout-fresh' });
  const w = await launch({ onboarding: 'show' });

  await expectNewLayout(w);
  await expect(w.locator('[data-testid="first-run"]')).toBeVisible({ timeout: 15_000 });
  // The classic shell's modal comes up after 500 ms, so give a wrong one time to show.
  await w.waitForTimeout(1_500);
  await expect(w.locator('[data-testid="onboarding-backdrop"]')).toHaveCount(0);
  expect(await onboardingCompleted(w)).toBe(true);

  // The default isn't written down, so a later default can still change it.
  if (fs.existsSync(path.join(profile.userDataDir, FLAGS_FILE))) expect(JSON.parse(await savedFlagsText(profile))).not.toHaveProperty('newChrome');
});

test('unreadable flags: the classic layout, and the file is left as it was', async () => {
  profile = createDisposableProfile({ label: 'layout-corrupt' });
  fs.writeFileSync(path.join(profile.userDataDir, FLAGS_FILE), '{"newChrome": fal');
  const w = await launch();

  await expectClassicLayout(w);
  await quit();
  expect(await savedFlagsText(profile)).toBe('{"newChrome": fal');
});

test('saved false: the classic layout, and the Display toggle survives relaunches both ways', async () => {
  profile = createDisposableProfile({ label: 'layout-saved-false' });
  let w = await launch({ experimental: { newChrome: false } });
  const seeded = await savedFlagsText(profile);

  await expectClassicLayout(w);
  await openSettingsPage(w, 'Display & UI');
  await expect(classicToggle(w)).toHaveAttribute('aria-checked', 'true');
  await expect(restartButton(w)).toHaveCount(0);
  // Nothing rewrites a saved choice until the person changes it.
  expect(await savedFlagsText(profile)).toBe(seeded);

  await classicToggle(w).click();
  await expect(classicToggle(w)).toHaveAttribute('aria-checked', 'false');
  await expect(restartButton(w)).toBeVisible();
  await expect.poll(() => savedNewChrome(profile!)).toBe(true);
  await quit();

  w = await launch();
  await expectNewLayout(w);
  await openSettingsPage(w, 'Display & UI');
  await expect(classicToggle(w)).toHaveAttribute('aria-checked', 'false');
  await expect(restartButton(w)).toHaveCount(0);

  await classicToggle(w).click();
  await expect(classicToggle(w)).toHaveAttribute('aria-checked', 'true');
  await expect(restartButton(w)).toBeVisible();
  await expect.poll(() => savedNewChrome(profile!)).toBe(false);
  await quit();

  w = await launch();
  await expectClassicLayout(w);
  await openSettingsPage(w, 'Display & UI');
  await expect(classicToggle(w)).toHaveAttribute('aria-checked', 'true');
});

test('stable upgrader: projects, order and shortcuts come through, on the default and back on classic', async () => {
  profile = createDisposableProfile({ label: 'layout-upgrader' });
  const overrides = {
    'command-palette': 'Meta+Shift+K',
    'switch-agent-1': 'Meta+Shift+1',
    // Retired in the new layout: left out there, kept for classic.
    'switch-project-1': 'Meta+Alt+P',
    'go-home': 'Meta+Shift+J',
  };

  // A stable session: the classic layout, two projects in a chosen order, and no finished onboarding.
  let w = await launch({ experimental: { newChrome: false } });
  await expectClassicLayout(w);
  await addProject(app!.electronApp, w, makeProject('layout-alpha'));
  await addProject(app!.electronApp, w, makeProject('layout-beta'));
  const added = await projectOrder(w);
  expect(added).toHaveLength(2);
  const order = [...added].reverse();
  await w.evaluate((ids) => window.clubhouse.project.reorder(ids), order);
  // The stores' own writes have settled, and nothing writes these again on the way out.
  await w.waitForTimeout(1_000);
  await w.evaluate(({ overridesKey, chromeKey, onboardingKey, saved }) => {
    localStorage.setItem(overridesKey, JSON.stringify(saved));
    localStorage.removeItem(chromeKey);
    localStorage.setItem(onboardingKey, JSON.stringify({ completed: false, cohort: null }));
  }, { overridesKey: OVERRIDES_KEY, chromeKey: CHROME_KEY, onboardingKey: ONBOARDING_KEY, saved: overrides });
  await quit();

  // The upgrade: the flag was never saved.
  fs.rmSync(path.join(profile.userDataDir, FLAGS_FILE));
  w = await launch({ onboarding: 'show' });
  await expectNewLayout(w);
  await expect(w.locator('[data-testid="project-tree"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => treeOrder(w)).toEqual(order);
  // Nothing starts out idle, a project opens, and there is no first-run page.
  await expect(w.locator('[data-testid="idle-projects"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="first-run"]')).toHaveCount(0);
  await expect(w.locator('[data-testid^="project-"][data-active="true"]')).toHaveCount(1);
  await w.waitForTimeout(1_500);
  await expect(w.locator('[data-testid="onboarding-backdrop"]')).toHaveCount(0);
  expect(await onboardingCompleted(w)).toBe(true);
  expect(JSON.parse(await readStorage(w, CHROME_KEY) ?? '{}').shortcuts?.overrides).toEqual({
    'command-palette': 'Meta+Shift+K',
    'switch-agent-1': 'Meta+Shift+1',
  });
  expect(JSON.parse(await readStorage(w, OVERRIDES_KEY) ?? '{}')).toEqual(overrides);
  expect(await projectOrder(w)).toEqual(order);
  expect(fs.existsSync(path.join(profile.userDataDir, FLAGS_FILE))).toBe(false);
  await quit();

  // Back to classic: everything as it was, and no onboarding over the workspace.
  seedProfile(profile, { experimental: { newChrome: false } });
  w = await launch({ onboarding: 'show' });
  await expectClassicLayout(w);
  await w.waitForTimeout(1_500);
  await expect(w.locator('[data-testid="onboarding-backdrop"]')).toHaveCount(0);
  expect(JSON.parse(await readStorage(w, OVERRIDES_KEY) ?? '{}')).toEqual(overrides);
  expect(await projectOrder(w)).toEqual(order);
});

test('beta user on classic: a Dispatcher that is on can be turned off, and then not on', async () => {
  profile = createDisposableProfile({ label: 'layout-beta-classic' });
  fakes = await installFakeClis({ claude: 'session-info' });
  const flags = { ...BETA_FLAGS, newChrome: false };
  const w = await launch({ experimental: flags, userDataFiles: betaFiles(true), env: { ...STABLE_BUILD, ...fakes.env } });

  await expectClassicLayout(w);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toHaveCount(0);
  expect(await w.evaluate(() => window.clubhouse.app.getExperimentalSettings())).toEqual(flags);

  await openSettingsPage(w, 'Dispatcher');
  const dispatcher = w.getByRole('switch', { name: 'Turn on Dispatcher' });
  await expect(dispatcher).toHaveAttribute('aria-checked', 'true');
  await expect(dispatcher).toBeEnabled();
  await dispatcher.click();
  await expect(dispatcher).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await expect(dispatcher).toBeDisabled();
  await expect(w.locator('#dispatcher-enabled-help')).toHaveText('The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI, then restart Clubhouse.');
});
