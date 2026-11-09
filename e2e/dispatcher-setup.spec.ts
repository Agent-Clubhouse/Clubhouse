import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';

/**
 * The Dispatcher's first-run setup (#3047) over a fake `claude`, so no tokens
 * are spent:
 * - a new install: opening its view shows setup's three steps beside a live
 *   preview; Try it out runs one headless prompt on the fake CLI and shows its
 *   reply, with no agent started and no Clubhouse MCP; Finish saves the name,
 *   Behavior and personality, and the chat's instructions carry them;
 * - Set up later keeps the defaults, saves nothing else, and the chat offers
 *   setup again, also after a restart;
 * - an upgrade: an existing Dispatcher sees setup once, prefilled with its
 *   name and provider and the note that it now remembers things.
 *
 * Runs in the Chat E2E job (Linux and Windows), like dispatcher.spec.ts.
 */

const USER_DATA_FILES = {
  // The provider is installed (the fake), so no first-run CLI probe.
  'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
  'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
};
/** What test/chat-fixtures/claude/headless-answer.jsonl answers. */
const REPLY = 'Hi there! I keep an eye on your agents, get work going across your projects, and remember what we decide.';

let fakes: FakeClis | undefined;
let profile: DisposableProfile | undefined;
let app: LaunchedApp | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
  await fakes?.cleanup();
  fakes = undefined;
});

async function launch(): Promise<Page> {
  app = await launchApp({ profile, experimental: { chat: true }, userDataFiles: USER_DATA_FILES, env: fakes!.env });
  return app.window;
}

async function relaunch(): Promise<Page> {
  await app?.electronApp.close().catch(() => {});
  return launch();
}

const baseDir = () => path.join(profile!.userDataDir, '.clubhouse-dev');

async function readJson<T>(file: string): Promise<T | null> {
  return fs.existsSync(file) ? JSON.parse(await fs.promises.readFile(file, 'utf8')) as T : null;
}

const dispatcherSettings = () => readJson<Record<string, unknown>>(path.join(profile!.userDataDir, 'dispatcher-settings.json'));
const chatConfigs = async () => (await readJson<Array<{ id: string; name: string }>>(path.join(baseDir(), 'dispatcher-chat', '.clubhouse', 'agents.json'))) ?? [];

async function openDispatcher(w: Page): Promise<void> {
  const row = w.locator('[data-testid="dispatcher-row"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[role="treeitem"]').click();
  await expect(w.locator('[data-testid="dispatcher-view"]')).toBeVisible();
}

test('a new install: three steps, Try it out on the fake CLI with no agent, then Finish', async () => {
  fakes = await installFakeClis({ claude: 'headless-answer' });
  profile = createDisposableProfile({ label: 'dispatcher-setup-new' });
  const w = await launch();
  await openDispatcher(w);

  const setup = w.locator('[data-testid="dispatcher-setup"]');
  await expect(setup).toHaveAttribute('data-step', 'look');
  await expect(w.locator('[data-testid="dispatcher-setup-upgrade-note"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="wake-button"]')).toHaveCount(0);
  // A new install has written nothing for setup yet.
  expect((await dispatcherSettings())?.setup).toBeUndefined();

  // 1. Name and look, with the preview following.
  await w.locator('[data-testid="dispatcher-setup-name"]').fill('Rosie');
  await w.locator('[data-testid="dispatcher-setup-color-rose"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup-preview-name"]')).toHaveText('Rosie');
  await w.locator('[data-testid="dispatcher-setup-next"]').click();

  // 2. Behavior and Runs on.
  await expect(setup).toHaveAttribute('data-step', 'behavior');
  await w.locator('[data-testid="dispatcher-setup-behavior-thorough"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup-provider"]')).toHaveValue('claude-code');
  await w.locator('[data-testid="dispatcher-setup-next"]').click();

  // 3. Personality: a preset fills the text, and Try it out shows the fake CLI's reply.
  await expect(setup).toHaveAttribute('data-step', 'personality');
  await w.locator('[data-testid="dispatcher-setup-preset-friendly"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup-personality-text"]')).toHaveValue(/warm and upbeat/);
  await w.locator('[data-testid="dispatcher-setup-try"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup-reply"]')).toHaveText(REPLY, { timeout: 30_000 });

  // The one-off run: a headless prompt with the name and personality, outside any agent and its MCP.
  const report = await fakes.report('claude');
  expect(report.argv).toContain('-p');
  const prompt = report.argv[report.argv.indexOf('-p') + 1];
  expect(prompt).toContain('You are Rosie');
  expect(prompt).toContain('warm and upbeat');
  expect(report.env.CLUBHOUSE_AGENT_ID).toBeNull();
  expect(report.env.CLUBHOUSE_MCP_PORT).toBeNull();

  await w.locator('[data-testid="dispatcher-setup-finish"]').click();
  await expect(setup).toHaveCount(0);
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]')).toBeVisible();
  await expect(w.locator('[data-testid="dispatcher-setup-offer"]')).toHaveCount(0);

  await expect.poll(async () => (await dispatcherSettings())?.setup).toMatchObject({ status: 'done', upgrade: false });
  const saved = await dispatcherSettings();
  expect(saved).toMatchObject({ behavior: 'thorough', personality: { preset: 'friendly' } });
  await expect.poll(async () => (await chatConfigs())[0]?.name).toBe('Rosie');
  await expect.poll(async () => fs.promises.readFile(path.join(baseDir(), 'dispatcher-chat', 'CLAUDE.md'), 'utf8').catch(() => ''))
    .toContain('Your name is Rosie.');
  expect(await fs.promises.readFile(path.join(baseDir(), 'dispatcher-chat', 'CLAUDE.md'), 'utf8')).toContain('warm and upbeat');
});

test('Set up later keeps the defaults, and the chat offers setup again after a restart', async () => {
  fakes = await installFakeClis({ claude: 'headless-answer' });
  profile = createDisposableProfile({ label: 'dispatcher-setup-later' });
  let w = await launch();
  await openDispatcher(w);

  await w.locator('[data-testid="dispatcher-setup-later"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]')).toBeVisible();
  await expect(w.locator('[data-testid="dispatcher-setup-offer"]')).toContainText('Dispatcher is using the default');

  // The default name, Standard and Concise: nothing but the choice itself is saved.
  await expect.poll(async () => (await dispatcherSettings())?.setup).toMatchObject({ status: 'later' });
  const saved = await dispatcherSettings();
  expect(saved?.behavior).toBeUndefined();
  expect(saved?.personality).toBeUndefined();
  expect((await chatConfigs())[0]?.name).toBe('Dispatcher');
  expect(await fs.promises.readFile(path.join(baseDir(), 'dispatcher-chat', 'CLAUDE.md'), 'utf8')).toContain('Be short and direct.');

  w = await relaunch();
  await openDispatcher(w);
  await expect(w.locator('[data-testid="dispatcher-setup"]')).toHaveCount(0);
  await w.locator('[data-testid="dispatcher-setup-offer-open"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup"]')).toBeVisible();
  await expect(w.locator('[data-testid="dispatcher-setup-later"]')).toHaveText('Cancel');
});

test('an upgrade sees setup once, prefilled with its name and provider, and the note that it remembers', async () => {
  fakes = await installFakeClis({ claude: 'headless-answer' });
  profile = createDisposableProfile({ label: 'dispatcher-setup-upgrade' });
  // A Dispatcher from before setup: its agent is there, with no marker that Clubhouse created it with setup.
  const folder = path.join(baseDir(), 'dispatcher', '.clubhouse');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'agents.json'), JSON.stringify([{
    id: 'durable_old_dispatcher', name: 'Rosie', color: 'rose', createdAt: '2026-10-01T00:00:00.000Z',
    orchestrator: 'claude-code', runtimeMode: 'chat', idleSleep: 'never', freeAgentMode: true,
  }]));

  let w = await launch();
  await openDispatcher(w);
  await expect(w.locator('[data-testid="dispatcher-setup-upgrade-note"]')).toHaveText('Rosie now remembers what you decide and who is doing what.');
  await expect(w.locator('[data-testid="dispatcher-setup-name"]')).toHaveValue('Rosie');
  await w.locator('[data-testid="dispatcher-setup-next"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup-provider"]')).toHaveValue('claude-code');
  await w.locator('[data-testid="dispatcher-setup-later"]').click();
  await expect(w.locator('[data-testid="dispatcher-setup"]')).toHaveCount(0);
  await expect.poll(async () => (await dispatcherSettings())?.setup).toMatchObject({ status: 'later', upgrade: true });

  // Once: after a restart its view opens on the chat.
  w = await relaunch();
  await openDispatcher(w);
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]')).toBeVisible();
  await expect(w.locator('[data-testid="dispatcher-setup"]')).toHaveCount(0);
});
