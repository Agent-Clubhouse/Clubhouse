import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';
import { createDisposableProfile } from './app-profile';

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
  const details = w.getByTestId('agent-details');
  await expect(details.getByTestId('details-card-settings')).toHaveAccessibleName('Settings');
  await expect(details.getByTestId('details-card-actions')).toBeVisible();
  await expect(details.getByTestId('details-card-context')).toHaveCount(0);
  await expect(details.getByTestId('details-card-helpers')).toHaveCount(0);
  await expect(details.getByTestId('details-card-canvases')).toHaveCount(0);
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

test('the Connections card creates and restores a two-way connection', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  projectDir = makeProject();
  const profile = createDisposableProfile({ label: 'connection-picker' });
  const registry = path.join(profile.userDataDir, '.clubhouse-dev', 'group-projects');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, 'registry.json'), JSON.stringify([{ id: 'gp_picker', name: 'Picker group', description: '', instructions: '', createdAt: new Date().toISOString(), scope: { level: 'app', reach: 'local' }, metadata: {} }]));
  const machine = Array(16).fill('ab').join(':');
  app = await launchApp({ profile, label: 'connection-picker', experimental: { chat: true }, userDataFiles: {
    'annex-peers.json': [{ fingerprint: machine, alias: 'Offline studio', role: 'member', kind: 'desktop', pairingId: 'test-pair' }],
    'connection-card.json': { version: 1, memberships: [], peers: { [machine]: { pairingId: 'test-pair', targets: [{ id: 'remote_agent', name: 'Remote partner', kind: 'agent', project: 'Remote project' }] } } },
    'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
    'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
  }, env: fakes.env });
  await addProject(app.electronApp, app.window, projectDir);
  const openConnections = async () => {
    const w = app!.window;
    const conductor = w.locator('[data-agent-name="conductor"]').first();
    if (!(await conductor.isVisible().catch(() => false))) {
      const fold = w.locator('[data-testid^="sleeping-fold-"]').first();
      if (await fold.isVisible().catch(() => false)) await fold.click();
    }
    await conductor.click();
    const head = w.getByTestId('details-card-connections-toggle').first();
    if (!(await head.isVisible().catch(() => false))) await w.getByRole('button', { name: 'Agent details' }).first().click();
    await expect(head).toBeVisible({ timeout: 15_000 });
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  };
  await openConnections();
  await app.window.getByRole('button', { name: 'Add connection' }).click();
  const picker = app.window.getByTestId('connection-picker');
  await picker.getByRole('button', { name: /partner/ }).click();
  await picker.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect.poll(async () => (await savedDirections()).filter((d) => [CONDUCTOR, PARTNER].includes(d.from.agentId) && [CONDUCTOR, PARTNER].includes(d.to.agentId)).length).toBe(2);
  await app.window.getByRole('button', { name: 'Close' }).last().click();
  await app.window.getByRole('button', { name: 'Add connection' }).click();
  await picker.getByRole('button', { name: /Picker group/ }).click();
  await picker.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect.poll(async () => JSON.parse(await fs.promises.readFile(path.join(app!.userDataDir, 'connection-card.json'), 'utf8')).memberships).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: CONDUCTOR, groupId: 'gp_picker' })]));
  await app.window.getByRole('button', { name: 'Close' }).last().click();
  await app.window.getByRole('button', { name: 'Add connection' }).click();
  await picker.getByRole('button', { name: /Remote partner/ }).click();
  await picker.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect.poll(async () => (await savedDirections()).some((d) => d.to.agentId === 'remote_agent')).toBe(true);
  await app.electronApp.close();
  app = await launchApp({ profile, env: fakes.env });
  await openConnections();
  await expect(app.window.getByTestId('connection-row').filter({ hasText: 'partner' })).toBeVisible({ timeout: 15_000 });
  await expect(app.window.getByTestId('connection-row').filter({ hasText: 'Picker group' })).toBeVisible();
  await expect(app.window.getByTestId('remote-connection-row').filter({ hasText: 'Remote partner' })).toBeVisible();
});
