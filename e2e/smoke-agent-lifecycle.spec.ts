/**
 * E2E Smoke Test: Agent Lifecycle Basics
 *
 * Verifies durable agent display (from agents.json), UI-driven creation,
 * deletion via context menu, and cross-project agent isolation.
 *
 * Issue #233 — Consolidated from smoke.spec.ts + PR #257. Runs on the new
 * layout, and on classic in the Classic layout E2E job (#2843). Where the two
 * layouts differ, each has its own test and skips the other's.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  FIXTURE_SMOKE,
  FIXTURE_B,
  addProject,
  assertNotBlankScreen,
  assertRunLayout,
  navigateToSmokeProject,
  projectIdFor,
  revealAgent,
  writeAgentsJson,
  cleanupAgentsJson,
} from './smoke-helpers';
import { isNewLayout } from './layout';

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
  await assertRunLayout(window);

  // Add smoke project (agents.json was pre-written above)
  await addProject(electronApp, window, FIXTURE_SMOKE);

  // Wait for durable agents to load asynchronously via IPC
  await revealAgent(window, 'smoke_agent_1');
});

/** Classic lists durable agents in draggable rows; the new layout's tree rows are the agent items. */
const durableRows = async () => window.locator(
  (await isNewLayout(window)) ? '[data-testid^="agent-item-"]' : '[data-testid^="durable-drag-"]',
);

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
    await revealAgent(window, 'smoke_agent_1');
    // Durable agents load asynchronously after project activation
    await expect(
      window.locator('[data-agent-name="smoke-alpha"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      window.locator('[data-agent-name="smoke-beta"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    const order = await (await durableRows()).evaluateAll(
      (items) => items.map((el) => el.getAttribute('data-agent-id') || ''),
    );

    expect(order).toContain('smoke_agent_1');
    expect(order).toContain('smoke_agent_2');
  });

  test('agent names are visible in the list', async () => {
    await revealAgent(window, 'smoke_agent_1');
    await expect(
      window.locator('[data-agent-name="smoke-alpha"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      window.locator('[data-agent-name="smoke-beta"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('agent status displays correctly (sleeping for unstarted)', async () => {
    if (await isNewLayout(window)) {
      // The new layout puts sleeping agents in their project's "sleeping" fold.
      const projectId = await projectIdFor(window, FIXTURE_SMOKE);
      await expect(window.locator(`[data-testid="sleeping-fold-${projectId}"]`)).toContainText('2 sleeping', { timeout: 5_000 });
      await revealAgent(window, 'smoke_agent_1');
      return;
    }
    const agentItem = window.locator('[data-testid="agent-item-smoke_agent_1"]');
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    const itemText = await agentItem.textContent();
    expect(itemText?.toLowerCase()).toContain('sleeping');
  });

  test('clicking an agent selects it (active state)', async () => {
    const agentItem = await revealAgent(window, 'smoke_agent_1');
    await agentItem.click();
    await window.waitForTimeout(500);

    await assertNotBlankScreen(window);
    const isActive = await agentItem.getAttribute('data-active');
    expect(isActive).toBe('true');
  });

  test('completed footer section is present (with regex pattern check)', async () => {
    test.skip(await isNewLayout(window), 'The Completed footer is classic only; the new layout lists finished quick agents in its tree.');
    await navigateToSmokeProject(window);
    await window.waitForTimeout(500);

    const footer = window.locator('[data-testid="completed-footer"]');
    await expect(footer).toBeVisible({ timeout: 5_000 });

    const toggle = window.locator('[data-testid="completed-toggle"]');
    const text = await toggle.textContent();
    expect(text).toMatch(/Completed \(\d+\)/);
  });

  test('agent delete button visible via hover', async () => {
    const agentItem = await revealAgent(window, 'smoke_agent_2', 15_000);

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

    if (await isNewLayout(window)) {
      // The tree shows every project at once, so the guard is that project-b's
      // group holds none of the smoke agents, and project-smoke's still does.
      const bGroup = window.locator(`[data-testid="project-group-${await projectIdFor(window, FIXTURE_B)}"]`);
      await expect(bGroup).toBeVisible({ timeout: 10_000 });
      await expect(bGroup.locator('[data-testid^="agent-item-smoke"]')).toHaveCount(0);
      await expect(bGroup.locator('[data-testid^="sleeping-fold-"]')).toHaveCount(0);
      const smokeGroup = window.locator(`[data-testid="project-group-${await projectIdFor(window, FIXTURE_SMOKE)}"]`);
      await revealAgent(window, 'smoke_agent_1');
      await expect(smokeGroup.locator('[data-testid="agent-item-smoke_agent_1"]')).toBeVisible();
      await navigateToSmokeProject(window);
      return;
    }

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
  test.beforeEach(async () => {
    test.skip(await isNewLayout(window), 'The classic "+ Agent" dialog; the new layout has the New agent page.');
  });

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
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();

    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test('submitting the form closes the dialog', async () => {
    const addAgentBtn = window.locator('button:has-text("+ Agent")').first();
    await expect(addAgentBtn).toBeVisible({ timeout: 5_000 });
    await addAgentBtn.click();

    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill a name and submit — the dialog should close regardless of
    // whether the orchestrator CLI is available (spawn may fail in CI).
    const nameInput = window.locator('input[type="text"]').first();
    await nameInput.fill('');
    await nameInput.fill(AGENT_NAME);

    const createBtn = window.locator('button:has-text("Create Agent")');
    await expect(createBtn).toBeVisible({ timeout: 5_000 });
    await createBtn.click();

    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Agent Lifecycle — New Agent Page', () => {
  const page = () => window.locator('[data-testid="new-agent-page"]');

  test.beforeEach(async () => {
    test.skip(!(await isNewLayout(window)), 'The new layout\'s New agent page; classic has the "+ Agent" dialog.');
  });

  test('the project row opens the New agent page with its fields', async () => {
    await navigateToSmokeProject(window);
    const projectId = await projectIdFor(window, FIXTURE_SMOKE);
    await window.locator(`[data-testid="project-${projectId}"]`).hover();
    await window.getByRole('button', { name: 'New agent in project-smoke', exact: true }).click();
    await expect(page()).toBeVisible({ timeout: 10_000 });

    await expect(window.locator('[data-testid="new-agent-kind-durable"]')).toHaveAttribute('aria-checked', 'true');
    await expect(window.locator('[data-testid="new-agent-name"]')).toBeVisible();
    await expect(window.locator('[data-testid="new-agent-submit"]')).toBeVisible();
    await expect(page().getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  });

  test('cancel closes the page without creating', async () => {
    await window.locator('[data-testid="new-agent-name"]').fill(AGENT_NAME);
    await page().getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page()).toBeHidden({ timeout: 5_000 });
    // Creating from this page, on a fake CLI, is layout-default.spec.ts's.
    await expect(window.locator(`[data-agent-name="${AGENT_NAME}"]`)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Deletion via context menu (uses pre-seeded smoke-beta — always sleeping)
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Delete via Context Menu', () => {
  test('right-click delete removes agent after confirmation', async () => {
    await navigateToSmokeProject(window);

    const item = await revealAgent(window, 'smoke_agent_2', 15_000);

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

    if (await isNewLayout(window)) {
      // Its row only exists while the fold is open, so count what the fold says.
      const projectId = await projectIdFor(window, FIXTURE_SMOKE);
      await expect(window.locator(`[data-testid="sleeping-fold-${projectId}"]`)).toContainText('1 sleeping', { timeout: 10_000 });
    }
    const count = await window.locator('[data-agent-name="smoke-beta"]').count();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Agent creation dropdown
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle — Dropdown', () => {
  test('the New menu offers durable and quick agents (new layout)', async () => {
    test.skip(!(await isNewLayout(window)), 'The new layout\'s New menu; classic has the "▾" dropdown.');
    await navigateToSmokeProject(window);
    await window.locator('[data-testid="chrome-new"]').click();
    await expect(window.getByRole('menuitem', { name: 'Durable agent…' })).toBeVisible({ timeout: 3_000 });
    await expect(window.getByRole('menuitem', { name: 'Quick agent…' })).toBeVisible({ timeout: 3_000 });
    // The button toggles the menu.
    await window.locator('[data-testid="chrome-new"]').click();
    await expect(window.getByRole('menuitem', { name: 'Quick agent…' })).toBeHidden({ timeout: 3_000 });
  });

  test('agent creation dropdown (Durable vs Quick Agent options)', async () => {
    test.skip(await isNewLayout(window), 'The classic "▾" dropdown; the new layout has the New menu.');
    await navigateToSmokeProject(window);

    const dropdownBtn = window.locator('button:has-text("▾")');
    await expect(dropdownBtn).toBeVisible({ timeout: 5_000 });
    await dropdownBtn.click();
    await window.waitForTimeout(300);

    const durableOption = window.locator('button:has-text("Durable")');
    const quickOption = window.locator('button:has-text("Quick Agent")');

    await expect(durableOption).toBeVisible({ timeout: 3_000 });
    await expect(quickOption).toBeVisible({ timeout: 3_000 });

    // Dismiss via the backdrop. Use force:true so Playwright fires the click
    // directly on the backdrop element without checking for pointer-interception
    // — the dropdown menu (z:50) can cover the backdrop (z:40) at the viewport
    // centre on ubuntu CI, causing a plain click() to time out.
    const backdrop = window.locator('.fixed.inset-0');
    await expect(backdrop).toBeVisible({ timeout: 5_000 });
    await backdrop.click({ force: true });
    await window.waitForTimeout(200);
  });
});
