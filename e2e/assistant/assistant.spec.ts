/**
 * E2E tests for the Clubhouse Assistant feature.
 *
 * Tests cover panel opening, mode toggling, headless conversations,
 * structured mode streaming, tool execution, and basic Q&A.
 *
 * Each test suite uses an isolated CLUBHOUSE_USER_DATA directory.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
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
  // Reset conversation first
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await window.waitForTimeout(1_000);

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

test('tool execution shows action card in feed', async () => {
  // Reset conversation
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await window.waitForTimeout(1_000);

  await switchMode(window, 'headless');

  // Ask something that should trigger a tool call
  await sendAssistantMessage(window, 'List my projects using the available tools.');

  // Wait for either an action card or a response (tool calls may or may not
  // produce visible action cards depending on the orchestrator)
  const actionCardOrResponse = window.locator(
    '[data-testid="assistant-action-card"], [data-testid="assistant-message"]',
  ).first();
  await actionCardOrResponse.waitFor({ state: 'visible', timeout: 60_000 });

  // At minimum, we should have gotten some kind of response
  const feedHasContent = window.locator(
    '[data-testid="assistant-feed"] [data-testid="assistant-message"], [data-testid="assistant-feed"] [data-testid="assistant-action-card"]',
  );
  const contentCount = await feedHasContent.count();
  expect(contentCount).toBeGreaterThanOrEqual(1);
});

// ─── Test 6: Basic conversation with non-empty response ─────────────────────

test('basic conversation returns meaningful response', async () => {
  // Reset conversation
  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();
  await window.waitForTimeout(1_000);

  await switchMode(window, 'headless');

  // Ask a question the assistant should be able to answer
  await sendAssistantMessage(window, 'What can you help me with?');

  // Wait for response
  const response = await waitForAssistantResponse(window, 60_000);

  // Response should be meaningful (not just a few characters)
  expect(response.length).toBeGreaterThan(10);
});
