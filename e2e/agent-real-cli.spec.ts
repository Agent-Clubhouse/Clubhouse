import { test, expect, _electron as electron, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { launchApp } from './launch';
import { addProject } from './smoke-helpers';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

const RUN_REAL_CLI = process.env.CLUBHOUSE_REAL_CLI_E2E === '1';
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/project-agent-transition');
const AGENTS_DIR = path.join(FIXTURE_DIR, '.clubhouse');
const AGENTS_JSON = path.join(AGENTS_DIR, 'agents.json');
const SLEEPER_ID = 'real_cli_sleeping_agent';
const SLEEPER_NAME = 'real-cli-sleeper';
const SLEEPER_BRANCH = `${SLEEPER_NAME}/standby`;
const SLEEPER_WORKTREE = path.join(AGENTS_DIR, SLEEPER_NAME);
const CREATED_NAME = `real-cli-created-${Date.now()}`;
const CREATED_BRANCH = `${CREATED_NAME}/standby`;
const CREATED_WORKTREE = path.join(AGENTS_DIR, CREATED_NAME);
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

let electronApp: ElectronApp;
let window: Page;
let createdAgentId: string | null = null;

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

function prepareSleepingAgent(): void {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  removeWorktree(SLEEPER_WORKTREE, SLEEPER_BRANCH);
  removeWorktree(CREATED_WORKTREE, CREATED_BRANCH);
  runGit(['worktree', 'add', '-b', SLEEPER_BRANCH, SLEEPER_WORKTREE, 'HEAD']);
  fs.writeFileSync(
    AGENTS_JSON,
    JSON.stringify(
      [{
        id: SLEEPER_ID,
        name: SLEEPER_NAME,
        color: 'green',
        branch: SLEEPER_BRANCH,
        worktreePath: SLEEPER_WORKTREE,
        createdAt: new Date().toISOString(),
        orchestrator: 'copilot-cli',
        freeAgentMode: true,
      }],
      null,
      2,
    ),
    'utf-8',
  );
}

async function ptyBuffer(agentId: string): Promise<string> {
  return window.evaluate(
    async (id) => window.clubhouse.pty.getBuffer(id),
    agentId,
  );
}

async function assertCopilotRunning(agentId: string): Promise<void> {
  await expect.poll(
    async () => (await ptyBuffer(agentId)).length,
    { timeout: 30_000 },
  ).toBeGreaterThan(1_000);
}

async function assertFilesystemResponsive(): Promise<void> {
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

test.skip(!RUN_REAL_CLI || process.platform !== 'darwin', 'Set CLUBHOUSE_REAL_CLI_E2E=1 on macOS to run');

test.beforeAll(async () => {
  expect(fs.existsSync(PACKAGED_EXECUTABLE)).toBe(true);
  prepareSleepingAgent();
  ({ electronApp, window } = await launchApp({
    experimental: {},
    executablePath: PACKAGED_EXECUTABLE,
  }));
  expect(await electronApp.evaluate(() => process.env.UV_THREADPOOL_SIZE)).toBeUndefined();
  await addProject(electronApp, window, FIXTURE_DIR);
  await expect(
    window.locator(`[data-testid="agent-item-${SLEEPER_ID}"]`),
  ).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (window && !window.isClosed()) {
    await window.evaluate(async (agentIds) => {
      for (const agentId of agentIds) {
        window.clubhouse.pty.write(agentId, '/exit\r');
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await Promise.allSettled(agentIds.map((agentId) => window.clubhouse.pty.kill(agentId)));
    }, [createdAgentId, SLEEPER_ID].filter((id): id is string => Boolean(id))).catch(() => {});
  }
  await electronApp?.close();
  removeWorktree(CREATED_WORKTREE, CREATED_BRANCH);
  removeWorktree(SLEEPER_WORKTREE, SLEEPER_BRANCH);
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
});

test('packaged app creates then wakes real Copilot agents without starving filesystem work', async () => {
  await window.locator('button:has-text("+ Agent")').first().click();
  await expect(window.locator('h2:has-text("New Agent")')).toBeVisible({ timeout: 5_000 });

  await window.locator('input[type="text"]').first().fill(CREATED_NAME);
  await window.getByText('Use git worktree', { exact: false }).click();
  await window.locator('label:has-text("Orchestrator") select').selectOption('copilot-cli');
  await window.locator('label:has-text("Free Agent Mode") input').check();
  await window.locator('button:has-text("Create Agent")').click();

  const createdItem = window.locator(
    `[data-agent-name="${CREATED_NAME}"][data-testid^="agent-item-durable_"]`,
  );
  await expect(createdItem).toBeVisible({ timeout: 20_000 });
  const createdTestId = await createdItem.getAttribute('data-testid');
  expect(createdTestId).toMatch(/^agent-item-durable_/);
  createdAgentId = createdTestId!.slice('agent-item-'.length);

  await assertCopilotRunning(createdAgentId);
  await assertFilesystemResponsive();

  const sleeperItem = window.locator(`[data-testid="agent-item-${SLEEPER_ID}"]`);
  await sleeperItem.click();
  const wakeButton = window.locator('[data-testid="wake-button"]');
  await expect(wakeButton).toBeVisible({ timeout: 5_000 });
  await wakeButton.click();

  await assertCopilotRunning(SLEEPER_ID);
  await window.waitForTimeout(2_000);
  await expect(createdItem).not.toContainText('Sleeping', { timeout: 5_000 });
  await expect(sleeperItem).not.toContainText('Sleeping', { timeout: 5_000 });
  await assertFilesystemResponsive();

  await window.locator('[data-testid="nav-settings"]').click();
  await expect(window.locator('[data-testid="title-bar"]')).toContainText('Settings', { timeout: 5_000 });
});
