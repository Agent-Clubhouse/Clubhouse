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
 * An agent's Dispatcher card in Details (#3049), over a fake `claude` that is
 * initialized idle, with no prompt, so no tokens are spent:
 * - the card is titled with the Dispatcher's name, and an orchestrator is
 *   connected by default; the Orchestration card has no Connect switch;
 * - an asleep agent hasn't been asked yet: "No description yet";
 * - Edit fills both fields in place, and the card lands in the Dispatcher's
 *   memory, at the top of the agent's page;
 * - Permissions lists the Dispatcher's real permissions on this agent, and a
 *   change shows in the card's summary;
 * - turning it off removes the wire at once, with Undo in a toast; Undo puts
 *   the wire back and the description is still there.
 *
 * Runs in the Chat E2E job (Linux and Windows), like dispatcher.spec.ts.
 */

const USER_DATA_FILES = {
  'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
  'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
};
const ORCHESTRATOR_ID = 'orch_dispatcher_card_e2e';

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

/** A git repo with one orchestrator, which connects to the Dispatcher by default. */
function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-card-e2e-'));
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([{
    id: ORCHESTRATOR_ID, name: 'conductor', color: 'emerald', createdAt: new Date().toISOString(),
    orchestrator: 'claude-code', orchestration: { orchestrate: true },
  }]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# dispatcher card e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

function dispatcherDir(): string {
  return path.join(profile!.userDataDir, '.clubhouse-dev', 'dispatcher');
}

async function dispatcherId(): Promise<string> {
  const file = path.join(dispatcherDir(), '.clubhouse', 'agents.json');
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true);
  return (JSON.parse(await fs.promises.readFile(file, 'utf8')) as Array<{ id: string }>)[0].id;
}

/** The agent's page in the Dispatcher's memory, once it exists. */
async function agentPageText(): Promise<string> {
  const dir = path.join(dispatcherDir(), 'memory', 'agents');
  if (!fs.existsSync(dir)) return '';
  const page = (await fs.promises.readdir(dir)).find((name) => name.startsWith('conductor'));
  return page ? fs.promises.readFile(path.join(dir, page), 'utf8') : '';
}

async function hasWire(w: Page, id: string): Promise<boolean> {
  const bindings = await w.evaluate(() => window.clubhouse.mcpBinding.getBindings()) as Array<{ agentId: string; targetId: string }>;
  return bindings.some((b) => b.agentId === id && b.targetId === ORCHESTRATOR_ID)
    && bindings.some((b) => b.agentId === ORCHESTRATOR_ID && b.targetId === id);
}

/** Select the orchestrator, show Agent details, and expand its Dispatcher card. */
async function openDispatcherCard(w: Page): Promise<void> {
  const agent = w.locator('[data-agent-name="conductor"]').first();
  if (!(await agent.isVisible().catch(() => false))) {
    await w.locator('[role="treeitem"]:has-text("dispatcher-card-e2e-")').first().click();
    const fold = w.locator('[data-testid^="sleeping-fold-"]').first();
    if (await fold.isVisible().catch(() => false)) await fold.click();
  }
  await agent.click();
  const details = w.locator('[data-testid="agent-details"]');
  if (!(await details.isVisible().catch(() => false))) await w.locator('[data-testid="agent-details-toggle"]').first().click();
  const head = w.locator('[data-testid="details-card-dispatcher-toggle"]');
  await expect(head).toBeVisible({ timeout: 10_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

test('the Dispatcher card: connected by default, Edit, Permissions, and off with Undo', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  profile = createDisposableProfile({ label: 'dispatcher-card' });
  projectDir = makeProject();
  app = await launchApp({ profile, experimental: { chat: true }, userDataFiles: USER_DATA_FILES, env: fakes.env });
  const w = app.window;

  await expect(w.locator('[data-testid="dispatcher-row"]')).toBeVisible({ timeout: 15_000 });
  const id = await dispatcherId();
  await expect.poll(() => w.evaluate(() => window.clubhouse.dispatcher.get().then((s) => s.workRunning))).toBe(true);
  await addProject(app.electronApp, w, projectDir);
  await openDispatcherCard(w);

  // Titled with the Dispatcher's name; connected by default, and the Orchestration card has no Connect row.
  const card = w.locator('[data-testid="details-card-dispatcher"]');
  await expect(card).toHaveAttribute('aria-label', 'Dispatcher');
  const sw = w.locator('[data-testid="dispatcher-card-switch"]');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => hasWire(w, id)).toBe(true);
  await expect(w.locator('[data-testid="orchestrate-dispatcher"]')).toHaveCount(0);

  // Asleep, so it hasn't been asked: no description yet, and it says when it will be.
  await expect(w.locator('[data-testid="dispatcher-card-none"]')).toContainText('No description yet', { timeout: 15_000 });
  await expect(w.locator('[data-testid="dispatcher-card-reach"]')).toContainText('Message it');

  // Edit in place; the card lands at the top of its page in memory.
  await w.locator('[data-testid="dispatcher-card-edit"]').click();
  await expect(w.locator('[data-testid="dispatcher-card-editor"]')).toContainText('Saving replaces what conductor wrote.');
  await w.locator('[data-testid="dispatcher-card-edit-contact"]').fill('Release planning and tagging');
  await w.locator('[data-testid="dispatcher-card-edit-owns"]').fill('the release branch');
  await w.locator('[data-testid="dispatcher-card-save"]').click();
  await expect(w.locator('[data-testid="dispatcher-card-contact"]')).toContainText('Release planning and tagging');
  await expect(w.locator('[data-testid="dispatcher-card-owns"]')).toContainText('the release branch');
  await expect.poll(agentPageText).toContain('When to reach it: Release planning and tagging');
  expect(await agentPageText()).toContain('Owns: the release branch');

  // Permissions: the Dispatcher's real permissions on this agent.
  await w.locator('[data-testid="dispatcher-card-permissions"]').click();
  const popover = w.locator('[data-testid="dispatcher-card-permissions-popover"]');
  await expect(popover).toContainText('What Dispatcher can do to conductor');
  const sleep = w.locator('[data-testid="dispatcher-card-permission-agent.sleep"]');
  await expect(sleep.getByRole('radio', { name: 'Allow' })).toBeChecked();
  await sleep.getByRole('radio', { name: 'Ask' }).check();
  await expect(sleep.getByRole('radio', { name: 'Ask' })).toBeChecked();
  await expect(w.locator('[data-testid="dispatcher-card-reach"]')).toContainText('Asks you first to put it to sleep.');
  await sleep.getByRole('radio', { name: 'Allow' }).check();
  await expect(sleep.getByRole('radio', { name: 'Allow' })).toBeChecked();
  await w.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  // Off at once, with Undo; Undo puts the wire back, and the description is kept.
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(w.locator('[data-testid="details-card-dispatcher-summary"]')).toHaveText('not connected');
  await expect.poll(() => hasWire(w, id)).toBe(false);
  const toast = w.locator('[data-testid="toast-message"]', { hasText: 'conductor is no longer connected to Dispatcher.' });
  await expect(toast).toBeVisible();
  await toast.locator('[data-testid="toast-action"]').click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => hasWire(w, id)).toBe(true);
  await expect(w.locator('[data-testid="dispatcher-card-contact"]')).toContainText('Release planning and tagging');
  expect(await agentPageText()).toContain('When to reach it: Release planning and tagging');

  // session-info's first two replay lines are initialize request/response;
  // its next line waits for a user prompt, which idle launch must not send.
  await expect.poll(async () => {
    const report = await fakes!.report('claude', id).catch((): undefined => undefined);
    return report && { consumed: report.consumed, mismatch: report.mismatch, unexpected: report.unexpected, exitCode: report.exitCode };
  }).toEqual({ consumed: 2, mismatch: null, unexpected: [], exitCode: null });
});
