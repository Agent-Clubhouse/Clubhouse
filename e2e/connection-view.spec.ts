import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';

/**
 * The connection view (#2972, D129), over a fake `claude`, so no tokens are
 * spent: an agent's Connections card opens a connection with both directions
 * side by side, each with its own tool switches, saved in the app's
 * connection store; and a one-way connection is made two-way there.
 *
 * The connection is the user's own link, seeded in connection-grants.json:
 * no canvas needed, which is the point of the store (#3056).
 */

const CONDUCTOR = 'agent_conductor_cv';
const PARTNER = 'agent_partner_cv';

let fakes: FakeClis | undefined;
let app: LaunchedApp | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  projectDir = undefined;
});

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-view-e2e-'));
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: CONDUCTOR, name: 'conductor', color: 'emerald', createdAt: now, orchestrator: 'claude-code', orchestration: { orchestrate: true } },
    { id: PARTNER, name: 'partner', color: 'indigo', createdAt: now, orchestrator: 'claude-code' },
  ]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# connection view e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

interface SavedDirection { from: { agentId: string }; to: { agentId: string }; disabledTools: string[]; link?: unknown }

async function savedDirections(): Promise<SavedDirection[]> {
  const raw = await fs.promises.readFile(path.join(app!.userDataDir, 'connection-grants.json'), 'utf8').catch(() => '{}');
  return (JSON.parse(raw).directions ?? []) as SavedDirection[];
}

test('the connection view: both directions with their own tools, saved in the store, and Make two-way', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  projectDir = makeProject();
  const now = new Date().toISOString();
  app = await launchApp({
    label: 'connection-view',
    experimental: { chat: true },
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
      // The user's own link, one way: conductor to partner, starting like any new connection.
      'connection-grants.json': {
        version: 1,
        directions: [{ from: { agentId: CONDUCTOR }, to: { agentId: PARTNER }, disabledTools: ['clear_agent', 'compact_agent'], link: { createdAt: now }, updatedAt: now }],
      },
    },
    env: fakes.env,
  });
  const w = app.window;
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toBeVisible({ timeout: 15_000 });
  await addProject(app.electronApp, w, projectDir);

  // conductor's details, Connections card.
  const conductor = w.locator('[data-agent-name="conductor"]').first();
  if (!(await conductor.isVisible().catch(() => false))) {
    const fold = w.locator('[data-testid^="sleeping-fold-"]').first();
    if (await fold.isVisible().catch(() => false)) await fold.click();
  }
  await conductor.click();
  // The Connections card is in the agent's details panel.
  const head = w.locator('[data-testid="details-card-connections-toggle"]').first();
  if (!(await head.isVisible().catch(() => false))) await w.getByRole('button', { name: 'Agent details' }).first().click();
  await expect(head).toBeVisible({ timeout: 15_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();

  // The connection, from the store alone.
  const row = w.locator('[data-testid="connection-row"]', { hasText: 'partner' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-testid="connection-sources"]').click();
  const dialog = w.locator('[data-testid="connection-sources-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-testid="connection-source-user_link"]')).toBeVisible();

  // Both directions side by side: conductor to partner has its tools, Clear starting off.
  const out = dialog.locator(`[data-testid="connection-direction-${CONDUCTOR}-${PARTNER}"]`);
  await expect(out.getByRole('switch', { name: 'Clear its context (conductor to partner)' })).toHaveAttribute('aria-checked', 'false');
  // Saved before Wake it existed: it stays off, the user's (2026-11-09 defaults leave saved directions alone).
  await expect(out.getByRole('switch', { name: 'Wake it (conductor to partner)' })).toHaveAttribute('aria-checked', 'false');
  await out.getByRole('switch', { name: 'Send files (conductor to partner)' }).click();
  // By both ends: conductor's link with the Dispatcher is saved here too (#3214).
  await expect.poll(async () => (await savedDirections()).find((d) => d.from.agentId === CONDUCTOR && d.to.agentId === PARTNER)?.disabledTools.sort())
    .toEqual(['clear_agent', 'compact_agent', 'send_file']);

  // partner to conductor isn't connected: Make two-way adds the user's link for it, starting like a new connection, wake on.
  const back = dialog.locator(`[data-testid="connection-direction-${PARTNER}-${CONDUCTOR}"]`);
  await expect(back).toContainText('Not connected this way.');
  await back.locator(`[data-testid="connection-make-two-way-${PARTNER}-${CONDUCTOR}"]`).click();
  await expect.poll(async () => (await savedDirections()).find((d) => d.from.agentId === PARTNER && d.to.agentId === CONDUCTOR))
    .toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'], link: expect.anything() });
  await expect(back.getByRole('switch', { name: 'Send messages (partner to conductor)' })).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
  await expect(back.getByRole('switch', { name: 'Wake it (partner to conductor)' })).toHaveAttribute('aria-checked', 'true');
});
