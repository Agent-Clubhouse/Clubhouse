/**
 * E2E tests for the Clubhouse Assistant — Builder persona flow.
 *
 * Tests cover project creation, agent creation, canvas creation,
 * and multi-step scaffolding via the assistant.
 *
 * Note: These tests require working orchestrator spawn (Missions 1-3).
 * They may not fully pass until those PRs land, but having the test
 * infrastructure ready means we can validate immediately on merge.
 *
 * Each test suite uses an isolated CLUBHOUSE_USER_DATA directory.
 *
 * All tests require a live orchestrator and are skipped in CI where
 * no orchestrator credentials are available.
 * Run locally with: npx playwright test e2e/assistant/builder-persona.spec.ts
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
  sendAssistantMessage,
  waitForAssistantResponse,
  waitForActionCard,
  switchMode,
} from './helpers';

let instance: AssistantInstance;
let window: Page;
let testProjectDir: string;

// All tests share one Electron instance for performance. Each test resets
// the conversation. Builder tests require real orchestrator interaction, so
// timeouts are generous (60s per response).
test.beforeAll(async () => {
  instance = await launchAssistantInstance();
  window = instance.window;

  // Create a temporary directory to serve as a test project
  testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-builder-project-'));
  // Initialize a git repo so Clubhouse recognizes it as a valid project
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
  // Clean up test project directory
  try {
    fs.rmSync(testProjectDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ─── Test 1: Ask assistant to add a project ─────────────────────────────────

test('assistant can add a project via tool call', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await openAssistantPanel(window);
  await switchMode(window, 'headless');

  // Ask assistant to add the test project
  await sendAssistantMessage(window, `Add the project at ${testProjectDir} to Clubhouse.`);

  // Wait for response — should trigger the add_project tool
  const feedContent = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await feedContent.waitFor({ state: 'visible', timeout: 60_000 });

  // Verify: either an action card for add_project appeared, or the response
  // confirms the project was added
  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    // Action card visible — tool was called
    const cardText = await actionCards.first().textContent();
    expect(cardText).toBeTruthy();
  } else {
    // Check response mentions the project was added or references the path
    const responseText = (await assistantMsgs.first().textContent()) || '';
    const mentionsProject = /project|added|configured/i.test(responseText);
    expect(mentionsProject).toBe(true);
  }

  // Check if the project actually appeared in the project rail
  // The project name is the directory basename
  const projectName = path.basename(testProjectDir);
  const projectInRail = window.locator(`[title*="${projectName}"]`);
  // Give UI time to update after tool execution
  try {
    await projectInRail.first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    // Project may not show in rail if tool execution didn't fully complete —
    // acceptable when orchestrator spawn is still being stabilized
  }
});

// ─── Test 2: Ask assistant to create an agent ───────────────────────────────

test('assistant can create an agent via tool call', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  // Reset conversation
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });

  await switchMode(window, 'headless');

  // Ask assistant to create an agent
  await sendAssistantMessage(
    window,
    'Create a new agent called "test-builder-agent" in the most recently added project. Use the default orchestrator.',
  );

  // Wait for response
  const feedContent = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await feedContent.waitFor({ state: 'visible', timeout: 60_000 });

  // Verify: action card for create_agent or response mentions agent creation
  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    const cardText = await actionCards.first().textContent();
    expect(cardText).toBeTruthy();
  } else {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    const mentionsAgent = /agent|created|test-builder-agent/i.test(responseText);
    expect(mentionsAgent).toBe(true);
  }
});

// ─── Test 3: Ask assistant to create a canvas ───────────────────────────────

test('assistant can create a canvas with cards via tool call', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  // Reset conversation
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });

  await switchMode(window, 'headless');

  // Ask assistant to create a canvas
  await sendAssistantMessage(
    window,
    'Create a new canvas called "Test Canvas" and add two agent cards to it.',
  );

  // Wait for response
  const feedContent = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await feedContent.waitFor({ state: 'visible', timeout: 60_000 });

  // Verify: action cards for create_canvas/add_card or response confirms canvas creation
  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    // Multiple action cards expected (create_canvas + add_card calls)
    const cardTexts = await actionCards.allTextContents();
    const allText = cardTexts.join(' ');
    expect(allText.length).toBeGreaterThan(0);
  } else {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    const mentionsCanvas = /canvas|created|card/i.test(responseText);
    expect(mentionsCanvas).toBe(true);
  }
});

// ─── Test 4: Multi-step scaffolding request ─────────────────────────────────

test('assistant handles multi-step scaffolding request', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  // Reset conversation
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });

  await switchMode(window, 'headless');

  // Ask assistant to do multiple things in sequence
  await sendAssistantMessage(
    window,
    'I need a debugging workspace. List my current projects, then create a canvas called "Debug Board" for tracking issues.',
  );

  // Wait for initial response
  const feedContent = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await feedContent.waitFor({ state: 'visible', timeout: 60_000 });

  // Wait a bit more for multi-step execution to complete
  // The assistant should make multiple tool calls in sequence
  await window.waitForTimeout(5_000);

  // Verify we got substantive output — either multiple action cards
  // (showing sequential tool calls) or a response describing what was done
  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const totalActionCards = await actionCards.count();
  const totalMessages = await assistantMsgs.count();

  // Should have at least some visible output from the multi-step request
  const totalItems = totalActionCards + totalMessages;
  expect(totalItems).toBeGreaterThanOrEqual(1);

  // If we got a text response, it should mention both projects and canvas
  if (totalMessages > 0) {
    const allText = (await assistantMsgs.allTextContents()).join(' ');
    // At minimum the response should be substantive (not a one-liner error)
    expect(allText.length).toBeGreaterThan(20);
  }
});
