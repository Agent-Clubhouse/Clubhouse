/**
 * E2E tests for the Clubhouse Assistant — Builder persona flow.
 *
 * All tests require a live orchestrator and are skipped in CI.
 * Each test resets the assistant for independence.
 *
 * Run locally: npx playwright test e2e/assistant/builder-persona.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';

const hasOrchestrator = !process.env.CI;
import * as path from 'path';
import * as os from 'os';
import {
  AssistantInstance,
  launchAssistantInstance,
  cleanupAssistantInstance,
  openAssistantPanel,
  resetAssistant,
  sendAssistantMessage,
  waitForFeedContent,
  switchMode,
} from './helpers';

let instance: AssistantInstance;
let window: Page;
let testProjectDir: string;

test.beforeAll(async () => {
  instance = await launchAssistantInstance();
  window = instance.window;

  // Create a temporary directory to serve as a test project
  testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-builder-project-'));
  const { execSync } = await import('child_process');
  execSync('git init', { cwd: testProjectDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', {
    cwd: testProjectDir,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  });
});

test.afterAll(async () => {
  await cleanupAssistantInstance(instance);
  try {
    fs.rmSync(testProjectDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ─── 1: Add a project ─────────────────────────────────────────────────────

test('assistant can add a project via tool call', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(window, `Add the project at ${testProjectDir} to Clubhouse.`);

  await waitForFeedContent(window, 60_000);

  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    const cardText = await actionCards.first().textContent();
    expect(cardText).toBeTruthy();
  } else {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    expect(/project|added|configured/i.test(responseText)).toBe(true);
  }
});

// ─── 2: Create an agent ───────────────────────────────────────────────────

test('assistant can create an agent via tool call', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(
    window,
    'Create a new agent called "test-builder-agent" in the most recently added project. Use the default orchestrator.',
  );

  await waitForFeedContent(window, 60_000);

  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    const cardText = await actionCards.first().textContent();
    expect(cardText).toBeTruthy();
  } else {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    expect(/agent|created|test-builder-agent/i.test(responseText)).toBe(true);
  }
});

// ─── 3: Create a canvas with cards ────────────────────────────────────────

test('assistant can create a canvas with cards via tool call', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(
    window,
    'Create a new canvas called "Test Canvas" and add two agent cards to it.',
  );

  await waitForFeedContent(window, 60_000);

  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    const cardTexts = await actionCards.allTextContents();
    expect(cardTexts.join(' ').length).toBeGreaterThan(0);
  } else {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    expect(/canvas|created|card/i.test(responseText)).toBe(true);
  }
});

// ─── 4: Multi-step scaffolding ────────────────────────────────────────────

test('assistant handles multi-step scaffolding request', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(
    window,
    'I need a debugging workspace. List my current projects, then create a canvas called "Debug Board" for tracking issues.',
  );

  await waitForFeedContent(window, 60_000);

  // Wait for multi-step execution
  await window.waitForTimeout(5_000);

  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const totalItems = (await actionCards.count()) + (await assistantMsgs.count());

  expect(totalItems).toBeGreaterThanOrEqual(1);

  if ((await assistantMsgs.count()) > 0) {
    const allText = (await assistantMsgs.allTextContents()).join(' ');
    expect(allText.length).toBeGreaterThan(20);
  }
});
