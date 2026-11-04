import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDisposableProfile, seedProfile, type DisposableProfile } from './app-profile';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';
import {
  AGENT_ID,
    BETA_FLAGS,
  BETA_TRANSCRIPT,
  CHROME_STORAGE_KEY,
  LAST_SESSION,
  ORCHESTRATOR,
  PREVIEW_ONLY_FLAGS,
  PREVIEW_PAGES,
  SAVED_SIDEBAR_WIDTH,
  UNTOUCHED_FILES,
  betaAgents,
  betaFiles,
  updateSettings,
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
const tempDirs: string[] = [];

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
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
    },
  };
}

/** A repo with one agent saved in Chat mode, with a session to resume. */
function makeProject(): string {
  const dir = tempDir('clubhouse-e2e-stable-project-');
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify(betaAgents()));
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
const wakesInChat = (w: Page, projectPath: string) => w.evaluate(
  async ({ id, orchestrator, projectPath }) => (await window.clubhouse.chat.getAgentRuntime(id, orchestrator, { projectPath, starting: true })).chat,
  { id: AGENT_ID, orchestrator: ORCHESTRATOR, projectPath },
);

async function expectLegacyLayout(w: Page): Promise<void> {
  await expect(w.locator('[data-testid="title-bar"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="chrome-title-bar"]')).toHaveCount(0);
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toHaveCount(0);
  expect(await w.evaluate(() => (window.clubhouse as { newChromeLayout?: unknown }).newChromeLayout)).toBe(false);
}

async function expectNewLayout(w: Page): Promise<void> {
  await expect(w.locator('[data-testid="chrome-title-bar"]')).toBeVisible({ timeout: 15_000 });
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toBeVisible();
}

const settingsNav = (w: Page, label: string) => w.getByRole('button', { name: label, exact: true });

/** Open Settings, check which of the Preview pages it lists, and close it again. */
async function expectSettingsPages(w: Page, listed: string[]): Promise<void> {
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(settingsNav(w, 'Updates')).toBeVisible({ timeout: 10_000 });
  for (const label of listed) await expect(settingsNav(w, label)).toBeVisible({ timeout: 15_000 });
  // The Preview pages appear once the eligibility answer arrives, so give a wrong one time to show.
  await w.waitForTimeout(1_000);
  for (const label of PREVIEW_PAGES.filter((page) => !listed.includes(page))) {
    await expect(settingsNav(w, label)).toHaveCount(0);
  }
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(settingsNav(w, 'Updates')).toBeHidden();
}

test('Preview off, fresh install: the legacy layout, and turning Preview on is the only way in', async () => {
  profile = createDisposableProfile({ label: 'stable-fresh' });
  app = await launchApp({ profile, env: STABLE_BUILD });
  const w = app.window;

  expect(await eligible(w)).toBe(false);
  await expectLegacyLayout(w);
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
  await expect(settingsNav(w, 'Annex')).toBeVisible();
  expect(await eligible(w)).toBe(true);
  await expect.poll(() => savedPreview(profile!)).toBe(true);

  await preview.click();
  await expect(preview).toHaveAttribute('aria-checked', 'false');
  await expect(settingsNav(w, 'Experimental')).toHaveCount(0, { timeout: 10_000 });
  expect(await eligible(w)).toBe(false);
  await expect.poll(() => savedPreview(profile!)).toBe(false);
});

test('Preview off, saved beta state: the legacy layout, a terminal, and nothing saved changes', async () => {
  const cli = installIdleCli();
  const projectDir = makeProject();
  profile = createDisposableProfile({ label: 'stable-beta-state' });
  seedTranscript(profile);
  seedProfile(profile, { experimental: BETA_FLAGS, userDataFiles: betaFiles(false) });
  const seeded = await readUntouched(profile);
  app = await launchApp({ profile, env: { ...STABLE_BUILD, ...cli.env } });
  const { electronApp, window: w } = app;

  expect(await eligible(w)).toBe(false);
  await expectLegacyLayout(w);
  const flags = await flagsInForce(w);
  for (const flag of PREVIEW_ONLY_FLAGS) expect(flags).not.toHaveProperty(flag);
  await expectSettingsPages(w, []);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toHaveCount(0);

  // The Chat-mode agent wakes in the terminal, on the session it had.
  await addProject(electronApp, w, projectDir);
  expect(await wakesInChat(w, projectDir)).toBe(false);
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
  // Never created: nothing turned the Dispatcher on behind the flag.
  expect(fs.existsSync(dispatcherFolder(profile))).toBe(false);
});

test('Preview on, no saved flags: the legacy layout with the Preview pages to opt in from', async () => {
  profile = createDisposableProfile({ label: 'stable-preview-on' });
  app = await launchApp({ profile, userDataFiles: updateSettings(true), env: STABLE_BUILD });
  const w = app.window;

  expect(await eligible(w)).toBe(true);
  await expectLegacyLayout(w);
  expect(await flagsInForce(w)).toEqual({});
  await expectSettingsPages(w, ['Experimental', 'Annex', 'Annex control']);
});

test('saved beta state survives Preview on, then off, then on', async () => {
  const cli = installIdleCli();
  const projectDir = makeProject();
  profile = createDisposableProfile({ label: 'stable-roundtrip' });
  seedTranscript(profile);
  const env = { ...STABLE_BUILD, ...cli.env };

  // Preview on: everything saved is in force, including a Dispatcher it creates.
  app = await launchApp({ profile, experimental: BETA_FLAGS, userDataFiles: betaFiles(true), env });
  let w = app.window;
  expect(await eligible(w)).toBe(true);
  await expectNewLayout(w);
  expect(await flagsInForce(w)).toEqual(BETA_FLAGS);
  await addProject(app.electronApp, w, projectDir);
  await expectSettingsPages(w, PREVIEW_PAGES);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  expect(await wakesInChat(w, projectDir)).toBe(true);
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

  // Preview off: none of it is in force, and all of it is still there.
  app = await launchApp({ profile, userDataFiles: updateSettings(false), env });
  w = app.window;
  expect(await eligible(w)).toBe(false);
  await expectLegacyLayout(w);
  const flags = await flagsInForce(w);
  for (const flag of PREVIEW_ONLY_FLAGS) expect(flags).not.toHaveProperty(flag);
  await expectSettingsPages(w, []);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toHaveCount(0);
  expect(await wakesInChat(w, projectDir)).toBe(false);
  expect(await savedLayoutWidth(w)).toBe(SAVED_SIDEBAR_WIDTH);
  await app.electronApp.close();
  expect(await Promise.all(savedFiles.map(readText))).toEqual(saved);

  // Preview on again: everything comes back.
  app = await launchApp({ profile, userDataFiles: updateSettings(true), env });
  w = app.window;
  expect(await eligible(w)).toBe(true);
  await expectNewLayout(w);
  expect(await flagsInForce(w)).toEqual(BETA_FLAGS);
  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  expect(await wakesInChat(w, projectDir)).toBe(true);
  expect(await savedLayoutWidth(w)).toBe(SAVED_SIDEBAR_WIDTH);
});
