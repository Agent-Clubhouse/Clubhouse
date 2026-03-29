/**
 * E2E tests for the Clubhouse Assistant feature.
 *
 * Tests 1-9 are UI-only and run everywhere (including CI without orchestrator).
 * Tests 10-15 require a live orchestrator and are skipped in CI.
 *
 * Each test resets the assistant to ensure independence — no cascade failures.
 * All tests share one Electron instance for performance (~10s launch).
 *
 * Run locally: npx playwright test e2e/assistant/assistant.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const hasOrchestrator = !process.env.CI;
import {
  AssistantInstance,
  launchAssistantInstance,
  cleanupAssistantInstance,
  openAssistantPanel,
  closeAssistantPanel,
  resetAssistant,
  sendAssistantMessage,
  waitForAssistantResponse,
  waitForFeedContent,
  switchMode,
} from './helpers';

let instance: AssistantInstance;
let window: Page;
const pageErrors: Error[] = [];

test.beforeAll(async () => {
  instance = await launchAssistantInstance();
  window = instance.window;
  window.on('pageerror', (error) => pageErrors.push(error));
});

test.afterAll(async () => {
  await cleanupAssistantInstance(instance);
});

// Clear errors before each test for independence
test.beforeEach(() => {
  pageErrors.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// CI-SAFE TESTS — No orchestrator needed (tests 1-9)
// ═══════════════════════════════════════════════════════════════════════════

// ─── 1: Panel opens without render errors ─────────────────────────────────

test('panel opens without render errors', async () => {
  await openAssistantPanel(window);

  expect(pageErrors).toHaveLength(0);

  const assistantView = window.locator('[data-testid="assistant-view"]');
  await expect(assistantView).toBeVisible({ timeout: 5_000 });
});

// ─── 2: Render crash smoke test ───────────────────────────────────────────

test('panel renders without crashes after settling', async () => {
  await openAssistantPanel(window);
  await window.waitForTimeout(2_000);

  expect(pageErrors).toHaveLength(0);

  const feedOrEmpty = window.locator(
    '[data-testid="assistant-feed"], [data-testid="assistant-feed-empty"]',
  ).first();
  await expect(feedOrEmpty).toBeVisible({ timeout: 5_000 });

  const input = window.locator('[data-testid="assistant-message-input"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeEnabled({ timeout: 5_000 });
});

// ─── 3: Welcome state shows suggestion chips ──────────────────────────────

test('welcome state shows suggestion chips', async () => {
  await resetAssistant(window);

  const emptyFeed = window.locator('[data-testid="assistant-feed-empty"]');
  await expect(emptyFeed).toBeVisible({ timeout: 5_000 });

  const chips = window.locator('[data-testid="suggested-prompt"]');
  const count = await chips.count();
  expect(count).toBeGreaterThanOrEqual(4);
});

// ─── 4: Header shows status and controls ──────────────────────────────────

test('header shows status line and controls', async () => {
  await openAssistantPanel(window);

  const header = window.locator('[data-testid="assistant-header"]');
  await expect(header).toBeVisible({ timeout: 5_000 });

  const status = window.locator('[data-testid="assistant-status"]');
  await expect(status).toBeVisible({ timeout: 5_000 });

  const modeToggle = window.locator('[data-testid="mode-toggle"]');
  await expect(modeToggle).toBeVisible({ timeout: 5_000 });

  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await expect(resetBtn).toBeVisible({ timeout: 5_000 });
});

// ─── 5: Mode toggle switches between all three modes ─────────────────────

test('mode toggle switches between all three modes', async () => {
  await openAssistantPanel(window);

  // Switch to structured
  await switchMode(window, 'structured');
  const structuredBtn = window.locator('[data-testid="mode-structured"]');
  await expect(structuredBtn).toHaveClass(/bg-ctp-accent/, { timeout: 5_000 });

  // Switch to interactive
  await switchMode(window, 'interactive');
  const interactiveBtn = window.locator('[data-testid="mode-interactive"]');
  await expect(interactiveBtn).toHaveClass(/bg-ctp-accent/, { timeout: 5_000 });

  // Switch back to headless
  await switchMode(window, 'headless');
  const headlessBtn = window.locator('[data-testid="mode-headless"]');
  await expect(headlessBtn).toHaveClass(/bg-ctp-accent/, { timeout: 5_000 });
});

// ─── 6: Panel toggle open/close cycle ─────────────────────────────────────

test('panel toggles open and closed correctly', async () => {
  // Ensure closed first
  await closeAssistantPanel(window);

  const assistantView = window.locator('[data-testid="assistant-view"]');
  await expect(assistantView).not.toBeVisible({ timeout: 5_000 });

  // Open
  await openAssistantPanel(window);
  await expect(assistantView).toBeVisible({ timeout: 5_000 });

  // Close
  await closeAssistantPanel(window);
  await expect(assistantView).not.toBeVisible({ timeout: 5_000 });

  // Re-open (idempotent check)
  await openAssistantPanel(window);
  await expect(assistantView).toBeVisible({ timeout: 5_000 });
});

// ─── 7: Reset clears conversation and shows welcome ───────────────────────

test('reset button clears conversation and shows welcome state', async () => {
  await openAssistantPanel(window);

  const resetBtn = window.locator('[data-testid="assistant-reset-button"]');
  await resetBtn.click();

  const emptyFeed = window.locator('[data-testid="assistant-feed-empty"]');
  await expect(emptyFeed).toBeVisible({ timeout: 10_000 });

  const chips = window.locator('[data-testid="suggested-prompt"]');
  const count = await chips.count();
  expect(count).toBeGreaterThanOrEqual(1);
});

// ─── 8: Input bar is functional ───────────────────────────────────────────

test('input bar accepts text and has send button', async () => {
  await openAssistantPanel(window);

  const input = window.locator('[data-testid="assistant-message-input"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeEnabled({ timeout: 5_000 });

  // Type something
  await input.fill('test message');
  await expect(input).toHaveValue('test message');

  // Send button should be visible
  const sendBtn = window.locator('[data-testid="assistant-send-button"]');
  await expect(sendBtn).toBeVisible({ timeout: 5_000 });

  // Clear the input to avoid side effects
  await input.fill('');
});

// ─── 9: Suggestion chip populates input ───────────────────────────────────

test('clicking suggestion chip sends message', async () => {
  await resetAssistant(window);

  const chip = window.locator('[data-testid="suggested-prompt"]').first();
  await expect(chip).toBeVisible({ timeout: 5_000 });

  // Click the chip — it should send the message
  await chip.click();

  // User message should appear in feed (chip text becomes user message)
  const userMsg = window.locator('[data-testid="user-message"]').first();
  await expect(userMsg).toBeVisible({ timeout: 10_000 });

  // No render errors from the interaction
  expect(pageErrors).toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR TESTS — Require live orchestrator (tests 10-15)
// ═══════════════════════════════════════════════════════════════════════════

// ─── 10: Headless mode launch and response ────────────────────────────────

test('headless mode: sends message and gets response', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(window, 'What is Clubhouse?');

  const userMsg = window.locator('[data-testid="user-message"]').first();
  await expect(userMsg).toBeVisible({ timeout: 5_000 });
  await expect(userMsg).toContainText('What is Clubhouse?');

  const response = await waitForAssistantResponse(window, 60_000);
  expect(response.length).toBeGreaterThan(0);
});

// ─── 11: Structured mode streaming ────────────────────────────────────────

test('structured mode: sends message and gets streaming response', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'structured');

  await sendAssistantMessage(window, 'Say hello in one sentence.');

  const userMsg = window.locator('[data-testid="user-message"]').last();
  await expect(userMsg).toBeVisible({ timeout: 5_000 });

  const response = await waitForAssistantResponse(window, 60_000);
  expect(response.length).toBeGreaterThan(0);
});

// ─── 12: Tool execution shows action card ─────────────────────────────────

test('headless mode: tool call produces action card or project response', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(window, 'Use the list_projects tool to show my projects.');

  await waitForFeedContent(window, 60_000);

  const actionCards = window.locator('[data-testid="assistant-action-card"]');
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCardCount = await actionCards.count();

  if (actionCardCount > 0) {
    expect(actionCardCount).toBeGreaterThan(0);
  } else {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    expect(/project/i.test(responseText)).toBe(true);
  }
});

// ─── 13: Meaningful conversation response ─────────────────────────────────

test('headless mode: returns meaningful response to open question', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(window, 'What can you help me with?');

  const response = await waitForAssistantResponse(window, 60_000);
  expect(response.length).toBeGreaterThan(10);
});

// ─── 14: Search help integration ──────────────────────────────────────────

test('headless mode: assistant uses search_help for feature questions', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  await sendAssistantMessage(window, 'What is a canvas and how do I create one?');

  await waitForFeedContent(window, 60_000);

  // Should get either an action card (search_help tool) or a response about canvases
  const assistantMsgs = window.locator('[data-testid="assistant-message"]');
  const actionCards = window.locator('[data-testid="assistant-action-card"]');

  const msgCount = await assistantMsgs.count();
  const cardCount = await actionCards.count();
  expect(msgCount + cardCount).toBeGreaterThan(0);

  if (msgCount > 0) {
    const responseText = (await assistantMsgs.first().textContent()) || '';
    expect(/canvas/i.test(responseText)).toBe(true);
  }
});

// ─── 15: Multi-turn conversation ──────────────────────────────────────────

test('headless mode: multi-turn conversation retains context', async () => {
  test.skip(!hasOrchestrator, 'Requires live orchestrator — skipped in CI');
  await resetAssistant(window);
  await switchMode(window, 'headless');

  // First message
  await sendAssistantMessage(window, 'My name is TestUser.');
  await waitForAssistantResponse(window, 60_000);

  // Follow-up that requires context
  await sendAssistantMessage(window, 'What is my name?');

  // Wait for the second response
  const allMsgs = window.locator('[data-testid="assistant-message"]');
  // Should have at least 2 assistant messages now
  await expect(allMsgs.nth(1)).toBeVisible({ timeout: 60_000 });

  const secondResponse = (await allMsgs.nth(1).textContent()) || '';
  expect(secondResponse.length).toBeGreaterThan(0);
  // The response should reference "TestUser" if context is retained
  expect(/testuser/i.test(secondResponse)).toBe(true);
});
