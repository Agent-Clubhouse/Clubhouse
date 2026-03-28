/**
 * E2E tests for the Clubhouse Assistant feature.
 *
 * Tests cover panel opening, mode toggling, headless conversations,
 * structured mode streaming, tool execution, and basic Q&A.
 *
 * Tests 1-2 (panel open, mode toggle) are UI-only and run everywhere.
 * Tests 3-6 require a live orchestrator (claude-code, etc.) and are
 * skipped in CI where no orchestrator credentials are available.
 * Run locally with: npx playwright test e2e/assistant/
 *
 * Each test suite uses an isolated CLUBHOUSE_USER_DATA directory.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const hasOrchestrator = !process.env.CI;
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

// All 6 tests share one Electron instance for performance (launch is ~10s).
// Tradeoff: if an early test fails, later tests that depend on agent state may
// cascade. Each test resets the conversation to mitigate this.
test.beforeAll(async () => {
  instance = await launchAssistantInstance();
  window = instance.window;
});

test.afterAll(async () => {
  await cleanupAssistantInstance(instance);
});

// ─── Test 1: Panel opens from nav rail ───────────────────────────────────────

test('assistant panel opens when clicking nav rail icon', async () => {
  await openAssistantPanel(window);

  // Verify the assistant view is rendered
  const assistantView = window.locator('[data-testid="assistant-view"]');
  await expect(assistantView).toBeVisible({ timeout: 5_000 });

  // Verify welcome state with suggested prompts
  const emptyFeed = window.locator('[data-testid="assistant-feed-empty"]');
  await expect(emptyFeed).toBeVisible({ timeout: 5_000 });

  const suggestedPrompts = window.locator('[data-testid="suggested-prompt"]');
  const count = await suggestedPrompts.count();
  expect(count).toBeGreaterThanOrEqual(1);

  // Verify header elements are present
  const modeToggle = window.locator('[data-testid="mode-toggle"]');
  await expect(modeToggle).toBeVisible({ timeout: 5_000 });

  // Verify input bar is present
  const input = window.locator('[data-testid="assistant-input"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
});

// ─── Test 2: Mode toggle switching ───────────────────────────────────────────

test('mode toggle switches between all three modes', async () => {
  await openAssistantPanel(window);

  // Default should be headless (Chat)
  const headlessBtn = window.locator('[data-testid="mode-headless"]');
  await expect(headlessBtn).toBeVisible({ timeout: 5_000 });

  // Switch to structured mode
  await switchMode(window, 'structured');
  const structuredBtn = window.locator('[data-testid="mode-structured"]');
  // The active mode button should have the accent background class
  await expect(structuredBtn).toHaveClass(/bg-ctp-accent/, { timeout: 5_000 });

  // Switch to interactive mode
  await switchMode(window, 'interactive');
  const interactiveBtn = window.locator('[data-testid="mode-interactive"]');
  await expect(interactiveBtn).toHaveClass(/bg-ctp-accent/, { timeout: 5_000 });

  // Switch back to headless
  await switchMode(window, 'headless');
  await expect(headlessBtn).toHaveClass(/bg-ctp-accent/, { timeout: 5_000 });
});

// ─── Test 3: Headless mode launch and response ──────────────────────────────

test('assistant launches in headless mode and responds', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await openAssistantPanel(window);
  await switchMode(window, 'headless');

  // Send a simple message
  await sendAssistantMessage(window, 'What is Clubhouse?');

  // Verify user message appears in feed
  const userMsg = window.locator('[data-testid="user-message"]').first();
  await expect(userMsg).toBeVisible({ timeout: 5_000 });
  await expect(userMsg).toContainText('What is Clubhouse?');

  // Wait for assistant response (allow up to 60s for orchestrator cold-start)
  const response = await waitForAssistantResponse(window, 60_000);
  expect(response.length).toBeGreaterThan(0);
});

// ─── Test 4: Structured mode streaming ──────────────────────────────────────

test('assistant launches in structured mode with streaming', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  // Reset conversation and wait for welcome state
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });

  await switchMode(window, 'structured');

  // Send a message
  await sendAssistantMessage(window, 'Say hello in one sentence.');

  // Verify user message appears
  const userMsg = window.locator('[data-testid="user-message"]').last();
  await expect(userMsg).toBeVisible({ timeout: 5_000 });

  // Wait for streaming response — the assistant-message element should appear
  // as tokens stream in
  const response = await waitForAssistantResponse(window, 60_000);
  expect(response.length).toBeGreaterThan(0);
});

// ─── Test 5: Tool execution shows action card ───────────────────────────────

test('tool execution produces action card or project-related response', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  // Reset conversation and wait for welcome state
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });

  await switchMode(window, 'headless');

  // Ask something that should trigger a tool call
  await sendAssistantMessage(window, 'Use the list_projects tool to show my projects.');

  // Wait for a response — either an action card (tool was called and rendered)
  // or an assistant message (tool result was inlined into text)
  const actionCard = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsg = window.locator('[data-testid="assistant-message"]');

  // First, wait for any feed content to appear
  const feedContent = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await feedContent.waitFor({ state: 'visible', timeout: 60_000 });

  // Verify: either an action card appeared (tool was visibly called) OR
  // the response text references projects/tools (tool was called but result
  // was inlined). A pure hallucinated response with no project context fails.
  const actionCardCount = await actionCard.count();
  if (actionCardCount > 0) {
    // Action card present — tool execution is visible. Pass.
    expect(actionCardCount).toBeGreaterThan(0);
  } else {
    // No action card — verify the response content references projects
    const responseText = (await assistantMsg.first().textContent()) || '';
    const mentionsProjects = /project/i.test(responseText);
    expect(mentionsProjects).toBe(true);
  }
});

// ─── Test 6: Basic conversation with non-empty response ─────────────────────

test('basic conversation returns meaningful response', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  // Reset conversation and wait for welcome state
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await expect(window.locator('[data-testid="assistant-feed-empty"]')).toBeVisible({ timeout: 10_000 });

  await switchMode(window, 'headless');

  // Ask a question the assistant should be able to answer
  await sendAssistantMessage(window, 'What can you help me with?');

  // Wait for response
  const response = await waitForAssistantResponse(window, 60_000);

  // Response should be meaningful (not just a few characters)
  expect(response.length).toBeGreaterThan(10);
});
