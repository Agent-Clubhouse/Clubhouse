import { test, expect, _electron as electron, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeCodeProvider, CodexCliProvider, CopilotCliProvider } from '../src/main/orchestrators';
import { launchApp } from './launch';
import { addProject } from './smoke-helpers';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
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

async function skipIfMissing(providerCase: ProviderCase): Promise<void> {
  const { available, error } = await providerCase.provider.checkAvailability();
  test.skip(!available, `${providerCase.displayName} CLI not installed${error ? ` (${error})` : ''}. Install it to run this real-CLI E2E case.`);
}

async function createThenWakeProviderAgent(providerCase: ProviderCase): Promise<void> {
  const { sleeperId, sleeperBranch, sleeperWorktree } = prepareSleepingAgent(providerCase.id);
  const createdName = `real-cli-${makeProviderSuffix(providerCase.id)}-created-${Date.now()}`;
  const createdBranch = `${createdName}/standby`;
  const createdWorktree = path.join(AGENTS_DIR, createdName);

  expect(fs.existsSync(PACKAGED_EXECUTABLE)).toBe(true);

  const app = await launchApp({
    experimental: {},
    executablePath: PACKAGED_EXECUTABLE,
  });
  const electronApp = app.electronApp;
  const window = app.window;
  let createdAgentId: string | null = null;

  try {
    await addProject(electronApp, window, FIXTURE_DIR);
    await expect(window.locator(`[data-testid="agent-item-${sleeperId}"]`)).toBeVisible({ timeout: 15_000 });

    await window.locator('button:has-text("+ Agent")').first().click();
    await expect(window.locator('h2:has-text("New Agent")')).toBeVisible({ timeout: 5_000 });

    await window.locator('input[type="text"]').first().fill(createdName);
    await window.getByText('Use git worktree', { exact: false }).click();
    await window.locator('label:has-text("Orchestrator") select').selectOption(providerCase.id);
    await window.locator('label:has-text("Free Agent Mode") input').check();
    await window.locator('button:has-text("Create Agent")').click();

    const createdItem = window.locator(
      `[data-agent-name="${createdName}"][data-testid^="agent-item-durable_"]`,
    );
    await expect(createdItem).toBeVisible({ timeout: 20_000 });
    const createdTestId = await createdItem.getAttribute('data-testid');
    expect(createdTestId).toMatch(/^agent-item-durable_/);
    createdAgentId = createdTestId!.slice('agent-item-'.length);

    await assertCliRunning(window, createdAgentId);
    await assertFilesystemResponsive(window);

    const sleeperItem = window.locator(`[data-testid="agent-item-${sleeperId}"]`);
    await sleeperItem.click();
    const wakeButton = window.locator('[data-testid="wake-button"]');
    await expect(wakeButton).toBeVisible({ timeout: 5_000 });
    await wakeButton.click();

    await assertCliRunning(window, sleeperId);
    await window.waitForTimeout(2_000);
    await expect(createdItem).not.toContainText('Sleeping', { timeout: 5_000 });
    await expect(sleeperItem).not.toContainText('Sleeping', { timeout: 5_000 });
    await assertFilesystemResponsive(window);

    await window.locator('[data-testid="nav-settings"]').click();
    await expect(window.locator('[data-testid="title-bar"]')).toContainText('Settings', { timeout: 5_000 });
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
});
