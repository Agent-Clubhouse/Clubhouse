import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';

/**
 * Clubhouse-managed agents (#2819) at the UI level, with the preview flag on,
 * over a fake `claude`, so no tokens are spent: the parts library in Settings,
 * New agent from a built-in template, the agent's builder pages and Preview, a
 * part switch that survives leaving settings, and the instructions file its
 * first start writes.
 *
 * Runs in the Chat E2E job (Linux and Windows), not the sharded E2E run:
 * nothing here differs on macOS, and it would lengthen the E2E long pole.
 */

const AGENT = 'managed-smoke';
const TEMPLATE_ID = 'builtin-template-researcher';
// builtinTemplates() in src/main/services/managed-agents/builtins.ts.
const TEMPLATE_BLOCKS = ['builtin-block-identity', 'builtin-block-clubhouse-basics', 'builtin-block-researcher'];
const CLUBHOUSE_MCP = 'builtin-mcp-clubhouse';
const IDENTITY_LINE = `You are ${AGENT}, an agent working in Clubhouse.`;

let fakes: FakeClis | undefined;
let app: LaunchedApp | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  if (projectDir) await fs.promises.rm(path.dirname(projectDir), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  projectDir = undefined;
});

/** A git repo with no agents. A managed agent always gets its own worktree. */
function makeProject(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-e2e-')), 'managed-project');
  fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'README.md'), '# managed agents e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

interface SavedAgent { name: string; worktreePath?: string; managed?: { blocks: string[]; mcps: string[]; templateId?: string } }

async function savedAgent(): Promise<SavedAgent | undefined> {
  const list = JSON.parse(await fs.promises.readFile(path.join(projectDir!, '.clubhouse', 'agents.json'), 'utf8')) as SavedAgent[];
  return list.find((a) => a.name === AGENT);
}

/** Open the agent's settings from its sidebar row, on one page. */
async function openAgentSettingsPage(w: Page, page: string): Promise<void> {
  if (!(await w.locator('[data-testid="agent-settings-nav"]').isVisible().catch(() => false))) {
    await w.locator(`[data-agent-name="${AGENT}"]`).first().click({ button: 'right' });
    await w.locator('[data-testid="agent-context-menu"] [data-testid="ctx-settings"]').click();
  }
  // A managed agent's builder pages show once its setup loads.
  await w.locator(`[data-testid="agent-settings-nav-${page}"]`).click();
  await expect(w.locator(`[data-testid="agent-settings-page-${page}"]`)).toBeVisible();
}

test('parts library, New agent from a template, its builder pages and Preview, a part switch that persists', async () => {
  fakes = await installFakeClis({ claude: 'session-info' });
  projectDir = makeProject();
  app = await launchApp({
    label: 'managed-agents',
    experimental: { chat: true },
    userDataFiles: {
      // The provider is installed (the fake), so no first-run CLI probe.
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
    },
    env: fakes.env,
  });
  const w = app.window;
  await expect(w.locator('[data-testid="chrome-sidebar"]')).toBeVisible({ timeout: 15_000 });
  await addProject(app.electronApp, w, projectDir);

  // Settings, Managed agents, Instruction blocks: the built-ins are listed.
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(w.locator('[data-testid="settings-nav-group-managed"]')).toBeVisible({ timeout: 10_000 });
  await w.locator('[data-testid="settings-nav-app-managed-blocks"]').click();
  const rows = w.locator('[data-testid="managed-library-block"] [data-testid="managed-library-row"]');
  await expect(rows.getByText('Identity', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(rows.getByText('Clubhouse basics', { exact: true })).toBeVisible();
  await w.locator('[data-testid="nav-settings"]').click();
  await expect(w.locator('[data-testid="settings-nav"]')).toBeHidden();

  // New agent: Clubhouse managed is on by default, then a built-in template.
  await w.locator('[data-testid="chrome-new"]').click();
  await w.getByRole('menuitem', { name: 'Durable agent…' }).click();
  const page = w.locator('[data-testid="new-agent-page"]');
  await expect(page).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('switch', { name: 'Clubhouse managed' })).toHaveAttribute('aria-checked', 'true');
  await w.locator('[data-testid="new-agent-name"]').fill(AGENT);
  await expect(w.locator('[data-testid="new-agent-submit"]')).toBeEnabled({ timeout: 10_000 });
  await w.locator('[data-testid="new-agent-submit"]').click();
  const template = w.locator(`[data-testid="managed-template-${TEMPLATE_ID}"]`);
  await template.getByRole('button', { name: 'Create from Researcher' }).click();
  await expect(page).toBeHidden({ timeout: 30_000 });
  await expect(w.locator(`[data-agent-name="${AGENT}"]`).first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await savedAgent())?.managed?.templateId).toBe(TEMPLATE_ID);

  // Its first start (on the fake) writes the composed instructions into its worktree.
  const worktree = (await savedAgent())!.worktreePath!;
  await expect.poll(
    () => fs.promises.readFile(path.join(worktree, 'CLAUDE.md'), 'utf8').catch(() => ''),
    { timeout: 20_000 },
  ).toContain(IDENTITY_LINE);

  // Instructions lists the template's blocks, in order.
  await openAgentSettingsPage(w, 'instructions');
  const blocks = w.locator('[data-testid="agent-settings-page-instructions"] [data-testid="managed-block"]');
  await expect.poll(() => blocks.evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id')))).toEqual(TEMPLATE_BLOCKS);

  // Preview shows the composed text with the wildcards filled.
  await openAgentSettingsPage(w, 'preview');
  const preview = w.locator('[data-testid="agent-settings-page-preview"] [data-testid="managed-preview-text"]');
  await expect(preview).toContainText(IDENTITY_LINE);
  await expect(preview).not.toContainText('@@AgentName');

  // MCP servers: switching the Clubhouse part off saves it, and it stays off after leaving settings.
  await openAgentSettingsPage(w, 'mcp');
  const mcpSwitch = () => w.locator(`[data-testid="agent-settings-page-mcp"] [data-testid="managed-part-toggle-${CLUBHOUSE_MCP}"]`);
  await expect(mcpSwitch()).toHaveAttribute('aria-checked', 'true');
  await mcpSwitch().click();
  await expect(mcpSwitch()).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await savedAgent())?.managed?.mcps).toEqual([]);
  await w.locator('[data-testid="list-breadcrumb"] button').click();
  await expect(w.locator('[data-testid="agent-settings-nav"]')).toBeHidden();
  await openAgentSettingsPage(w, 'mcp');
  await expect(mcpSwitch()).toHaveAttribute('aria-checked', 'false');
});
