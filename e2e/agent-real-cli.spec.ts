import { test, expect, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeCodeProvider, CodexCliProvider, CopilotCliProvider } from '../src/main/orchestrators';
import { launchApp } from './launch';
import { addProject, assertRunLayout, openSettings, projectIdFor, revealAgent } from './smoke-helpers';
import { isNewLayout } from './layout';

type ProviderId = 'copilot-cli' | 'claude-code' | 'codex-cli';

type ProviderCase = {
  id: ProviderId;
  displayName: string;
  provider: CopilotCliProvider | ClaudeCodeProvider | CodexCliProvider;
};

const RUN_REAL_CLI = process.env.CLUBHOUSE_REAL_CLI_E2E === '1';
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/project-agent-transition');
const AGENTS_DIR = path.join(FIXTURE_DIR, '.clubhouse');
const AGENTS_JSON = path.join(AGENTS_DIR, 'agents.json');
const PACKAGED_EXECUTABLE = path.resolve(
  __dirname,
  '..',
  'out',
  `Clubhouse-darwin-${process.arch}`,
  'Clubhouse.app',
  'Contents',
  'MacOS',
  'clubhouse',
);

const PROVIDER_CASES: ProviderCase[] = [
  { id: 'copilot-cli', displayName: 'GitHub Copilot CLI', provider: new CopilotCliProvider() },
  { id: 'claude-code', displayName: 'Claude Code', provider: new ClaudeCodeProvider() },
  { id: 'codex-cli', displayName: 'Codex CLI', provider: new CodexCliProvider() },
];

function runGit(args: string[]): void {
  execFileSync('git', args, { cwd: FIXTURE_DIR, stdio: 'pipe' });
}

function removeWorktree(worktreePath: string, branch: string): void {
  try {
    runGit(['worktree', 'remove', worktreePath, '--force']);
  } catch {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try { runGit(['worktree', 'prune']); } catch { /* best effort */ }
  }
  try { runGit(['branch', '-D', branch]); } catch { /* already absent */ }
}

function makeProviderSuffix(id: ProviderId): string {
  return id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

function prepareSleepingAgent(orchestrator: ProviderId): { sleeperId: string; sleeperName: string; sleeperBranch: string; sleeperWorktree: string; } {
  const sleeperId = `real_cli_sleeping_agent_${makeProviderSuffix(orchestrator)}`;
  const sleeperName = `real-cli-${makeProviderSuffix(orchestrator)}-sleeper`;
  const sleeperBranch = `${sleeperName}/standby`;
  const sleeperWorktree = path.join(AGENTS_DIR, sleeperName);

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  removeWorktree(sleeperWorktree, sleeperBranch);
  runGit(['worktree', 'add', '-b', sleeperBranch, sleeperWorktree, 'HEAD']);
  fs.writeFileSync(
    AGENTS_JSON,
    JSON.stringify(
      [{
        id: sleeperId,
        name: sleeperName,
        color: 'green',
        branch: sleeperBranch,
        worktreePath: sleeperWorktree,
        createdAt: new Date().toISOString(),
        orchestrator,
        // Saved as before #2761, with no `access`: it reads as Full access.
        freeAgentMode: true,
      }],
      null,
      2,
    ),
    'utf-8',
  );

  return { sleeperId, sleeperName, sleeperBranch, sleeperWorktree };
}

async function assertCliRunning(window: Page, agentId: string): Promise<void> {
  await expect.poll(
    async () => (await window.evaluate(async (id) => window.clubhouse.pty.getBuffer(id), agentId)).length,
    { timeout: 30_000 },
  ).toBeGreaterThan(1_000);
}

async function assertFilesystemResponsive(window: Page): Promise<void> {
  const responsive = await window.evaluate(async (projectPath) => {
    try {
      await Promise.race([
        window.clubhouse.project.readMcpCatalog(projectPath),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('filesystem IPC timeout')), 3_000);
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }, FIXTURE_DIR);
  expect(responsive).toBe(true);
}

/**
 * Open the new agent form, fill it for a durable agent with its own worktree on
 * the given CLI with Full access, and create it. Classic has the "+ Agent"
 * dialog, the new layout the New agent page.
 */
async function createDurableAgentFromUi(window: Page, name: string, orchestrator: ProviderId): Promise<void> {
  if (!(await isNewLayout(window))) {
    await window.locator('button:has-text("+ Agent")').first().click();
    await expect(window.locator('h2:has-text("New Agent")')).toBeVisible({ timeout: 5_000 });

    await window.locator('input[type="text"]').first().fill(name);
    await window.getByText('Use git worktree', { exact: false }).click();
    await window.locator('label:has-text("Runs on") select').selectOption(orchestrator);
    await window.getByRole('combobox', { name: 'Access', exact: true }).selectOption('full_access');
    await window.locator('button:has-text("Create Agent")').click();
    return;
  }
  const projectId = await projectIdFor(window, FIXTURE_DIR);
  await window.locator(`[data-testid="project-${projectId}"]`).hover();
  await window.getByRole('button', { name: `New agent in ${path.basename(FIXTURE_DIR)}`, exact: true }).click();
  const page = window.getByTestId('new-agent-page');
  await expect(page).toBeVisible({ timeout: 10_000 });

  // A plain agent: Clubhouse managed is on by default in a fresh profile.
  const managed = page.getByRole('switch', { name: 'Clubhouse managed' });
  if (await managed.getAttribute('aria-checked') === 'true') await managed.click();
  await expect(managed).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('new-agent-name').fill(name);
  // Own worktree is on by default here; classic's checkbox starts off.
  await expect(page.getByRole('switch', { name: 'Own worktree and branch' })).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
  await page.locator('#new-agent-orchestrator').selectOption(orchestrator);
  await page.getByTestId('new-agent-access').selectOption('full_access');
  await page.getByTestId('new-agent-submit').click();
  // A failed create keeps the page open with its reason; show that rather than a timeout.
  await expect(async () => {
    const error = page.getByTestId('new-agent-error');
    if (await error.isVisible()) throw new Error(`New agent page: ${await error.textContent()}`);
    await expect(page).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** The agent's row doesn't show it asleep: no "Sleeping" on classic, an awake status dot on the new layout. */
async function expectNotSleeping(window: Page, row: Locator): Promise<void> {
  if (await isNewLayout(window)) {
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.locator('[data-dot]')).not.toHaveAttribute('data-dot', 'sleeping', { timeout: 5_000 });
    return;
  }
  await expect(row).not.toContainText('Sleeping', { timeout: 5_000 });
}

async function skipIfMissing(providerCase: ProviderCase): Promise<void> {
  const { available, error } = await providerCase.provider.checkAvailability();
  test.skip(!available, `${providerCase.displayName} CLI not installed${error ? ` (${error})` : ''}. Install it to run this real-CLI E2E case.`);
}

async function createThenWakeProviderAgent(providerCase: ProviderCase): Promise<void> {
  const { sleeperId, sleeperBranch, sleeperWorktree } = prepareSleepingAgent(providerCase.id);
  const createdName = `real-cli-${makeProviderSuffix(providerCase.id)}-created-${Date.now()}`;
  const createdBranch = `${createdName}/standby`;
  // Clubhouse puts an agent's worktree in .clubhouse/agents/<name>.
  const createdWorktree = path.join(AGENTS_DIR, 'agents', createdName);

  expect(fs.existsSync(PACKAGED_EXECUTABLE)).toBe(true);

  const app = await launchApp({
    experimental: { chat: false },
    executablePath: PACKAGED_EXECUTABLE,
  });
  const electronApp = app.electronApp;
  const window = app.window;
  let createdAgentId: string | null = null;

  try {
    await assertRunLayout(window);
    await addProject(electronApp, window, FIXTURE_DIR);
    await revealAgent(window, sleeperId, 15_000);

    await createDurableAgentFromUi(window, createdName, providerCase.id);

    const createdItem = window.locator(
      `[data-agent-name="${createdName}"][data-testid^="agent-item-durable_"]`,
    );
    await expect(createdItem).toBeVisible({ timeout: 20_000 });
    const createdTestId = await createdItem.getAttribute('data-testid');
    expect(createdTestId).toMatch(/^agent-item-durable_/);
    createdAgentId = createdTestId!.slice('agent-item-'.length);

    await assertCliRunning(window, createdAgentId);
    await assertFilesystemResponsive(window);

    const sleeperItem = await revealAgent(window, sleeperId);
    await sleeperItem.click();
    const wakeButton = window.locator('[data-testid="wake-button"]');
    await expect(wakeButton).toBeVisible({ timeout: 5_000 });
    if (await isNewLayout(window)) {
      // Let the row's hover card close before the click, as start-agent does.
      await window.getByTestId('chrome-title-bar').hover({ position: { x: 400, y: 19 } });
      await expect(window.getByTestId('agent-hover-card')).toHaveCount(0, { timeout: 5_000 });
    }
    await wakeButton.click();

    await assertCliRunning(window, sleeperId);
    await window.waitForTimeout(2_000);
    await expectNotSleeping(window, createdItem);
    await expectNotSleeping(window, sleeperItem);
    await assertFilesystemResponsive(window);

    await openSettings(window);
  } finally {
    if (window && !window.isClosed()) {
      await window.evaluate(async (agentIds) => {
        for (const agentId of agentIds) {
          window.clubhouse.pty.write(agentId, '/exit\r');
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await Promise.allSettled(agentIds.map((agentId) => window.clubhouse.pty.kill(agentId)));
      }, [createdAgentId, sleeperId].filter((id): id is string => Boolean(id))).catch(() => {});
    }
    await electronApp.close();
    removeWorktree(createdWorktree, createdBranch);
    removeWorktree(sleeperWorktree, sleeperBranch);
    fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
  }
}

test.describe('real CLI orchestration', () => {
  for (const providerCase of PROVIDER_CASES) {
    test(`${providerCase.displayName} can be spawned end-to-end when installed`, async () => {
      test.skip(!RUN_REAL_CLI || process.platform !== 'darwin', 'Set CLUBHOUSE_REAL_CLI_E2E=1 on macOS to run');
      await skipIfMissing(providerCase);
      await createThenWakeProviderAgent(providerCase);
    });
  }

  test('Copilot CLI rejects a deliberately invalid spawn flag', async () => {
    test.skip(!RUN_REAL_CLI || process.platform !== 'darwin', 'Set CLUBHOUSE_REAL_CLI_E2E=1 on macOS to run');
    const copilotCase = PROVIDER_CASES[0];
    await skipIfMissing(copilotCase);

    const { binary, args } = await copilotCase.provider.buildSpawnCommand({ cwd: FIXTURE_DIR });
    expect(() => execFileSync(binary, [...args, '--clubhouse-deliberately-invalid-flag'], {
      cwd: FIXTURE_DIR,
      stdio: 'pipe',
      timeout: 10_000,
    })).toThrow();
  });
});
