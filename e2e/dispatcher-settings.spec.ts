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
 * Settings › Dispatcher (#3046), over a fake `claude` that is never started,
 * so no tokens are spent:
 * - one page: Identity, Behavior, Connected agents and Reset, with no model,
 *   context, access or "runs in" fields;
 * - a new name reaches both of its records and its sidebar row;
 * - Runs on and usage show; usage is conversations only until background
 *   work reports its share;
 * - Connected agents lists the project's agents with the same switch as each
 *   agent's card, which moves the wire live; Card opens that card;
 * - Forget everything asks first, then clears memory and held news only: its
 *   agents, the wire and Actions stay.
 *
 * Runs in the Chat E2E job (Linux and Windows), like dispatcher.spec.ts.
 */

const USER_DATA_FILES = {
  'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
  'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
};
const ORCHESTRATOR_ID = 'orch_dispatcher_settings_e2e';
const WORKER_ID = 'worker_dispatcher_settings_e2e';

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

/** A git repo with an orchestrator, which connects by default, and an agent that doesn't. */
function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-settings-e2e-'));
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: ORCHESTRATOR_ID, name: 'conductor', color: 'emerald', createdAt, orchestrator: 'claude-code', orchestration: { orchestrate: true } },
    { id: WORKER_ID, name: 'builder', color: 'amber', createdAt, orchestrator: 'claude-code' },
  ]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# dispatcher settings e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

const baseDir = () => path.join(profile!.userDataDir, '.clubhouse-dev');
const dispatcherDir = () => path.join(baseDir(), 'dispatcher');
const memoryDir = () => path.join(dispatcherDir(), 'memory');

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
}

async function recordOf(dir: string): Promise<{ id: string; name: string }> {
  const file = path.join(dir, '.clubhouse', 'agents.json');
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true);
  return (await readJson<Array<{ id: string; name: string }>>(file))[0];
}

async function hasWire(w: Page, id: string): Promise<boolean> {
  const bindings = await w.evaluate(() => window.clubhouse.mcpBinding.getBindings()) as Array<{ agentId: string; targetId: string }>;
  return bindings.some((b) => b.agentId === id && b.targetId === ORCHESTRATOR_ID)
    && bindings.some((b) => b.agentId === ORCHESTRATOR_ID && b.targetId === id);
}

async function openDispatcherSettings(w: Page): Promise<void> {
  const nav = w.getByRole('button', { name: 'Dispatcher', exact: true });
  if (!(await nav.isVisible().catch(() => false))) await w.locator('[data-testid="nav-settings"]').click();
  await nav.click();
  await expect(w.locator('[data-testid="dispatcher-settings"]')).toBeVisible();
}

test('Settings > Dispatcher: identity, behavior, connected agents, and Forget everything', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-settings' });
  projectDir = makeProject();
  // News held for the next check-in, from before this launch.
  fs.mkdirSync(baseDir(), { recursive: true });
  fs.writeFileSync(path.join(baseDir(), 'dispatcher-news.json'), JSON.stringify({
    openRequests: [], held: [{ text: 'Lint is green.', at: Date.now(), from: 'conductor' }], shown: [],
  }));
  app = await launchApp({ profile, experimental: { chat: true }, userDataFiles: USER_DATA_FILES, env: fakes.env });
  const w = app.window;

  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  const coordinator = await recordOf(dispatcherDir());
  await addProject(app.electronApp, w, projectDir);
  await expect.poll(() => hasWire(w, coordinator.id), { timeout: 15_000 }).toBe(true);

  await openDispatcherSettings(w);
  const page = w.locator('[data-testid="dispatcher-settings"]');
  await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Identity', 'Behavior', 'Connected agents', 'Reset']);
  for (const gone of ['#dispatcher-cli', '#dispatcher-context', '#dispatcher-access', '#dispatcher-runtime']) {
    await expect(page.locator(gone)).toHaveCount(0);
  }

  // Identity: a new name reaches both records and the sidebar row.
  const name = w.locator('[data-testid="dispatcher-name"]');
  await name.fill('Rosie');
  await name.press('Enter');
  await expect.poll(async () => (await recordOf(dispatcherDir())).name).toBe('Rosie');
  await expect.poll(async () => (await recordOf(path.join(baseDir(), 'dispatcher-chat'))).name, { timeout: 10_000 }).toBe('Rosie');
  await expect(w.locator('[data-testid="dispatcher-row"]')).toContainText('Rosie');

  // Behavior: the level, Runs on with its warning, and usage, conversations only for now.
  await expect(w.locator('[data-testid="dispatcher-behavior"]')).toHaveValue('standard');
  await expect(w.locator('[data-testid="dispatcher-runs-on"]')).toHaveValue('claude-code');
  await expect(page).toContainText('Switching starts a fresh conversation. Its memory stays');
  await expect(w.locator('[data-testid="dispatcher-usage-conversations-value"]')).toHaveText('None yet', { timeout: 15_000 });
  await expect(w.locator('[data-testid="dispatcher-usage-background"]')).toHaveCount(0);

  // Connected agents: the orchestrator is on by default, the other agent isn't.
  const conductor = w.locator(`[data-testid="dispatcher-agent-${ORCHESTRATOR_ID}-switch"]`);
  const builder = w.locator(`[data-testid="dispatcher-agent-${WORKER_ID}-switch"]`);
  await expect(conductor).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await expect(builder).toHaveAttribute('aria-checked', 'false');
  // The same switch as the agent's card: off removes the wire live, on puts it back.
  await conductor.click();
  await expect(conductor).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => hasWire(w, coordinator.id)).toBe(false);
  await conductor.click();
  await expect(conductor).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => hasWire(w, coordinator.id)).toBe(true);

  // Forget everything: memory written by the Dispatcher, and an Action that must stay.
  await fs.promises.writeFile(path.join(memoryDir(), 'topics', 'release.md'), 'Status: confirmed\n\nShip 1.0 on Friday.\n');
  await fs.promises.writeFile(path.join(memoryDir(), 'agents', 'conductor.md'), '## Card\nOwns releases.\n');
  await fs.promises.appendFile(path.join(memoryDir(), 'index.md'), '\n- topics/release.md: ship 1.0 on Friday\n');
  const actionsBefore = await w.evaluate(() => window.clubhouse.actions.list()) as unknown[];
  const coordinatorRecord = await fs.promises.readFile(path.join(dispatcherDir(), '.clubhouse', 'agents.json'), 'utf8');

  await w.locator('[data-testid="dispatcher-forget"]').click();
  const dialog = w.getByRole('dialog');
  await expect(dialog).toContainText('Forget everything?');
  await expect(dialog).toContainText('Your agents, connections, Actions and its chat stay.');
  // Cancel forgets nothing.
  await w.locator('[data-testid="confirm-destructive-cancel"]').click();
  expect(fs.existsSync(path.join(memoryDir(), 'topics', 'release.md'))).toBe(true);

  await w.locator('[data-testid="dispatcher-forget"]').click();
  await w.locator('[data-testid="confirm-destructive-confirm"]').click();
  await expect(w.locator('[data-testid="dispatcher-forget-done"]')).toHaveText('Rosie starts over with an empty memory.');
  expect(fs.existsSync(path.join(memoryDir(), 'topics', 'release.md'))).toBe(false);
  expect(fs.existsSync(path.join(memoryDir(), 'agents', 'conductor.md'))).toBe(false);
  expect(fs.existsSync(path.join(memoryDir(), 'index.md'))).toBe(true);
  await expect.poll(async () => (await readJson<{ held: unknown[] }>(path.join(baseDir(), 'dispatcher-news.json'))).held).toEqual([]);
  // Its agents, the wire and Actions stay.
  expect(await fs.promises.readFile(path.join(dispatcherDir(), '.clubhouse', 'agents.json'), 'utf8')).toBe(coordinatorRecord);
  expect(await hasWire(w, coordinator.id)).toBe(true);
  await expect(conductor).toHaveAttribute('aria-checked', 'true');
  expect(await w.evaluate(() => window.clubhouse.actions.list())).toEqual(actionsBefore);
  // The index starts over, and its instructions carry the fresh one.
  expect(await fs.promises.readFile(path.join(memoryDir(), 'index.md'), 'utf8')).not.toContain('ship 1.0 on Friday');
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf8')).toContain('## Your memory index');

  // Card opens the agent with its Dispatcher card expanded.
  await w.locator(`[data-testid="dispatcher-agent-${ORCHESTRATOR_ID}-card"]`).click();
  await expect(w.locator('[data-testid="dispatcher-settings"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="details-card-dispatcher-toggle"]')).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });

  // Nothing ever started the CLI.
  expect((await fakes.report('claude').catch(() => undefined))?.consumed ?? 0).toBe(0);
});
