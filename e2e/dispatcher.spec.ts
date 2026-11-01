import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';

/**
 * The Dispatcher (#2533) at the UI level, over a fake `claude`, so no tokens
 * are spent:
 * - flag off: no row, no Settings > Dispatcher, no Connect to Dispatcher;
 * - turning it on creates one Dispatcher folder, its row and view;
 * - Connect to Dispatcher adds and removes the wire live, and it survives a
 *   restart;
 * - turning it off (the setting, then the flag while it runs) stops it and
 *   drops its row and wires, keeps its folder, and it comes back with the
 *   same id.
 *
 * Runs in the Chat E2E job (Linux and Windows), not the sharded E2E run:
 * nothing here differs on macOS, and it would lengthen the E2E long pole.
 */

const USER_DATA_FILES = {
  // The provider is installed (the fake), so no first-run CLI probe.
  'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
  'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
};
const ORCHESTRATOR_ID = 'orch_dispatcher_e2e';

let fakes: FakeClis | undefined;
let projectDir: string | undefined;
let profile: DisposableProfile | undefined;
let app: LaunchedApp | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  projectDir = undefined;
});

/** A git repo with one orchestrator that has orchestration on. */
function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-e2e-'));
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([{
    id: ORCHESTRATOR_ID, name: 'conductor', color: 'emerald', createdAt: new Date().toISOString(),
    orchestrator: 'claude-code', orchestration: { orchestrate: true },
  }]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# dispatcher e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

async function launch(experimental: Record<string, boolean>): Promise<LaunchedApp> {
  app = await launchApp({
    profile,
    experimental: { newChrome: true, chat: true, ...experimental },
    userDataFiles: USER_DATA_FILES,
    env: fakes!.env,
  });
  return app;
}

function dispatcherDir(): string {
  return path.join(profile!.userDataDir, '.clubhouse-dev', 'dispatcher');
}

async function dispatcherConfigs(): Promise<Array<{ id: string; persona?: string }>> {
  const file = path.join(dispatcherDir(), '.clubhouse', 'agents.json');
  return fs.existsSync(file) ? JSON.parse(await fs.promises.readFile(file, 'utf8')) : [];
}

async function dispatcherIds(): Promise<string[]> {
  return (await dispatcherConfigs()).map((c) => c.id);
}

const row = (w: Page) => w.locator('[data-testid="dispatcher-row"]');
const rowItem = (w: Page) => row(w).locator('[role="treeitem"]');

/** Open a Settings page from the sidebar. */
async function openSettingsPage(w: Page, label: string): Promise<void> {
  const nav = w.getByRole('button', { name: label, exact: true });
  if (!(await nav.isVisible().catch(() => false))) await w.locator('[data-testid="nav-settings"]').click();
  await nav.click();
}

async function closeSettings(w: Page): Promise<void> {
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(w.getByRole('button', { name: 'Experimental', exact: true })).toBeHidden();
}

/** Select the orchestrator and expand its Orchestrate card. */
async function openOrchestrateCard(w: Page): Promise<void> {
  const agent = w.locator('[data-agent-name="conductor"]').first();
  if (!(await agent.isVisible().catch(() => false))) {
    await w.locator('[role="treeitem"]:has-text("dispatcher-e2e-")').first().click();
    const fold = w.locator('[data-testid^="sleeping-fold-"]').first();
    if (await fold.isVisible().catch(() => false)) await fold.click();
  }
  await agent.click();
  const head = w.locator('[data-testid="details-card-orchestrate-toggle"]').first();
  await expect(head).toBeVisible({ timeout: 10_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(w.locator('[data-testid="orchestrate-toggle"]')).toBeVisible();
}

/** Whether both ends of the Dispatcher ↔ orchestrator wire exist. */
async function hasWire(w: Page, dispatcherId: string): Promise<boolean> {
  const bindings = await w.evaluate(() => window.clubhouse.mcpBinding.getBindings()) as Array<{ agentId: string; targetId: string }>;
  return bindings.some((b) => b.agentId === dispatcherId && b.targetId === ORCHESTRATOR_ID)
    && bindings.some((b) => b.agentId === ORCHESTRATOR_ID && b.targetId === dispatcherId);
}

test('flag off: no Dispatcher row, settings page or Connect switch', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-off' });
  projectDir = makeProject();
  const { electronApp, window: w } = await launch({ dispatcher: false });

  await addProject(electronApp, w, projectDir);
  await openOrchestrateCard(w);
  await expect(w.locator('[data-testid="orchestrate-dispatcher"]')).toHaveCount(0);
  await expect(row(w)).toHaveCount(0);

  await w.locator('[data-testid="nav-settings"]').click();
  await expect(w.getByRole('button', { name: 'Experimental', exact: true })).toBeVisible();
  await expect(w.getByRole('button', { name: 'Dispatcher', exact: true })).toHaveCount(0);
  expect(fs.existsSync(dispatcherDir())).toBe(false);
});

test('turn on, wire an orchestrator, restart, turn off and back on', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-on' });
  projectDir = makeProject();
  let w = (await launch({ dispatcher: true })).window;

  // Flag on, setting off: still nothing, and no folder.
  await expect(row(w)).toHaveCount(0);
  await openSettingsPage(w, 'Dispatcher');
  const enabled = w.locator('[data-testid="dispatcher-enabled"]');
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  expect(fs.existsSync(dispatcherDir())).toBe(false);

  // Turn it on: one Dispatcher with notes/ and its CLI's instructions file,
  // and its row with zero projects.
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await expect(row(w)).toBeVisible();
  await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
  const [config] = await dispatcherConfigs();
  const dispatcherId = config.id;
  expect(config.persona).toBe('dispatcher');
  expect(fs.existsSync(path.join(dispatcherDir(), 'notes'))).toBe(true);
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf8')).toContain('Dispatcher');

  // Off and on again keeps the one Dispatcher.
  await enabled.click();
  await expect(row(w)).toHaveCount(0);
  await enabled.click();
  await expect(row(w)).toBeVisible();
  expect(await dispatcherIds()).toEqual([dispatcherId]);

  await closeSettings(w);
  await rowItem(w).click();
  await expect(w.locator('[data-testid="dispatcher-view"]')).toBeVisible();
  await expect(w.locator('[data-testid="title-bar"]')).toContainText('Dispatcher');

  // A project: selecting its agent closes the view back to the project.
  await addProject(app!.electronApp, w, projectDir);
  await rowItem(w).click();
  await expect(w.locator('[data-testid="dispatcher-view"]')).toBeVisible();
  await openOrchestrateCard(w);
  await expect(w.locator('[data-testid="dispatcher-view"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="title-bar"]')).toContainText(path.basename(projectDir));

  // Connect to Dispatcher adds and removes the wire live.
  const connect = w.locator('[data-testid="orchestrate-dispatcher"]');
  await expect(connect).toBeVisible();
  expect(await hasWire(w, dispatcherId)).toBe(false);
  await connect.click();
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(true);
  await connect.click();
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(false);
  await connect.click();
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(true);

  // The wire comes back after a restart.
  await app!.electronApp.close();
  w = (await launch({ dispatcher: true })).window;
  await expect(row(w)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => hasWire(w, dispatcherId), { timeout: 15_000 }).toBe(true);

  // Turning the setting off drops the row and wires and keeps the folder.
  fs.writeFileSync(path.join(dispatcherDir(), 'notes', 'plan.md'), 'kept\n');
  await openSettingsPage(w, 'Dispatcher');
  await w.locator('[data-testid="dispatcher-enabled"]').click();
  await expect(row(w)).toHaveCount(0);
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(false);
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'notes', 'plan.md'), 'utf8')).toBe('kept\n');
  await w.locator('[data-testid="dispatcher-enabled"]').click();
  await expect(row(w)).toBeVisible();
  expect(await dispatcherIds()).toEqual([dispatcherId]);
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(true);

  // Start it, then turn the experimental flag off while it runs.
  await closeSettings(w);
  await rowItem(w).click();
  await w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect.poll(async () => (await fakes!.report('claude').catch(() => undefined))?.consumed ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  await openSettingsPage(w, 'Experimental');
  const flag = w.locator('[role="switch"][aria-label="Dispatcher"]');
  await flag.click();
  await expect(flag).toHaveAttribute('aria-checked', 'false');
  await expect(row(w)).toHaveCount(0);
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(false);

  // Flag back on: the same Dispatcher, stopped.
  await flag.click();
  await expect(row(w)).toBeVisible();
  expect(await dispatcherIds()).toEqual([dispatcherId]);
  await closeSettings(w);
  await rowItem(w).click();
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]')).toBeVisible();
});
