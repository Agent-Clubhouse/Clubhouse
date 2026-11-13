import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { chatFixturePath } from '../src/main/orchestrators/adapters/testing/fake-cli';
import { buildChatScript, writeChatScript } from '../src/main/orchestrators/adapters/testing/chat-script';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { connectMcp } from './mcp-agent';
import { launchApp, type ElectronApp, type LaunchedApp } from './launch';
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
 * - an orchestrator connects by default, the switch on its Dispatcher card
 *   in Details (#3049) removes and adds the wire live, and it survives a
 *   restart (the card's own flows are in dispatcher-card.spec.ts);
 * - turning its switch off stops it and drops its row and wires, keeps its
 *   folder, and it comes back with the same id;
 * - Clear chat (#3043) asks first, then starts its conversation over without
 *   touching memory;
 * - the Dispatcher wakes a connected agent with a message over MCP, and can't
 *   sleep it mid-turn without force;
 * - an Ask-first call (#2970): the Dispatcher's change to helper presets waits
 *   in Needs you, the user allows it there, and the same call then goes through
 *   once.
 * - Pop Out (#3235) opens its chat, the same conversation, in its own window;
 *   a message sent there is answered there, asking again opens no second
 *   window, and Pop back in shows the chat with that exchange in the main
 *   window.
 *
 * Runs in the Chat E2E job (Linux and Windows), not the sharded E2E run:
 * nothing here differs on macOS, and it would lengthen the E2E long pole.
 */

const USER_DATA_FILES = {
  // The provider is installed (the fake), so no first-run CLI probe.
  'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
  'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
  // Set up already, so its view opens on the chat (first-run setup is dispatcher-setup.spec.ts).
  'dispatcher-settings.json': { setup: { status: 'done', upgrade: false } },
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
  await expect(w.getByTestId('orchestration-helpers').first()).toBeVisible();
  await expect(w.getByTestId('details-card-helpers')).toHaveCount(0);
}

/** Show Agent details for the orchestrator and expand its Dispatcher card (#3049). */
async function openDispatcherCard(w: Page): Promise<void> {
  await openOrchestrateCard(w);
  const details = w.locator('[data-testid="agent-details"]');
  if (!(await details.isVisible().catch(() => false))) await w.locator('[data-testid="agent-details-toggle"]').first().click();
  const head = w.locator('[data-testid="details-card-dispatcher-toggle"]');
  await expect(head).toBeVisible({ timeout: 10_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
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
  const details = w.locator('[data-testid="agent-details"]');
  if (!(await details.isVisible().catch(() => false))) await w.locator('[data-testid="agent-details-toggle"]').first().click();
  await expect(details.locator('[data-testid="details-card-orchestrate"]')).toBeVisible();
  await expect(details.getByTestId('details-card-actions')).toBeVisible();
  await expect(w.locator('[data-testid="details-card-dispatcher"]')).toHaveCount(0);
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

  // Connected by default (#2578); the Dispatcher card's switch removes and adds the wire live.
  await openDispatcherCard(w);
  const connect = w.locator('[data-testid="dispatcher-card-switch"]');
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

  // Its composer has one Behavior chip in place of the model and permission pickers (#3045).
  const view = w.locator('[data-testid="dispatcher-view"]');
  const chip = view.locator('[data-testid="dispatcher-behavior-chip"]');
  await expect(chip).toHaveAttribute('data-level', 'standard', { timeout: 15_000 });
  await expect(view.locator('[data-testid="chat-model-pill"]')).toHaveCount(0);
  await expect(view.locator('[data-testid="chat-level-pill"]')).toHaveCount(0);
  // Thorough keeps the chat on the same tier as Standard, so the running chat
  // isn't switched: this fixture replays a strict script with no model change here.
  await chip.click();
  await view.locator('[data-testid="dispatcher-behavior-thorough"]').click();
  await expect(chip).toHaveAttribute('data-level', 'thorough');
  await expect(view.locator('[data-testid="dispatcher-behavior-menu"]')).toHaveCount(0);
  // Settings shows the same choice.
  await openSettingsPage(w, 'Dispatcher');
  await expect(w.locator('[data-testid="dispatcher-behavior"]')).toHaveValue('thorough');

  // Clear chat (#3043) from its menu asks first, starts the conversation over and leaves memory alone.
  await closeSettings(w);
  await rowItem(w).click();
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  const memoryFiles = ['index.md', 'topics/plan.md', 'topics/release.md'].map((f) => path.join(dispatcherDir(), 'memory', f));
  const memoryBefore = await Promise.all(memoryFiles.map((f) => fs.promises.readFile(f, 'utf8')));
  await rowItem(w).click({ button: 'right' });
  await w.locator('[data-testid="agent-context-menu"] [data-testid="ctx-clear-chat"]').click();
  await expect(w.locator('[data-testid="dispatcher-clear-chat-confirm"]')).toBeVisible();
  await w.locator('[data-testid="dispatcher-clear-chat-confirm-button"]').click();
  await expect(w.locator('[data-testid="dispatcher-clear-chat-confirm"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]')).toBeVisible();
  expect(await Promise.all(memoryFiles.map((f) => fs.promises.readFile(f, 'utf8')))).toEqual(memoryBefore);
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
    await openDispatcherCard(w);
    await expect(w.locator('[data-testid="dispatcher-card-switch"]')).toHaveAttribute('aria-checked', 'true');
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
    expect(((await mcp.call(toolFor(awake, 'get_status')!)).body as { running: boolean }).running).toBe(true);

    const slept = await mcp.call(sleepTool, { force: true });
    expect((slept.body as { status: string }).status).toBe('sleeping');
    expect(((await mcp.call(toolFor(awake, 'get_status')!)).body as { running: boolean }).running).toBe(false);
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
    const { revision } = (await mcp.call('read_helper_presets')).body as { revision: number };
    const args = { revision, reset: {} };
    const asked = await mcp.callText('set_helper_presets', args);
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain('needs the user\'s approval');

    // It waits in Needs you, on the Dispatcher's own row; selecting it opens the request, and the user allows it.
    await expect(w.locator(`[data-testid="needs-you-row-${dispatcherId}"]`)).toHaveCount(0);
    const needsRow = w.locator(`[data-testid="needs-you-row-${chatId}"]`);
    await expect(needsRow).toBeVisible({ timeout: 10_000 });
    await expect(needsRow).toContainText('Change app settings');
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
    expect((await mcp.callText('set_helper_presets', { revision: (done.body as { revision: number }).revision, reset: {} })).text).toContain('needs the user\'s approval');
  } finally {
    await fs.promises.rm(fixtureDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/**
 * The popout window the next createPopout opens. Unpackaged builds may open
 * DevTools first, so a window without the popout's root is skipped.
 */
async function nextPopout(electronApp: ElectronApp, open: () => Promise<void>): Promise<Page> {
  const seen = new Set(electronApp.windows());
  const first = electronApp.waitForEvent('window', { predicate: (p) => !seen.has(p), timeout: 15_000 });
  await open();
  let page = await first;
  await page.waitForLoadState('load');
  if (!(await page.locator('[data-testid="popout-window"]').isVisible({ timeout: 5_000 }).catch(() => false))) {
    seen.add(page);
    page = await electronApp.waitForEvent('window', { predicate: (p) => !seen.has(p), timeout: 10_000 });
    await page.waitForLoadState('load');
  }
  return page;
}

test('Pop Out shows its chat in its own window, where the user keeps talking to it (#3235)', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-e2e-fixture-'));
  try {
    const REPLY = 'Hello back from the popped out Dispatcher.';
    const { fixture } = await writeChatScript(fixtureDir, 'popout', buildChatScript('claude', {
      description: 'one exchange with the Dispatcher in its popout',
      turns: [{ prompt: 'Hello from the popout', steps: [{ type: 'text', text: REPLY }] }],
    }));
    fakes = await installFakeClis({ claude: fixture });
    profile = createDisposableProfile({ label: 'dispatcher-popout' });
    const { electronApp, window: w } = await launch();

    await expect(row(w)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await chatConfigs()).length).toBe(1);
    const chatId = (await chatConfigs())[0].id;
    await rowItem(w).click();
    await w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
    await expect.poll(startedAs, { timeout: 20_000 }).toBe(chatId);
    await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]')).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });

    // Pop Out from its row's menu opens the same agent, under no project.
    const popout = await nextPopout(electronApp, async () => {
      await rowItem(w).click({ button: 'right' });
      await w.locator('[data-testid="agent-context-menu"] [data-testid="ctx-popout"]').click();
    });
    await expect(popout.locator('[data-testid="popout-title"]')).toContainText('Dispatcher');
    const popoutChat = popout.locator(`[data-testid="chat-view"][data-agent-pane="${chatId}"][data-view-context="popout"]`);
    await expect(popoutChat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
    // The main window says where it went.
    await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="popped-out-placeholder"]')).toBeVisible();

    // A message from the popout is answered there, by the one running chat.
    const box = popout.getByRole('textbox', { name: 'Message' });
    await box.fill('Hello from the popout');
    await box.press('Enter');
    await expect(popoutChat).toContainText(REPLY, { timeout: 20_000 });
    await expect.poll(async () => {
      const r = await fakes!.report('claude').catch((): undefined => undefined);
      return r && { mismatch: r.mismatch, complete: r.complete, unexpected: r.unexpected };
    }, { timeout: 20_000 }).toEqual({ mismatch: null, complete: true, unexpected: [] });
    expect(await startedAs()).toBe(chatId);

    // Asking again brings that window forward rather than opening another.
    await rowItem(w).click({ button: 'right' });
    await w.locator('[data-testid="agent-context-menu"] [data-testid="ctx-popout"]').click();
    const popouts = await w.evaluate(() => window.clubhouse.window.listPopouts()) as Array<{ params: { agentId?: string } }>;
    expect(popouts.map((p) => p.params.agentId)).toEqual([chatId]);

    // Pop back in closes the window; the main window shows the chat with the exchange, still running.
    await w.locator('[data-testid="popped-out-close-window"]').click();
    await expect(w.locator('[data-testid="popped-out-placeholder"]')).toHaveCount(0, { timeout: 10_000 });
    const mainChat = w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]');
    await expect(mainChat).toContainText(REPLY, { timeout: 15_000 });
    await expect(mainChat).toHaveAttribute('data-state', 'idle');
    expect((await chatConfigs()).map((c) => c.id)).toEqual([chatId]);
  } finally {
    await fs.promises.rm(fixtureDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
