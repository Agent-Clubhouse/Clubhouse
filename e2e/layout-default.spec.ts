import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, seedProfile, type DisposableProfile } from './app-profile';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type ElectronApp, type LaunchedApp, type LaunchOptions } from './launch';
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
 *
 * The last group is a smoke of the default layout's paths. It lives here because
 * this file already runs in that job on Linux and Windows.
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
  app = await launchApp({ profile, env: STABLE_BUILD, ...opts, preserveFirstLoad: true });
  return app.window;
}

async function quit(): Promise<void> {
  await app?.electronApp.close();
  app = undefined;
}

function makeProject(name: string, { owner = tempDirs, agents = [] }: { owner?: string[]; agents?: unknown[] } = {}): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-layout-')), name);
  owner.push(path.dirname(dir));
  fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify(agents));
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
  // On by default here, beside the first-run page, with nothing saved for it.
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  expect(fs.existsSync(path.join(profile.userDataDir, 'dispatcher-settings.json'))).toBe(false);
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
  // The switch agrees with the layout, so there's no restart to offer.
  await openSettingsPage(w, 'Display & UI');
  await expect(classicToggle(w)).toHaveAttribute('aria-checked', 'true');
  await expect(restartButton(w)).toHaveCount(0);
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
    // Go to Home was removed with Home: unused, but the saved binding stays on disk.
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

/**
 * A smoke: each path works once, on one launch with no pinned flags. It is not the
 * depth the classic layout's specs have, and doesn't replace them. `claude` is the
 * fake CLI and the other providers point at nothing, so no prompt can reach a real one.
 */
test.describe.serial('default path smoke', () => {
  const SEEDED_AGENT_ID = 'durable_default_smoke';
  const SEEDED_AGENT = 'smoke-seeded';
  const CREATED_AGENT = 'smoke-created';
  const MISSION = 'smoke-mission';

  let smokeApp: ElectronApp;
  let w: Page;
  let smokeFakes: FakeClis;
  let projects: Array<{ id: string; name: string; dir: string }>;
  const smokeDirs: string[] = [];

  const projectHeader = (id: string) => w.locator(`[data-testid="project-${id}"]`);
  const newAgentPage = () => w.locator('[data-testid="new-agent-page"]');
  const palette = () => w.locator('[data-testid="command-palette-overlay"]');

  /** A tab is in the title bar or, when they don't all fit, in its More menu. */
  async function selectTab(id: string): Promise<void> {
    const tab = w.locator(`[data-testid="explorer-tab-${id}"]`);
    await expect(async () => {
      const more = w.locator('[data-testid="title-more"]');
      if (!(await tab.isVisible()) && await more.isVisible()) await more.click();
      await expect(tab).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await tab.click();
  }

  async function runPaletteCommand(label: string): Promise<void> {
    await palette().locator('input').fill(label);
    await expect(palette().locator('[role="option"][aria-selected="true"]')).toContainText(label);
    await w.keyboard.press('Enter');
    await expect(palette()).toBeHidden({ timeout: 5_000 });
  }

  test.beforeAll(async () => {
    smokeFakes = await installFakeClis({ claude: 'session-info' }, { npmStyleShims: true });
    const dirs = [
      makeProject('smoke-alpha', { owner: smokeDirs, agents: [{
        id: SEEDED_AGENT_ID, name: SEEDED_AGENT, color: 'emerald', createdAt: new Date().toISOString(), orchestrator: 'claude-code',
      }] }),
      makeProject('smoke-beta', { owner: smokeDirs }),
    ];
    ({ electronApp: smokeApp, window: w } = await launchApp({
      label: 'default-smoke',
      userDataFiles: { 'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true } },
      env: smokeFakes.env,
    }));
    await expect(w.locator('[data-testid="chrome-title-bar"]')).toBeVisible({ timeout: 15_000 });
    for (const dir of dirs) await addProject(smokeApp, w, dir);
    const listed = await w.evaluate(async () => (await window.clubhouse.project.list() as Array<{ id: string; path: string }>).map(({ id, path: p }) => ({ id, path: p })));
    projects = dirs.map((dir) => ({ id: listed.find((p) => p.path === dir)!.id, name: path.basename(dir), dir }));
  });

  test.afterAll(async () => {
    await smokeApp?.close();
    await smokeFakes?.cleanup();
    for (const dir of smokeDirs) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test('sidebar: selects a project, an agent and the tabs', async () => {
    const [alpha, beta] = projects;
    await projectHeader(beta.id).click();
    await expect(projectHeader(beta.id)).toHaveAttribute('data-active', 'true');
    await expect(projectHeader(alpha.id)).toHaveAttribute('data-active', 'false');

    await projectHeader(alpha.id).click();
    await expect(projectHeader(alpha.id)).toHaveAttribute('data-active', 'true');
    await w.locator(`[data-testid="sleeping-fold-${alpha.id}"]`).click();
    await w.locator(`[data-testid="agent-item-${SEEDED_AGENT_ID}"]`).click();
    await expect(w.locator('[data-testid="wake-button"]')).toBeVisible({ timeout: 10_000 });

    // A tab's own list takes over the sidebar, and Agents brings the tree back.
    await selectTab('plugin:files');
    await expect(w.locator('[data-testid="project-tree"]')).toBeHidden({ timeout: 10_000 });
    await selectTab('agents');
    await expect(w.locator('[data-testid="project-tree"]')).toBeVisible({ timeout: 10_000 });
    await expect(w.locator('[data-testid="wake-button"]')).toBeVisible({ timeout: 10_000 });
  });

  test('settings: opens, moves between pages, closes and returns to the agent', async () => {
    await w.locator('[data-testid="nav-settings"]').click();
    await expect(w.locator('[data-testid="settings-nav"]')).toBeVisible({ timeout: 10_000 });

    for (const [page, title] of [['keyboard-shortcuts', 'Keyboard shortcuts'], ['about', 'About']]) {
      await w.locator(`[data-testid="settings-nav-app-${page}"]`).click();
      await expect(w.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 10_000 });
    }

    await w.locator('[data-testid="nav-settings"]').click();
    await expect(w.locator('[data-testid="settings-nav"]')).toBeHidden({ timeout: 10_000 });
    await expect(w.locator('[data-testid="project-tree"]')).toBeVisible();
    await expect(w.locator('[data-testid="wake-button"]')).toBeVisible({ timeout: 10_000 });
  });

  test('palette: opens, runs a command and closes', async () => {
    const sidebarToggle = w.locator('[data-testid="chrome-sidebar-toggle"]');
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');

    await w.locator('[data-testid="chrome-palette-button"]').click();
    await expect(palette()).toBeVisible({ timeout: 5_000 });
    await runPaletteCommand('Toggle sidebar');
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false');

    // The sidebar's button is gone with it, so back by the shortcut.
    await w.keyboard.press('Meta+k');
    await expect(palette()).toBeVisible({ timeout: 5_000 });
    await runPaletteCommand('Toggle sidebar');
    await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');

    await w.keyboard.press('Meta+k');
    await expect(palette()).toBeVisible({ timeout: 5_000 });
    await w.keyboard.press('Escape');
    await expect(palette()).toBeHidden({ timeout: 5_000 });
  });

  test('new agent page: offers both kinds, and cancels', async () => {
    await w.locator('[data-testid="chrome-new"]').click();
    await w.getByRole('menuitem', { name: 'Quick agent…' }).click();
    await expect(newAgentPage()).toBeVisible({ timeout: 10_000 });
    await expect(w.locator('[data-testid="new-agent-kind-quick"]')).toHaveAttribute('aria-checked', 'true');
    await expect(w.locator('[data-testid="new-agent-mission"]')).toBeVisible();

    await w.locator('[data-testid="new-agent-kind-durable"]').click();
    await expect(w.locator('[data-testid="new-agent-kind-durable"]')).toHaveAttribute('aria-checked', 'true');
    await expect(w.locator('[data-testid="new-agent-name"]')).toBeVisible();

    await newAgentPage().getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(newAgentPage()).toBeHidden({ timeout: 5_000 });
  });

  test('new agent page: creates a durable agent from a project row', async () => {
    const [alpha] = projects;
    await projectHeader(alpha.id).hover();
    await w.getByRole('button', { name: `New agent in ${alpha.name}`, exact: true }).click();
    await expect(newAgentPage()).toBeVisible({ timeout: 10_000 });

    // A plain agent: Clubhouse managed is on by default, and its Start with template flow is managed-agents.spec's.
    const managed = newAgentPage().getByRole('switch', { name: 'Clubhouse managed' });
    await expect(managed).toHaveAttribute('aria-checked', 'true');
    await managed.click();
    await expect(managed).toHaveAttribute('aria-checked', 'false');
    await w.locator('[data-testid="new-agent-name"]').fill(CREATED_AGENT);
    await expect(w.locator('[data-testid="new-agent-submit"]')).toBeEnabled({ timeout: 10_000 });
    await w.locator('[data-testid="new-agent-submit"]').click();

    await expect(newAgentPage()).toBeHidden({ timeout: 30_000 });
    await expect(w.locator(`[data-agent-name="${CREATED_AGENT}"]`)).toBeVisible({ timeout: 15_000 });
    const saved = JSON.parse(await fs.promises.readFile(path.join(alpha.dir, '.clubhouse', 'agents.json'), 'utf8'));
    expect(saved.map((a: { name: string }) => a.name)).toContain(CREATED_AGENT);
  });

  test('new agent page: starts a quick agent on the fake CLI', async () => {
    await w.locator('[data-testid="chrome-new"]').click();
    await w.getByRole('menuitem', { name: 'Quick agent…' }).click();
    await expect(newAgentPage()).toBeVisible({ timeout: 10_000 });

    await w.locator('[data-testid="new-agent-mission"]').fill(MISSION);
    await w.locator('[data-testid="new-agent-submit"]').click();

    await expect(newAgentPage()).toBeHidden({ timeout: 30_000 });
    await expect(w.locator('[data-testid="new-agent-error"]')).toHaveCount(0);
    // The fake was what started, and it was given the mission.
    await expect.poll(async () => (await smokeFakes.report('claude').catch(() => null))?.argv.join(' ') ?? '', { timeout: 20_000 }).toContain(MISSION);
  });

  test('quick prompt: Cmd+N, type, Enter starts a quick agent (#2812)', async () => {
    const task = 'smoke-quick-prompt';
    await w.keyboard.press('ControlOrMeta+n');
    const prompt = w.getByRole('dialog', { name: 'New quick agent' });
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await expect(newAgentPage()).toBeHidden();
    // Esc closes it without starting anything.
    await w.keyboard.press('Escape');
    await expect(prompt).toBeHidden({ timeout: 5_000 });

    await w.keyboard.press('ControlOrMeta+n');
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await w.keyboard.type(task);
    await w.keyboard.press('Enter');
    await expect(prompt).toBeHidden({ timeout: 30_000 });
    await expect.poll(async () => (await smokeFakes.report('claude').catch(() => null))?.argv.join(' ') ?? '', { timeout: 20_000 }).toContain(task);
  });
});
