import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { chatFixturePath } from '../src/main/orchestrators/adapters/testing/fake-cli';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';

/**
 * The Dispatcher (#2533) at the UI level, over a fake `claude`, so no tokens
 * are spent:
 * - flag off: no row, no Settings > Dispatcher, no Connect to Dispatcher;
 * - turning it on creates one Dispatcher folder, its row and view;
 * - an orchestrator connects by default, Connect to Dispatcher removes and
 *   adds the wire live, and it survives a restart;
 * - turning it off (the setting, then the flag while it runs) stops it and
 *   drops its row and wires, keeps its folder, and it comes back with the
 *   same id;
 * - the Dispatcher wakes a connected agent with a message over MCP, and can't
 *   sleep it mid-turn without force.
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

/**
 * A fixture that opens a session and then goes quiet: a prompt is recorded in
 * the report as `unexpected` and never answered, so the agent stays mid-turn.
 */
async function writeQuietFixture(dir: string): Promise<string> {
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  const file = path.join(dir, 'quiet.jsonl');
  await fs.promises.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** A minimal MCP client over the bridge, as the agent the credentials belong to. */
async function connectMcp(env: Record<string, string | null>) {
  const url = `http://127.0.0.1:${env.CLUBHOUSE_MCP_PORT}/mcp/${env.CLUBHOUSE_AGENT_ID}`;
  let sessionId: string | null = null;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clubhouse-Nonce': env.CLUBHOUSE_HOOK_NONCE ?? '',
        ...(sessionId && { 'Mcp-Session-Id': sessionId }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    return (await res.json()).result;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  const toolNames = async (): Promise<string[]> => (await rpc('tools/list')).tools.map((t: { name: string }) => t.name);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
  };
  return { toolNames, call };
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

/** Select the orchestrator and expand its Orchestration card. */
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
  // The breadcrumb follows the project's agent again. Windows can drop the
  // project segment at its window width, so check the agent.
  await expect(w.locator('[data-testid="title-bar"]')).toContainText('conductor');
  await expect(w.locator('[data-testid="title-bar"]')).not.toContainText('Dispatcher');

  // Connected by default (#2578); Connect to Dispatcher removes and adds the wire live.
  const connect = w.locator('[data-testid="orchestrate-dispatcher"]');
  await expect(connect).toBeVisible();
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
  // Waking it from its view keeps the view, with its chat, and no project in the title (#2563).
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="title-bar"]')).toContainText('Dispatcher');
  await expect(w.locator('[data-testid="title-bar"]')).not.toContainText('dispatcher-e2e-');
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

test('the Dispatcher wakes a connected agent with a message and sleeps it again', async () => {
  projectDir = makeProject();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-e2e-fixture-'));
  try {
    fakes = await installFakeClis({ claude: await writeQuietFixture(fixtureDir) });
    profile = createDisposableProfile({ label: 'dispatcher-wake' });
    const w = (await launch({ dispatcher: true })).window;

    await openSettingsPage(w, 'Dispatcher');
    await w.locator('[data-testid="dispatcher-enabled"]').click();
    await expect(row(w)).toBeVisible();
    await closeSettings(w);
    await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
    const dispatcherId = (await dispatcherConfigs())[0].id;

    await addProject(app!.electronApp, w, projectDir);
    await openOrchestrateCard(w);
    await w.locator('[data-testid="orchestrate-dispatcher"]').click();
    await expect.poll(() => hasWire(w, dispatcherId)).toBe(true);

    // Start the Dispatcher. The fake reports the bridge credentials it was given.
    await rowItem(w).click();
    await w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
    await expect.poll(async () => (await fakes!.report('claude').catch(() => undefined))?.env.CLUBHOUSE_AGENT_ID, { timeout: 20_000 }).toBe(dispatcherId);
    const mcp = await connectMcp((await fakes!.report('claude')).env);

    const toolFor = (names: string[], suffix: string) => names.find((n) => n.endsWith(`__${suffix}`) && n.includes('conductor'));

    // Sleeping: only status and wake.
    const asleep = await mcp.toolNames();
    expect(toolFor(asleep, 'get_status')).toBeTruthy();
    expect(toolFor(asleep, 'send_message')).toBeUndefined();
    expect(toolFor(asleep, 'sleep_agent')).toBeUndefined();

    // Wake with a message, which reaches the CLI as the first prompt.
    const woken = await mcp.call(toolFor(asleep, 'wake_agent')!, { message: 'first prompt from dispatcher' });
    expect(woken.isError).toBe(false);
    expect(woken.body).toMatchObject({ status: 'running', messageDelivered: true });
    await expect.poll(async () => {
      const report = await fakes!.report('claude').catch(() => undefined);
      return report?.env.CLUBHOUSE_AGENT_ID === ORCHESTRATOR_ID && JSON.stringify(report.unexpected).includes('first prompt from dispatcher');
    }, { timeout: 20_000 }).toBe(true);

    // Awake: sleep_agent instead of wake_agent.
    const awake = await mcp.toolNames();
    expect(toolFor(awake, 'wake_agent')).toBeUndefined();
    const sleepTool = toolFor(awake, 'sleep_agent')!;
    expect(sleepTool).toBeTruthy();

    // The fake never answers, so it is mid-turn: refused without force.
    const refused = await mcp.call(sleepTool);
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ status: 'refused', reason: 'mid_turn' });
    expect((await mcp.call(toolFor(awake, 'get_status')!)).body.running).toBe(true);

    const slept = await mcp.call(sleepTool, { force: true });
    expect(slept.body.status).toBe('sleeping');
    expect((await mcp.call(toolFor(awake, 'get_status')!)).body.running).toBe(false);
    expect(toolFor(await mcp.toolNames(), 'wake_agent')).toBeTruthy();
  } finally {
    await fs.promises.rm(fixtureDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
