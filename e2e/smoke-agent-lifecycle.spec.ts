/**
 * E2E Smoke Test: Agent Lifecycle Basics
 *
 * Verifies durable agent display (from agents.json), UI-driven creation,
 * deletion via context menu, and cross-project agent isolation.
 *
 * Issue #233 — Consolidated from smoke.spec.ts + PR #257
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  FIXTURE_SMOKE,
  FIXTURE_B,
  addProject,
  assertNotBlankScreen,
  navigateToSmokeProject,
  writeAgentsJson,
  cleanupAgentsJson,
} from './smoke-helpers';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

// Unique agent name per test run to avoid collisions from retries
const AGENT_NAME = `e2e-agent-${Date.now()}`;

test.beforeAll(async () => {
  // Pre-populate durable agents so the agent list has content to render
  writeAgentsJson([
    { id: 'smoke_agent_1', name: 'smoke-alpha', color: 'indigo' },
    { id: 'smoke_agent_2', name: 'smoke-beta', color: 'green' },
  ]);

  ({ electronApp, window } = await launchApp());

  // Add smoke project (agents.json was pre-written above)
  await addProject(electronApp, window, FIXTURE_SMOKE);

  // Wait for durable agents to load asynchronously via IPC
  await expect(
    window.locator('[data-testid^="durable-drag-"]').first(),
  ).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  cleanupAgentsJson();
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// Fixture-based agents + cross-project guard
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Fixture Agents', () => {
  test('agent list is visible when project is active', async () => {
    await navigateToSmokeProject(window);
    const agentList = window.locator('[data-testid="agent-list"]');
    await expect(agentList).toBeVisible({ timeout: 5_000 });
  });

  test('durable agents from agents.json appear in list', async () => {
    // Durable agents load asynchronously after project activation
    await expect(
      window.locator('[data-agent-name="smoke-alpha"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      window.locator('[data-agent-name="smoke-beta"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    const order = await window.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
      return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
    });

    expect(order).toContain('smoke_agent_1');
    expect(order).toContain('smoke_agent_2');
  });

  test('agent names are visible in the list', async () => {
    await expect(
      window.locator('[data-agent-name="smoke-alpha"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      window.locator('[data-agent-name="smoke-beta"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('agent status displays correctly (sleeping for unstarted)', async () => {
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_1"]');
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    const itemText = await agentItem.textContent();
    expect(itemText?.toLowerCase()).toContain('sleeping');
  });

  test('clicking an agent selects it (active state)', async () => {
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_1"]');
    await agentItem.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen(window);
    const isActive = await agentItem.getAttribute('data-active');
    expect(isActive).toBe('true');
  });

  test('completed footer section is present (with regex pattern check)', async () => {
    await navigateToSmokeProject(window);
    await window.waitForTimeout(500);

    const footer = window.locator('[data-testid="completed-footer"]');
    await expect(footer).toBeVisible({ timeout: 5_000 });

    const toggle = window.locator('[data-testid="completed-toggle"]');
    const text = await toggle.textContent();
    expect(text).toMatch(/Completed \(\d+\)/);
  });

  test('agent delete button visible via hover', async () => {
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_2"]');
    await expect(agentItem).toBeVisible({ timeout: 15_000 });

    await agentItem.hover();
    await window.waitForTimeout(300);

    const deleteBtn = agentItem.locator('[data-testid="action-delete"]');
    const overflowBtn = agentItem.locator('[data-testid="action-overflow"]');

    const deleteVisible = await deleteBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    const overflowVisible = await overflowBtn.isVisible({ timeout: 2_000 }).catch(() => false);

    expect(deleteVisible || overflowVisible).toBe(true);
  });

  test('cross-project agent guard (smoke agents NOT in project-b)', async () => {
    // Add project-b and switch to it
    await addProject(electronApp, window, FIXTURE_B);
    await window.waitForTimeout(500);

    // Smoke agents should NOT be visible in project-b
    const smokeAgentVisible = await window
      .locator('[data-testid^="agent-item-smoke"]')
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    expect(smokeAgentVisible).toBe(false);

    // Switch back to smoke project for subsequent tests
    await navigateToSmokeProject(window);
  });
});

// ---------------------------------------------------------------------------
// UI dialog interactions
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Add Agent Dialog', () => {
  test('clicking "+ Agent" opens the add agent dialog', async () => {
    await navigateToSmokeProject(window);

    const addAgentBtn = window.locator('button:has-text("+ Agent")').first();
    await expect(addAgentBtn).toBeVisible({ timeout: 5_000 });
    await addAgentBtn.click();

    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  });

  test('add agent dialog has all required fields', async () => {
    const nameInput = window.locator('input[type="text"]').first();
    await expect(nameInput).toBeVisible();
    const defaultName = await nameInput.inputValue();
    expect(defaultName.length).toBeGreaterThan(0);

    const createBtn = window.locator('button:has-text("Create Agent")');
    await expect(createBtn).toBeVisible();
    const cancelBtn = window.locator('button:has-text("Cancel")');
    await expect(cancelBtn).toBeVisible();
  });

  test('cancel closes dialog without creating', async () => {
    const cancelBtn = window.locator('button:has-text("Cancel")');
    await cancelBtn.click();

    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test('submitting the form closes the dialog', async () => {
    const addAgentBtn = window.locator('button:has-text("+ Agent")').first();
    await addAgentBtn.click();

    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill a name and submit — the dialog should close regardless of
    // whether the orchestrator CLI is available (spawn may fail in CI).
    const nameInput = window.locator('input[type="text"]').first();
    await nameInput.fill('');
    await nameInput.fill(AGENT_NAME);

    const createBtn = window.locator('button:has-text("Create Agent")');
    await createBtn.click();

    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Deletion via context menu (uses pre-seeded smoke-beta — always sleeping)
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Delete via Context Menu', () => {
  test('right-click delete removes agent after confirmation', async () => {
    await navigateToSmokeProject(window);

    const item = window.locator('[data-agent-name="smoke-beta"]').first();
    await expect(item).toBeVisible({ timeout: 15_000 });

    // Open context menu
    await item.click({ button: 'right' });
    await window.waitForTimeout(500);

    const contextMenu = window.locator('[data-testid="agent-context-menu"]');
    await expect(contextMenu).toBeVisible({ timeout: 5_000 });

    const ctxDelete = window.locator('[data-testid="ctx-delete"]');
    await expect(ctxDelete).toBeVisible({ timeout: 3_000 });
    await ctxDelete.click();
    await window.waitForTimeout(500);

    // The delete/remove confirmation dialog should appear
    const removeHeader = window.locator('text=Remove smoke-beta').first();
    const deleteHeader = window.locator('text=Delete smoke-beta').first();

    const removeVisible = await removeHeader.isVisible({ timeout: 5_000 }).catch(() => false);
    const deleteVisible = await deleteHeader.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(removeVisible || deleteVisible).toBe(true);

    // Confirm deletion
    const removeBtn = window.locator('button:has-text("Remove")').last();
    const deleteBtnConfirm = window.locator('button:has-text("Delete")').last();
    const leaveBtn = window.locator('button:has-text("Leave files")');

    const canRemove = await removeBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    const canLeave = await leaveBtn.isVisible({ timeout: 1_000 }).catch(() => false);
    const canDelete = await deleteBtnConfirm.isVisible({ timeout: 1_000 }).catch(() => false);

    if (canRemove) {
      await removeBtn.click();
    } else if (canLeave) {
      await leaveBtn.click();
    } else if (canDelete) {
      await deleteBtnConfirm.click();
    }

    await window.waitForTimeout(2_000);

    const count = await window.locator('[data-agent-name="smoke-beta"]').count();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Agent creation dropdown
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Dropdown', () => {
  test('agent creation dropdown (Durable vs Quick Agent options)', async () => {
    await navigateToSmokeProject(window);

    const dropdownBtn = window.locator('button:has-text("▾")');
    await dropdownBtn.click();
    await window.waitForTimeout(300);

    const durableOption = window.locator('button:has-text("Durable")');
    const quickOption = window.locator('button:has-text("Quick Agent")');

    await expect(durableOption).toBeVisible({ timeout: 3_000 });
    await expect(quickOption).toBeVisible({ timeout: 3_000 });

    // Dismiss by clicking elsewhere
    await window.locator('.fixed.inset-0').click();
    await window.waitForTimeout(200);
  });
});
