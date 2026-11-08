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
 * - on by default in the new layout: one Dispatcher folder, its row and view,
 *   and the CLI never starts for it;
 * - a saved experimental false: no row or folder, Settings > Dispatcher still
 *   there saying why;
 * - an old Clubhouse MCP off setting is ignored: the Clubhouse MCP always runs,
 *   so the Dispatcher is on and the bridge is up;
 * - an orchestrator connects by default, Connect to Dispatcher removes and
 *   adds the wire live, and it survives a restart;
 * - turning its switch off stops it and drops its row and wires, keeps its
 *   folder, and it comes back with the same id;
 * - the Dispatcher wakes a connected agent with a message over MCP, and can't
 *   sleep it mid-turn without force;
 * - an Ask-first call (#2970): the Dispatcher's change to helper presets waits
 *   in Needs you, the user allows it there, and the same call then goes through
 *   once.
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
  const callText = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    return { isError: !!result.isError, text: result.content[0].text as string };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await callText(name, args);
    return { isError, body: JSON.parse(text) };
  };
  return { toolNames, call, callText };
}

async function launch(experimental: Record<string, boolean> = {}, files: Record<string, unknown> = {}): Promise<LaunchedApp> {
  app = await launchApp({
    profile,
    experimental: { chat: true, ...experimental },
    userDataFiles: { ...USER_DATA_FILES, ...files },
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

/** The chat the user talks to as the Dispatcher (#3036), in its own folder beside the Dispatcher's. */
async function chatConfigs(): Promise<Array<{ id: string; name: string }>> {
  const file = path.join(profile!.userDataDir, '.clubhouse-dev', 'dispatcher-chat', '.clubhouse', 'agents.json');
  return fs.existsSync(file) ? JSON.parse(await fs.promises.readFile(file, 'utf8')) : [];
}

/** The id the fake CLI last started with: each start rewrites its report. */
async function startedAs(): Promise<string | null | undefined> {
  return (await fakes!.report('claude').catch(() => undefined))?.env.CLUBHOUSE_AGENT_ID;
}

/**
 * Start the Dispatcher as a user does (#3036): wake its chat from its view,
 * then the chat hands a request over with start_work, which starts the agent
 * that holds its grants and wires. Returns an MCP client as that agent.
 */
async function startDispatcher(w: Page, dispatcherId: string) {
  await expect.poll(async () => (await chatConfigs()).length).toBe(1);
  const chatId = (await chatConfigs())[0].id;
  expect(chatId).not.toBe(dispatcherId);
  await rowItem(w).click();
  await expect(w.locator('[data-testid="dispatcher-view"]')).toHaveAttribute('data-agent-id', chatId);
  await w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect.poll(startedAs, { timeout: 20_000 }).toBe(chatId);
  const chat = await connectMcp((await fakes!.report('claude')).env);
  const chatTools = await chat.toolNames();
  expect(chatTools).toContain('start_work');
  expect(chatTools).not.toContain('create_action');
  expect(chatTools.some((n) => n.endsWith('__wake_agent'))).toBe(false);
  const handed = await chat.callText('start_work', { request: 'check in on everyone' });
  expect(handed.isError).toBe(false);
  await expect.poll(startedAs, { timeout: 20_000 }).toBe(dispatcherId);
  return { chatId, mcp: await connectMcp((await fakes!.report('claude')).env) };
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

/** Prompts the CLI got. Nothing has started it while this is 0. */
const promptsConsumed = async (): Promise<number> => (await fakes!.report('claude').catch(() => undefined))?.consumed ?? 0;

test('a saved experimental false: no row or Connect switch, and its page says it can be turned on', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-off' });
  projectDir = makeProject();
  const { electronApp, window: w } = await launch({ dispatcher: false });

  await addProject(electronApp, w, projectDir);
  await openOrchestrateCard(w);
  await expect(w.locator('[data-testid="orchestrate-dispatcher"]')).toHaveCount(0);
  await expect(row(w)).toHaveCount(0);
  expect(fs.existsSync(dispatcherDir())).toBe(false);

  await openSettingsPage(w, 'Dispatcher');
  const enabled = w.locator('[data-testid="dispatcher-enabled"]');
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  // The switch beats the old flag once it's used.
  await enabled.click();
  await expect(row(w)).toBeVisible();
  await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
});

test('an old Clubhouse MCP off setting is ignored: the Dispatcher is on and the bridge is up', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-mcp-always-on' });
  const w = (await launch({}, { 'mcp-settings.json': { enabled: false } })).window;

  await expect(row(w)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
  // The bridge and these handlers start together, whatever the old file says.
  expect(await w.evaluate(() => window.clubhouse.mcpBinding.getBindings().then(() => 'up', () => 'down'))).toBe('up');

  await openSettingsPage(w, 'Dispatcher');
  const enabled = w.locator('[data-testid="dispatcher-enabled"]');
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await expect(enabled).not.toBeDisabled();
  await expect(w.locator('#dispatcher-enabled-help')).not.toContainText('Clubhouse MCP');
  expect(await promptsConsumed()).toBe(0);
});

test('on by default, wire an orchestrator, restart, switch off and on, and wake it', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-on' });
  projectDir = makeProject();
  let w = (await launch()).window;

  // One Dispatcher with its memory and its CLI's instructions file, and its row
  // with zero projects, and nothing started.
  await expect(row(w)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
  const [config] = await dispatcherConfigs();
  const dispatcherId = config.id;
  // Known by its folder and id, never a persona (#2901): the only agent in its folder, with no persona.
  expect(config.persona).toBeUndefined();
  expect(fs.existsSync(path.join(dispatcherDir(), 'memory', 'index.md'))).toBe(true);
  const instructions = await fs.promises.readFile(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf8');
  expect(instructions).toContain('Dispatcher');
  // Its memory index is loaded into the instructions file (#3038).
  expect(instructions).toContain('## Your memory index');
  expect(await promptsConsumed()).toBe(0);

  // Off and on again keeps the one Dispatcher.
  await openSettingsPage(w, 'Dispatcher');
  const enabled = w.locator('[data-testid="dispatcher-enabled"]');
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
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
  w = (await launch()).window;
  await expect(row(w)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => hasWire(w, dispatcherId), { timeout: 15_000 }).toBe(true);

  // Turning the setting off drops the row and wires and keeps the folder and its memory.
  fs.writeFileSync(path.join(dispatcherDir(), 'memory', 'topics', 'plan.md'), 'kept\n');
  // An old notes/ folder, as the agent kept before memory (#3038).
  fs.mkdirSync(path.join(dispatcherDir(), 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dispatcherDir(), 'notes', 'release.md'), 'old note\n');
  await openSettingsPage(w, 'Dispatcher');
  await w.locator('[data-testid="dispatcher-enabled"]').click();
  await expect(row(w)).toHaveCount(0);
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(false);
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'memory', 'topics', 'plan.md'), 'utf8')).toBe('kept\n');
  await w.locator('[data-testid="dispatcher-enabled"]').click();
  await expect(row(w)).toBeVisible();
  // Turning it on sorts the old notes into memory once and keeps the folder, renamed.
  await expect.poll(() => fs.existsSync(path.join(dispatcherDir(), 'notes'))).toBe(false);
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'notes-archive', 'release.md'), 'utf8')).toBe('old note\n');
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'memory', 'topics', 'release.md'), 'utf8')).toMatch(/old note\n$/);
  expect(await fs.promises.readFile(path.join(dispatcherDir(), 'memory', 'topics', 'plan.md'), 'utf8')).toBe('kept\n');
  expect(await dispatcherIds()).toEqual([dispatcherId]);
  await expect.poll(() => hasWire(w, dispatcherId)).toBe(true);

  // Start it from its view.
  await closeSettings(w);
  await rowItem(w).click();
  await w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect.poll(promptsConsumed, { timeout: 20_000 }).toBeGreaterThan(0);
  // Waking it from its view keeps the view, with its chat, and no project in the title (#2563).
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="title-bar"]')).toContainText('Dispatcher');
  await expect(w.locator('[data-testid="title-bar"]')).not.toContainText('dispatcher-e2e-');
});

test('the Dispatcher wakes a connected agent with a message and sleeps it again', async () => {
  projectDir = makeProject();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-e2e-fixture-'));
  try {
    fakes = await installFakeClis({ claude: await writeQuietFixture(fixtureDir) });
    profile = createDisposableProfile({ label: 'dispatcher-wake' });
    const w = (await launch()).window;

    await expect(row(w)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
    const dispatcherId = (await dispatcherConfigs())[0].id;

    await addProject(app!.electronApp, w, projectDir);
    // An orchestrator is connected by default (#2578).
    await openOrchestrateCard(w);
    await expect(w.locator('[data-testid="orchestrate-dispatcher"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => hasWire(w, dispatcherId)).toBe(true);

    // Start the Dispatcher. The fake reports the bridge credentials it was given.
    const { mcp } = await startDispatcher(w, dispatcherId);

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

test('an Ask-first call waits in Needs you, and goes through once the user allows it (#2970)', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-e2e-fixture-'));
  try {
    fakes = await installFakeClis({ claude: await writeQuietFixture(fixtureDir) });
    profile = createDisposableProfile({ label: 'dispatcher-ask-first' });
    const w = (await launch()).window;

    await expect(row(w)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await dispatcherConfigs()).length).toBe(1);
    const dispatcherId = (await dispatcherConfigs())[0].id;

    const { chatId, mcp } = await startDispatcher(w, dispatcherId);

    // Changing app settings is Ask first for the Dispatcher: the tool is offered, and the call asks.
    expect(await mcp.toolNames()).toContain('set_helper_presets');
    const { revision } = (await mcp.call('read_helper_presets')).body;
    const args = { revision, reset: {} };
    const asked = await mcp.callText('set_helper_presets', args);
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain('needs the user\'s approval');

    // It waits in Needs you, on the Dispatcher's own row; selecting it opens the request, and the user allows it.
    await expect(w.locator(`[data-testid="needs-you-row-${dispatcherId}"]`)).toHaveCount(0);
    const needsRow = w.locator(`[data-testid="needs-you-row-${chatId}"]`);
    await expect(needsRow).toBeVisible({ timeout: 10_000 });
    await expect(needsRow).toContainText('Asks to make a call');
    await needsRow.click();
    const dialog = w.locator('[data-testid="grant-request-dialog"]');
    await expect(dialog).toContainText('set_helper_presets');
    await dialog.locator('[data-testid="grant-request-allow"]').click();
    await expect(dialog).toBeHidden();
    await expect(needsRow).toBeHidden();

    // The same call now goes through, once.
    const done = await mcp.call('set_helper_presets', args);
    expect(done.isError).toBe(false);
    expect(done.body).toMatchObject({ ok: true });
    expect((await mcp.callText('set_helper_presets', { revision: done.body.revision, reset: {} })).text).toContain('needs the user\'s approval');
  } finally {
    await fs.promises.rm(fixtureDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
