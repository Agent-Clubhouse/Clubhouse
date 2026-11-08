import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';

/**
 * The maintainer's acceptance test for Clubhouse-managed agents (#2819), in the
 * real app, over a fake `claude`, so no tokens are spent:
 *
 *   "start with a base <orchestrator, pm, researcher, custom> then add a new
 *   skill; add an existing skill I have in another agent; add an additional MCP
 *   (WorkIQ); fork the base instructions and add specific stuff locally."
 *
 * Agent A starts from the Orchestrator template and gets a new skill. Agent B
 * starts from Product Owner (the maintainer's "pm"; the Project Manager
 * template is retired, D71), switches on A's skill, adds a WorkIQ MCP server,
 * and makes its own copy of the Product owner block with a line of its own.
 * After a restart, B's folder holds all of it, and A's instructions don't have
 * B's line.
 *
 * Runs in the Chat E2E job (Linux and Windows), like managed-agents.spec.ts,
 * not the sharded E2E run: nothing here differs on macOS.
 */

const AGENT_A = 'acc-orchestrator';
const AGENT_B = 'acc-po';
const TEMPLATE_A = 'builtin-template-orchestrator';
const TEMPLATE_B = 'builtin-template-product-owner';
// builtin-text/manifest.json, read by src/main/services/managed-agents/builtins.ts.
const BASE_BLOCKS = ['builtin-block-identity', 'builtin-block-clubhouse-basics'];
const ROLE_BLOCK_B = 'builtin-block-product-owner';
const identityLine = (name: string): string => `You are ${name}, an agent working in Clubhouse.`;

const SKILL_NAME = 'Release notes';
const SKILL_FOLDER = 'release-notes';
const SKILL_LINE = 'Group merged pull requests by area and write one line for each.';
const SKILL_MD = [
  '---',
  `name: ${SKILL_FOLDER}`,
  'description: Drafts release notes from merged pull requests.',
  '---',
  SKILL_LINE,
  '',
].join('\n');

const MCP_NAME = 'WorkIQ';
const MCP_KEY = 'workiq';
const MCP_ARGS = ['-y', '@example/workiq-mcp'];
const MCP_ENV = 'WORKIQ_TENANT';

const LOCAL_LINE = 'Focus on release notes.';

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
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-acc-e2e-')), 'managed-acc-project');
  fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'README.md'), '# managed agents acceptance e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

interface SavedAgent {
  id: string;
  name: string;
  worktreePath?: string;
  managed?: { blocks: string[]; skills: string[]; mcps: string[]; templateId?: string };
}

async function savedAgent(name: string): Promise<SavedAgent | undefined> {
  const list = JSON.parse(await fs.promises.readFile(path.join(projectDir!, '.clubhouse', 'agents.json'), 'utf8')) as SavedAgent[];
  return list.find((a) => a.name === name);
}

const readText = (file: string): Promise<string> => fs.promises.readFile(file, 'utf8').catch(() => '');

/** Back to the agent tree, if settings or a list replaced it. */
async function closeAgentSettings(w: Page): Promise<void> {
  if (await w.locator('[data-testid="agent-settings-nav"]').isVisible().catch(() => false)) {
    await w.locator('[data-testid="list-breadcrumb"] button').click();
    await expect(w.locator('[data-testid="agent-settings-nav"]')).toBeHidden();
  }
}

/** Open this agent's settings from its sidebar row. */
async function openAgentSettings(w: Page, name: string): Promise<void> {
  await closeAgentSettings(w);
  await w.locator(`[data-agent-name="${name}"]`).first().click({ button: 'right' });
  await w.locator('[data-testid="agent-context-menu"] [data-testid="ctx-settings"]').click();
  await expect(w.locator('[data-testid="agent-settings-nav"]')).toBeVisible({ timeout: 10_000 });
}

/** One page of the open agent's settings. A managed agent's builder pages show once its setup loads. */
async function settingsPage(w: Page, page: string) {
  await w.locator(`[data-testid="agent-settings-nav-${page}"]`).click();
  const root = w.locator(`[data-testid="agent-settings-page-${page}"]`);
  await expect(root).toBeVisible();
  return root;
}

/** New agent, Clubhouse managed, from a built-in template. Resolves once it is saved with that template. */
async function createFromTemplate(w: Page, name: string, templateId: string, templateName: string): Promise<SavedAgent> {
  await closeAgentSettings(w);
  await w.locator('[data-testid="chrome-new"]').click();
  await w.getByRole('menuitem', { name: 'Durable agent…' }).click();
  const page = w.locator('[data-testid="new-agent-page"]');
  await expect(page).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('switch', { name: 'Clubhouse managed' })).toHaveAttribute('aria-checked', 'true');
  await w.locator('[data-testid="new-agent-name"]').fill(name);
  await expect(w.locator('[data-testid="new-agent-submit"]')).toBeEnabled({ timeout: 10_000 });
  await w.locator('[data-testid="new-agent-submit"]').click();
  await w.locator(`[data-testid="managed-template-${templateId}"]`).getByRole('button', { name: `Create from ${templateName}` }).click();
  await expect(page).toBeHidden({ timeout: 30_000 });
  await expect(w.locator(`[data-agent-name="${name}"]`).first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await savedAgent(name))?.managed?.templateId).toBe(templateId);
  const saved = (await savedAgent(name))!;
  // Its first start (on the fake) writes the composed instructions into its worktree.
  await expect.poll(() => readText(path.join(saved.worktreePath!, 'CLAUDE.md')), { timeout: 20_000 }).toContain(identityLine(name));
  return saved;
}

/**
 * Select the agent, and Restart from the setup-changed bar above its composer,
 * then wait until `delivered` says its folder has the new setup. An agent
 * judged mid-turn asks first; Restart now.
 */
async function restartFromBar(w: Page, agent: SavedAgent, delivered: () => Promise<boolean>): Promise<void> {
  await closeAgentSettings(w);
  await w.locator(`[data-testid="agent-item-${agent.id}"]`).first().click();
  const chat = w.locator(`[data-testid="chat-view"][data-agent-pane="${agent.id}"][data-view-context="main"]`);
  await expect(chat).toBeVisible({ timeout: 20_000 });
  const restart = chat.locator('[data-testid="setup-changed-bar"] [data-testid="setup-changed-restart"]');
  await expect(restart).toBeEnabled({ timeout: 15_000 });
  await restart.click();
  const now = w.locator('[data-testid="managed-restart-now"]');
  await expect.poll(async () => {
    if (await now.isVisible().catch(() => false)) await now.click().catch(() => {});
    return delivered();
  }, { timeout: 30_000 }).toBe(true);
}

test('base template, a new skill, a skill from another agent, an MCP server, and a local fork of the base instructions', async () => {
  test.setTimeout(240_000);
  fakes = await installFakeClis({ claude: 'session-info' });
  projectDir = makeProject();
  app = await launchApp({
    label: 'managed-agents-acceptance',
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

  // ── Agent A: Orchestrator, then a new skill from its Skills page ──
  const a = await createFromTemplate(w, AGENT_A, TEMPLATE_A, 'Orchestrator');
  await openAgentSettings(w, AGENT_A);
  let skills = await settingsPage(w, 'skills');
  await skills.locator('[data-testid="managed-skill-new"]').click();
  const dialog = w.locator('[data-testid="managed-part-dialog"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="managed-part-name"]').fill(SKILL_NAME);
  await dialog.locator('[data-testid="managed-part-description"]').fill('Drafts release notes from merged pull requests.');
  await dialog.locator('[data-testid="managed-part-skill-name"]').fill(SKILL_FOLDER);
  await dialog.locator('[data-testid="managed-part-skill-md"]').fill(SKILL_MD);
  await dialog.locator('[data-testid="managed-part-save"]').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  // Saved to the library and added to A.
  await expect.poll(async () => (await savedAgent(AGENT_A))?.managed?.skills.length).toBe(1);
  const skillId = (await savedAgent(AGENT_A))!.managed!.skills[0];
  const skillToggle = () => w.locator(`[data-testid="agent-settings-page-skills"] [data-testid="managed-part-toggle-${skillId}"]`);
  await expect(skillToggle()).toHaveAttribute('aria-checked', 'true');

  // ── Agent B: Product Owner ──
  const b = await createFromTemplate(w, AGENT_B, TEMPLATE_B, 'Product Owner');
  await openAgentSettings(w, AGENT_B);

  // The skill A has: off on B until switched on.
  skills = await settingsPage(w, 'skills');
  await expect(skills.locator(`[data-testid="managed-part-row"][data-part-id="${skillId}"]`)).toContainText(SKILL_NAME);
  await expect(skillToggle()).toHaveAttribute('aria-checked', 'false');
  await skillToggle().click();
  await expect(skillToggle()).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await savedAgent(AGENT_B))?.managed?.skills).toEqual([skillId]);
  await expect(skills.locator(`[data-testid="managed-part-row"][data-part-id="${skillId}"] [data-testid="managed-part-source"]`)).toContainText('2 agents');

  // An MCP server of its own: WorkIQ, by command, with a variable name and no value.
  const mcp = await settingsPage(w, 'mcp');
  await mcp.locator('[data-testid="managed-mcp-new"]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="managed-part-name"]').fill(MCP_NAME);
  await dialog.locator('[data-testid="managed-part-server-key"]').fill(MCP_KEY);
  await expect(dialog.locator('[data-testid="managed-part-transport"]')).toHaveValue('stdio');
  await dialog.locator('[data-testid="managed-part-command"]').fill('npx');
  await dialog.locator('[data-testid="managed-part-args"]').fill(MCP_ARGS.join('\n'));
  await dialog.locator('[data-testid="managed-part-env"]').fill(MCP_ENV);
  await dialog.locator('[data-testid="managed-part-save"]').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => (await savedAgent(AGENT_B))?.managed?.mcps.length).toBe(2);
  const mcpId = (await savedAgent(AGENT_B))!.managed!.mcps.find((id) => id !== 'builtin-mcp-clubhouse')!;
  const mcpRow = mcp.locator(`[data-testid="managed-part-row"][data-part-id="${mcpId}"]`);
  await expect(mcpRow).toContainText(MCP_NAME);
  await expect(mcp.locator(`[data-testid="managed-part-toggle-${mcpId}"]`)).toHaveAttribute('aria-checked', 'true');

  // Fork the base role block for B and add a line only B gets. A built-in block
  // has no inline edit: Make your copy puts B on a copy, which B then edits.
  const instructions = await settingsPage(w, 'instructions');
  const blocks = instructions.locator('[data-testid="managed-block"]');
  await expect.poll(() => blocks.evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id')))).toEqual([...BASE_BLOCKS, ROLE_BLOCK_B]);
  await instructions.locator(`[data-testid="managed-block"][data-block-id="${ROLE_BLOCK_B}"] [data-testid="managed-block-fork"]`).click();
  await expect.poll(async () => (await savedAgent(AGENT_B))?.managed?.blocks[2]).not.toBe(ROLE_BLOCK_B);
  const forkId = (await savedAgent(AGENT_B))!.managed!.blocks[2];
  expect((await savedAgent(AGENT_B))!.managed!.blocks.slice(0, 2)).toEqual(BASE_BLOCKS);
  const fork = instructions.locator(`[data-testid="managed-block"][data-block-id="${forkId}"]`);
  await expect(fork.locator('[data-testid="managed-block-source"]')).toHaveText(`${AGENT_B} only`);
  await fork.locator('[data-testid="managed-block-edit"]').click();
  const text = fork.locator('[data-testid="managed-block-text"]');
  await expect(text).not.toHaveValue('');
  const roleText = await text.inputValue();
  await text.fill(`${roleText}\n\n${LOCAL_LINE}`);
  await fork.locator('[data-testid="managed-block-save"]').click();
  await expect(text).toBeHidden({ timeout: 10_000 });
  await expect(fork.locator('[data-testid="managed-block-source"]')).toHaveText(`${AGENT_B} only`);
  // Each builder page saves the whole setup: none put back an older one over another's change.
  await expect.poll(async () => {
    const m = (await savedAgent(AGENT_B))?.managed;
    return m && { blocks: m.blocks, skills: m.skills, mcps: [...m.mcps].sort() };
  }).toEqual({ blocks: [...BASE_BLOCKS, forkId], skills: [skillId], mcps: ['builtin-mcp-clubhouse', mcpId].sort() });

  // Preview: B's own line, and the Identity line with B's name.
  const preview = (await settingsPage(w, 'preview')).locator('[data-testid="managed-preview"]');
  await expect(preview.locator('[data-testid="managed-preview-text"]')).toContainText(LOCAL_LINE);
  await expect(preview.locator('[data-testid="managed-preview-text"]')).toContainText(identityLine(AGENT_B));
  await expect(preview).toContainText(SKILL_NAME);
  await expect(preview).toContainText(MCP_KEY);

  // The shared skill is still on, and the server still listed, after a page switch.
  await settingsPage(w, 'skills');
  await expect(skillToggle()).toHaveAttribute('aria-checked', 'true');
  await settingsPage(w, 'mcp');
  await expect(mcpRow).toContainText(MCP_NAME);

  // A's preview doesn't have B's line: the fork is B's alone.
  await openAgentSettings(w, AGENT_A);
  const previewA = (await settingsPage(w, 'preview')).locator('[data-testid="managed-preview-text"]');
  await expect(previewA).toContainText(identityLine(AGENT_A));
  await expect(previewA).not.toContainText(LOCAL_LINE);

  // ── B restarts on the fake: its folder has the setup ──
  const worktreeB = b.worktreePath!;
  const skillFile = (worktree: string) => path.join(worktree, '.claude', 'skills', SKILL_FOLDER, 'SKILL.md');
  await restartFromBar(w, b, async () => (await readText(path.join(worktreeB, 'CLAUDE.md'))).includes(LOCAL_LINE));
  const claudeB = await readText(path.join(worktreeB, 'CLAUDE.md'));
  expect(claudeB).toContain(identityLine(AGENT_B));
  await expect.poll(() => readText(skillFile(worktreeB))).toContain(SKILL_LINE);
  const mcpJson = JSON.parse(await readText(path.join(worktreeB, '.mcp.json')) || '{}') as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, unknown> }>;
  };
  const server = mcpJson.mcpServers?.[MCP_KEY];
  expect(server, `.mcp.json has ${MCP_KEY}`).toBeDefined();
  expect(server!.command).toBe('npx');
  expect(server!.args).toEqual(MCP_ARGS);
  // Names only: Clubhouse never writes a value for the variable.
  expect(server!.env?.[MCP_ENV]).toBeUndefined();
  expect(await readText(path.join(worktreeB, '.mcp.json'))).not.toContain(`"${MCP_ENV}":`);

  // ── A restarts too: it gets its skill, and still not B's line ──
  const worktreeA = a.worktreePath!;
  await restartFromBar(w, a, async () => (await readText(skillFile(worktreeA))).includes(SKILL_LINE));
  const claudeA = await readText(path.join(worktreeA, 'CLAUDE.md'));
  expect(claudeA).toContain(identityLine(AGENT_A));
  expect(claudeA).not.toContain(LOCAL_LINE);
  expect(claudeA).not.toContain(identityLine(AGENT_B));
});
