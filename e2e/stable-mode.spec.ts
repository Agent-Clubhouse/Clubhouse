import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, seedProfile, type DisposableProfile } from './app-profile';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';
import {
  AGENT_ID,
  ANNEX_PAGES,
    BETA_FLAGS,
  BETA_TRANSCRIPT,
  CHAT_MESSAGE_SHOWN_KEY,
  CHAT_TIP_RULED_OUT_KEY,
  CHROME_STORAGE_KEY,
  LAST_SESSION,
  ORCHESTRATOR,
  PREVIEW_ONLY_FLAGS,
  PREVIEW_PAGES,
  SAVED_SIDEBAR_WIDTH,
  UNTOUCHED_FILES,
  V041_FLAGS,
  betaAgents,
  betaFiles,
  stableAgents,
  stableFiles,
  updateSettings,
  v041Agents,
} from './stable-state-seeds.mjs';

/**
 * Stable mode end to end: Preview off and on, with no saved flags and with the
 * saved state a beta leaves behind.
 *
 * E2E can't run a packaged stable build, since `isPreviewEligible` is always true
 * unpackaged. CLUBHOUSE_TEST_STABLE_BUILD, honoured only there, makes this build
 * follow the Preview opt-in instead. So this proves the gates and what they keep,
 * not a packaged build. No CLI runs here except the idle stand-in below, which
 * spends nothing.
 */

const STABLE_BUILD = { CLUBHOUSE_TEST_STABLE_BUILD: '1' };

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
    // Windows: a process that was just killed can hold its files for a moment.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Stands in for `claude`: answers --version, records its arguments, and stays
 * alive as a terminal agent would. The other providers point at nothing, so a
 * real CLI can never be reached.
 */
function installIdleCli(): { env: Record<string, string>; argvFile: string } {
  const root = tempDir('clubhouse-e2e-idle-cli-');
  const argvFile = path.join(root, 'argv.json');
  const script = path.join(root, 'idle-cli.js');
  fs.writeFileSync(script, [
    "if (process.argv.includes('--version')) { console.log('2.1.316 (Claude Code)'); process.exit(0); }",
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  let shim: string;
  if (process.platform === 'win32') {
    shim = path.join(root, 'claude.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    shim = path.join(root, 'claude');
    fs.writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  }
  return {
    argvFile,
    env: {
      CLUBHOUSE_TEST_CLI_BINARIES: JSON.stringify({
        [ORCHESTRATOR]: shim,
        'codex-cli': path.join(root, 'not-installed', 'codex'),
        'copilot-cli': path.join(root, 'not-installed', 'copilot'),
      }),
      CLUBHOUSE_TEST_NO_MODEL_PROBES: '1',
      CLUBHOUSE_TEST_NO_CARD_REQUESTS: '1',
    },
  };
}

/** A repo with agents, by default one saved in Chat mode with a session to resume. */
function makeProject(agents: unknown[] = betaAgents()): string {
  const dir = tempDir('clubhouse-e2e-stable-project-');
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify(agents));
  fs.writeFileSync(path.join(dir, 'README.md'), '# stable mode e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

function seedTranscript(target: DisposableProfile): void {
  const file = path.join(target.userDataDir, 'agent-logs', 'chat', AGENT_ID, `${LAST_SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, BETA_TRANSCRIPT);
}

const readText = (file: string) => fs.promises.readFile(file, 'utf8');

async function readUntouched(target: DisposableProfile): Promise<Record<string, string>> {
  const contents = await Promise.all(UNTOUCHED_FILES.map((name) => readText(path.join(target.userDataDir, name))));
  return Object.fromEntries(UNTOUCHED_FILES.map((name, i) => [name, contents[i]]));
}

async function savedPreview(target: DisposableProfile): Promise<boolean> {
  return JSON.parse(await readText(path.join(target.userDataDir, 'update-settings.json'))).previewChannel;
}

function dispatcherFolder(target: DisposableProfile): string {
  return path.join(target.userDataDir, '.clubhouse-dev', 'dispatcher');
}

const eligible = (w: Page) => w.evaluate(() => window.clubhouse.app.isPreviewEligible());
const flagsInForce = (w: Page) => w.evaluate(() => window.clubhouse.app.getExperimentalSettings());

/** The runtime this agent would wake into, as main decides it. */
const wakesInChat = (w: Page, projectPath: string, id = AGENT_ID) => w.evaluate(
  async ({ id, orchestrator, projectPath }) => (await window.clubhouse.chat.getAgentRuntime(id, orchestrator, { projectPath, starting: true })).chat,
  { id, orchestrator: ORCHESTRATOR, projectPath },
);

/** The one-time Chat tip's markers, once this launch has decided. */
const chatMessageShown = (w: Page) => w.evaluate((key) => localStorage.getItem(key), CHAT_MESSAGE_SHOWN_KEY);
const chatTipRuledOut = (w: Page) => w.evaluate((key) => localStorage.getItem(key), CHAT_TIP_RULED_OUT_KEY);

async function expectNewLayout(w: Page): Promise<void> {
  await expect(w.locator('[data-testid="chrome-title-bar"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toBeVisible();
}

const settingsNav = (w: Page, label: string) => w.getByRole('button', { name: label, exact: true });

/** Open Settings, check which of the Preview pages it lists, and close it again. The Annex pages are always listed (#2811). */
async function expectSettingsPages(w: Page, listed: string[]): Promise<void> {
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(settingsNav(w, 'Updates')).toBeVisible({ timeout: 10_000 });
  for (const label of [...ANNEX_PAGES, ...listed]) await expect(settingsNav(w, label)).toBeVisible({ timeout: 15_000 });
  // The Preview pages appear once the eligibility answer arrives, so give a wrong one time to show.
  await w.waitForTimeout(1_000);
  for (const label of PREVIEW_PAGES.filter((page) => !listed.includes(page))) {
    await expect(settingsNav(w, label)).toHaveCount(0);
  }
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(settingsNav(w, 'Updates')).toBeHidden();
}

test('Preview off, fresh install: the new layout, and turning Preview on is the only way in', async () => {
  profile = createDisposableProfile({ label: 'stable-fresh' });
  app = await launchApp({ preserveFirstLoad: true, profile, env: STABLE_BUILD });
  const w = app.window;

  expect(await eligible(w)).toBe(false);
  await expectNewLayout(w);
  expect(await flagsInForce(w)).toEqual({});
  await expectSettingsPages(w, []);

  // The opt-in itself: the pages follow the switch at once, and it saves only that.
  await w.locator('[data-testid="nav-settings"]').click();
  await settingsNav(w, 'Updates').click();
  const preview = w.getByRole('switch', { name: 'Preview versions' });
  await expect(preview).toHaveAttribute('aria-checked', 'false');
  await preview.click();
  await expect(preview).toHaveAttribute('aria-checked', 'true');
  await expect(settingsNav(w, 'Experimental')).toBeVisible({ timeout: 10_000 });
  await expect(settingsNav(w, 'Annex Network')).toBeVisible();
  expect(await eligible(w)).toBe(true);
  await expect.poll(() => savedPreview(profile!)).toBe(true);

  await preview.click();
  await expect(preview).toHaveAttribute('aria-checked', 'false');
  await expect(settingsNav(w, 'Experimental')).toHaveCount(0, { timeout: 10_000 });
  await expect(settingsNav(w, 'Annex Network')).toBeVisible();
  expect(await eligible(w)).toBe(false);
  await expect.poll(() => savedPreview(profile!)).toBe(false);
});

test('Preview off, saved beta state with Chat off: the new layout, a terminal, and nothing saved changes', async () => {
  const cli = installIdleCli();
  const projectDir = makeProject();
  profile = createDisposableProfile({ label: 'stable-beta-state' });
  seedTranscript(profile);
  seedProfile(profile, { experimental: { ...BETA_FLAGS, chat: false }, userDataFiles: betaFiles(false) });
  const seeded = await readUntouched(profile);
  app = await launchApp({ preserveFirstLoad: true, profile, env: { ...STABLE_BUILD, ...cli.env } });
  const { electronApp, window: w } = app;

  expect(await eligible(w)).toBe(false);
  await expectNewLayout(w);
  const flags = await flagsInForce(w);
  for (const flag of PREVIEW_ONLY_FLAGS) expect(flags).not.toHaveProperty(flag);
  await expectSettingsPages(w, []);
  // Preview doesn't gate the Dispatcher, and nothing starts it.
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });

  // A saved false outranks the agent's own Chat mode: it wakes in the terminal, on the session it had.
  await addProject(electronApp, w, projectDir);
  expect(await wakesInChat(w, projectDir)).toBe(false);
  await w.locator('[data-testid^="sleeping-fold-"]').first().click();
  await w.locator(`[data-testid="agent-item-${AGENT_ID}"]`).click();
  await w.locator('[data-testid="wake-button"]').click();
  await expect(w.locator('[data-testid="agent-terminal"]')).toBeVisible({ timeout: 20_000 });
  await expect(w.locator('[data-testid="chat-view"]')).toHaveCount(0);

  await expect.poll(() => fs.existsSync(cli.argvFile), { timeout: 20_000 }).toBe(true);
  const argv: string[] = JSON.parse(await readText(cli.argvFile));
  expect(argv).toContain(LAST_SESSION);
  expect(argv).not.toContain('stream-json');

  await electronApp.close();
  app = undefined;

  expect(await readUntouched(profile)).toEqual(seeded);
  expect(await savedPreview(profile)).toBe(false);
  const agents = JSON.parse(await readText(path.join(projectDir, '.clubhouse', 'agents.json')));
  expect(agents.find((a: { id: string }) => a.id === AGENT_ID).runtimeMode).toBe('chat');
  // The switch saved on is honoured: it has a record and a row, and nothing started it.
  expect(fs.existsSync(path.join(dispatcherFolder(profile), '.clubhouse', 'agents.json'))).toBe(true);
  // The dormant telemetry setup was switched off, consent kept, and the developer destination can't follow Feedback on.
  const telemetry = JSON.parse(await readText(path.join(profile.userDataDir, 'telemetry-settings.json')));
  expect(telemetry).toMatchObject({ consentVersion: 1, exportGraduation: 1 });
  expect(telemetry.destinations.filter((d: { enabled: boolean }) => d.enabled)).toEqual([]);
  expect(telemetry.destinations.find((d: { id: string }) => d.id === 'framebriar').framebriar.userOff).toBe(true);
});

test('Preview on, no saved flags: the new layout with the Preview pages to opt in from', async () => {
  profile = createDisposableProfile({ label: 'stable-preview-on' });
  app = await launchApp({ preserveFirstLoad: true, profile, userDataFiles: updateSettings(true), env: STABLE_BUILD });
  const w = app.window;

  expect(await eligible(w)).toBe(true);
  await expectNewLayout(w);
  expect(await flagsInForce(w)).toEqual({});
  await expectSettingsPages(w, ['Experimental']);
});

test('Preview off, fresh install: Chat is on, no tip, and a saved agent choice wins', async () => {
  const cli = installIdleCli();
  profile = createDisposableProfile({ label: 'stable-chat-fresh' });
  app = await launchApp({ preserveFirstLoad: true, profile, userDataFiles: stableFiles(), env: { ...STABLE_BUILD, ...cli.env } });
  const { electronApp, window: w } = app;

  expect(await eligible(w)).toBe(false);
  expect(await flagsInForce(w)).toEqual({});
  // Ruled out by having no agents, so agents added from now on don't bring it back.
  await expect.poll(() => chatTipRuledOut(w)).toBe('no_chat_agents');

  const overrideId = 'durable_stable_mode_cli';
  const projectDir = makeProject([...stableAgents(), ...stableAgents({ id: overrideId, name: 'stable-mode-cli', runtimeMode: 'terminal' })]);
  await addProject(electronApp, w, projectDir);
  expect(await wakesInChat(w, projectDir)).toBe(true);
  expect(await wakesInChat(w, projectDir, overrideId)).toBe(false);

  await w.locator('[data-testid^="sleeping-fold-"]').first().click();
  await w.locator(`[data-testid="agent-item-${overrideId}"]`).click();
  await w.locator('[data-testid="wake-button"]').click();
  await expect(w.locator('[data-testid="agent-terminal"]')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fs.existsSync(cli.argvFile), { timeout: 20_000 }).toBe(true);
  expect(JSON.parse(await readText(cli.argvFile))).not.toContain('stream-json');
});

for (const seed of [
  { from: '0.42', flags: undefined, agents: stableAgents },
  { from: '0.41', flags: V041_FLAGS, agents: v041Agents },
]) {
  test(`Preview off, upgrade from ${seed.from}: agents open in Chat and the tip shows`, async () => {
    const cli = installIdleCli();
    const projectDir = makeProject(seed.agents());
    profile = createDisposableProfile({ label: `stable-chat-${seed.from}` });
    // Registered before launch, so the first launch finds the agent as an upgrade would.
    seedProfile(profile, { experimental: seed.flags, userDataFiles: stableFiles() });
    const baseDir = path.join(profile.userDataDir, '.clubhouse-dev');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'proj_stable_mode', name: 'stable', path: projectDir }] }));
    app = await launchApp({ preserveFirstLoad: true, profile, env: { ...STABLE_BUILD, ...cli.env } });
    const w = app.window;

    expect(await eligible(w)).toBe(false);
    await expect.poll(() => chatMessageShown(w)).toBe('true');
    expect(await wakesInChat(w, projectDir)).toBe(true);
    const flags = await flagsInForce(w);
    expect(flags).not.toHaveProperty('chat');
    expect(flags).not.toHaveProperty('structuredMode');
  });
}

test('Preview off, saved Chat off: Agents & providers turns it back on', async () => {
  const cli = installIdleCli();
  const projectDir = makeProject(stableAgents());
  profile = createDisposableProfile({ label: 'stable-chat-off' });
  app = await launchApp({ preserveFirstLoad: true, profile, experimental: { chat: false }, userDataFiles: stableFiles(), env: { ...STABLE_BUILD, ...cli.env } });
  const { electronApp, window: w } = app;

  await addProject(electronApp, w, projectDir);
  expect(await wakesInChat(w, projectDir)).toBe(false);
  // The Dispatcher follows the same switch, whatever it has saved for itself.
  const dispatcherFile = path.join(dispatcherFolder(profile), '.clubhouse', 'agents.json');
  await expect.poll(() => fs.existsSync(dispatcherFile), { timeout: 15_000 }).toBe(true);
  const [{ id: dispatcherId }] = JSON.parse(await readText(dispatcherFile));
  expect(await wakesInChat(w, dispatcherFolder(profile), dispatcherId)).toBe(false);

  await w.locator('[data-testid="nav-settings"]').click();
  await settingsNav(w, 'Agents & providers').click();
  const chatView = w.getByRole('switch', { name: 'Chat view' });
  await expect(chatView).toHaveAttribute('aria-checked', 'false');
  await chatView.click();
  await expect(chatView).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => wakesInChat(w, projectDir)).toBe(true);
  expect(await wakesInChat(w, dispatcherFolder(profile), dispatcherId)).toBe(true);
});

test('Preview off: the Dispatcher wakes in chat', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'stable-dispatcher-chat' });
  // Stream-json, which the fixtures speak.
  const userDataFiles = { ...stableFiles(), 'chat-runtime-settings.json': { [ORCHESTRATOR]: { mode: 'chat', driver: 'claude_stream_json' } } };
  app = await launchApp({ preserveFirstLoad: true, profile, userDataFiles, env: { ...STABLE_BUILD, ...fakes.env } });
  const w = app.window;

  expect(await eligible(w)).toBe(false);
  await w.locator('[data-testid="dispatcher-row"] [role="treeitem"]').click();
  await w.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect(w.locator('[data-testid="dispatcher-view"] [data-testid="chat-view"]')).toBeVisible({ timeout: 20_000 });
});

test('saved beta state survives Preview on, then off, then on', async () => {
  const cli = installIdleCli();
  const projectDir = makeProject();
  profile = createDisposableProfile({ label: 'stable-roundtrip' });
  seedTranscript(profile);
  const env = { ...STABLE_BUILD, ...cli.env };

  // Preview on: everything saved is in force, including a Dispatcher it creates.
  app = await launchApp({ preserveFirstLoad: true, profile, experimental: BETA_FLAGS, userDataFiles: betaFiles(true), env });
  let w = app.window;
  expect(await eligible(w)).toBe(true);
  await expectNewLayout(w);
  expect(await flagsInForce(w)).toEqual(BETA_FLAGS);
  await addProject(app.electronApp, w, projectDir);
  await expectSettingsPages(w, PREVIEW_PAGES);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  expect(await wakesInChat(w, projectDir)).toBe(true);
  // A beta user chose Chat, so there's nothing to tell them.
  await expect.poll(() => chatTipRuledOut(w)).toBe('saved_choice');
  // A saved layout. The store's own writes have settled, and nothing writes it again on the way out.
  await w.waitForTimeout(1_000);
  await w.evaluate(({ key, width }) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...saved, sidebarWidth: width }));
  }, { key: CHROME_STORAGE_KEY, width: SAVED_SIDEBAR_WIDTH });
  await app.electronApp.close();
  const savedFiles = [
    path.join(profile.userDataDir, 'experimental-settings.json'),
    path.join(profile.userDataDir, 'dispatcher-settings.json'),
    path.join(dispatcherFolder(profile), '.clubhouse', 'agents.json'),
  ];
  const saved = await Promise.all(savedFiles.map(readText));

  const savedLayoutWidth = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').sidebarWidth, CHROME_STORAGE_KEY);

  // Preview off: only the graduated features are in force, the Dispatcher stays, and all of it is still there.
  app = await launchApp({ preserveFirstLoad: true, profile, userDataFiles: updateSettings(false), env });
  w = app.window;
  expect(await eligible(w)).toBe(false);
  await expectNewLayout(w);
  const flags = await flagsInForce(w);
  for (const flag of PREVIEW_ONLY_FLAGS) expect(flags).not.toHaveProperty(flag);
  await expectSettingsPages(w, []);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  expect(await wakesInChat(w, projectDir)).toBe(true);
  expect(await savedLayoutWidth(w)).toBe(SAVED_SIDEBAR_WIDTH);
  await app.electronApp.close();
  expect(await Promise.all(savedFiles.map(readText))).toEqual(saved);

  // Preview on again: everything comes back.
  app = await launchApp({ preserveFirstLoad: true, profile, userDataFiles: updateSettings(true), env });
  w = app.window;
  expect(await eligible(w)).toBe(true);
  await expectNewLayout(w);
  expect(await flagsInForce(w)).toEqual(BETA_FLAGS);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  expect(await wakesInChat(w, projectDir)).toBe(true);
  expect(await savedLayoutWidth(w)).toBe(SAVED_SIDEBAR_WIDTH);
});
