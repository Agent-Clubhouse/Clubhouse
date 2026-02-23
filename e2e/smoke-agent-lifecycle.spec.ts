/**
 * E2E Smoke Test: Agent Lifecycle Basics
 *
 * Verifies durable agent creation, display in the agent list, status rendering,
 * and deletion flow. Tests the full create → verify → delete → verify-removed
 * lifecycle that has zero E2E coverage.
 *
 * Issue #233 — Sub-test (b)
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const AGENT_NAME = 'e2e-test-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stubDialogForPath(dirPath: string) {
  await electronApp.evaluate(
    async ({ dialog, BrowserWindow }, fixturePath) => {
      const win =
        BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().startsWith('devtools://'),
        ) ?? BrowserWindow.getAllWindows()[0] ?? null;
      BrowserWindow.getFocusedWindow = () => win;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fixturePath],
      });
    },
    dirPath,
  );
}

async function addProject(dirPath: string) {
  await stubDialogForPath(dirPath);
  const addBtn = window.locator('[data-testid="nav-add-project"]');
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await addProject(FIXTURE_A);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Agent List — Initial State
// ---------------------------------------------------------------------------

test.describe('Agent Lifecycle', () => {
  test('agent list is visible when project is active', async () => {
    const agentList = window.locator('[data-testid="agent-list"]');
    await expect(agentList).toBeVisible({ timeout: 5_000 });
  });

  test('completed footer section is present', async () => {
    const completedFooter = window.locator('[data-testid="completed-footer"]');
    await expect(completedFooter).toBeVisible({ timeout: 5_000 });

    // The completed toggle should show a count
    const completedToggle = window.locator('[data-testid="completed-toggle"]');
    await expect(completedToggle).toBeVisible({ timeout: 3_000 });
    const toggleText = await completedToggle.textContent();
    expect(toggleText).toContain('Completed');
  });

  // ---------------------------------------------------------------------------
  // 2. Create Agent — Open Dialog
  // ---------------------------------------------------------------------------

  test('clicking "+ Agent" opens the add agent dialog', async () => {
    // Click the main "+ Agent" button (not the dropdown caret)
    const addAgentBtn = window.locator('button:has-text("+ Agent")').first();
    await expect(addAgentBtn).toBeVisible({ timeout: 5_000 });
    await addAgentBtn.click();

    // The dialog overlay should appear
    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  });

  test('add agent dialog has all required fields', async () => {
    // Name field with a pre-generated name
    const nameInput = window.locator('input[type="text"]').first();
    await expect(nameInput).toBeVisible();
    const defaultName = await nameInput.inputValue();
    expect(defaultName.length).toBeGreaterThan(0);

    // Color selector — round color buttons
    const roundButtons = window.locator('.rounded-full.cursor-pointer');
    const colorCount = await roundButtons.count();
    expect(colorCount).toBeGreaterThan(0);

    // Model selector
    const modelSelect = window.locator('select').first();
    await expect(modelSelect).toBeVisible();

    // Create Agent button
    const createBtn = window.locator('button:has-text("Create Agent")');
    await expect(createBtn).toBeVisible();

    // Cancel button
    const cancelBtn = window.locator('button:has-text("Cancel")');
    await expect(cancelBtn).toBeVisible();
  });

  test('cancel closes the dialog without creating an agent', async () => {
    const cancelBtn = window.locator('button:has-text("Cancel")');
    await cancelBtn.click();

    // Dialog should close
    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  // ---------------------------------------------------------------------------
  // 3. Create Agent — Submit Form
  // ---------------------------------------------------------------------------

  test('creating a durable agent adds it to the agent list', async () => {
    // Open the dialog again
    const addAgentBtn = window.locator('button:has-text("+ Agent")').first();
    await addAgentBtn.click();

    const dialog = window.locator('h2:has-text("New Agent")');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Set the known test name
    const nameInput = window.locator('input[type="text"]').first();
    await nameInput.fill('');
    await nameInput.fill(AGENT_NAME);

    // Submit the form
    const createBtn = window.locator('button:has-text("Create Agent")');
    await createBtn.click();

    // Dialog should close
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // Wait for agent to appear in the list
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    await expect(agentItem).toBeVisible({ timeout: 15_000 });
  });

  // ---------------------------------------------------------------------------
  // 4. Verify Agent Status Display
  // ---------------------------------------------------------------------------

  test('created agent shows correct status', async () => {
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    // The agent should display a status text (Running or Sleeping)
    const statusText = await agentItem.textContent();
    const hasValidStatus =
      statusText!.includes('Running') ||
      statusText!.includes('Sleeping') ||
      statusText!.includes('Thinking');
    expect(hasValidStatus).toBe(true);
  });

  test('created agent shows name correctly', async () => {
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    const text = await agentItem.textContent();
    expect(text).toContain(AGENT_NAME);
  });

  test('agent appears in the "All" section for durable agents', async () => {
    // The "All" header should be visible since we have a durable agent
    const allHeader = window.locator('text=All').first();
    await expect(allHeader).toBeVisible({ timeout: 3_000 });

    // The agent should be within the agent list content
    const listContent = window.locator('[data-testid="agent-list-content"]');
    await expect(listContent).toBeVisible();
    const contentText = await listContent.textContent();
    expect(contentText).toContain(AGENT_NAME);
  });

  // ---------------------------------------------------------------------------
  // 5. Agent Selection
  // ---------------------------------------------------------------------------

  test('clicking the agent selects it (active state)', async () => {
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    await agentItem.click();
    await window.waitForTimeout(300);

    // Check the data-active attribute
    const isActive = await agentItem.getAttribute('data-active');
    expect(isActive).toBe('true');
  });

  // ---------------------------------------------------------------------------
  // 6. Agent Deletion — via action button
  // ---------------------------------------------------------------------------

  test('ensure agent is sleeping before deletion', async () => {
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    // Check if the agent is running; if so, stop it
    const agentText = await agentItem.textContent();
    if (agentText!.includes('Running')) {
      // Stop via the visible action button (data-testid="action-stop")
      const stopBtn = agentItem.locator('[data-testid="action-stop"]');
      const stopVisible = await stopBtn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (stopVisible) {
        await stopBtn.click();
      } else {
        // Try via context menu
        await agentItem.click({ button: 'right' });
        await window.waitForTimeout(300);
        const ctxStop = window.locator('[data-testid="ctx-stop"]');
        const ctxStopVisible = await ctxStop.isVisible({ timeout: 2_000 }).catch(() => false);
        if (ctxStopVisible) {
          await ctxStop.click();
        }
      }

      // Wait for the agent to transition to sleeping
      await expect(agentItem.locator('text=Sleeping')).toBeVisible({ timeout: 15_000 });
    }
  });

  test('delete action opens delete confirmation dialog', async () => {
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    await expect(agentItem).toBeVisible({ timeout: 5_000 });

    // Try to find the delete action button directly
    const deleteBtn = agentItem.locator('[data-testid="action-delete"]');
    const deleteBtnVisible = await deleteBtn.isVisible({ timeout: 2_000 }).catch(() => false);

    if (deleteBtnVisible) {
      await deleteBtn.click();
    } else {
      // Check overflow menu or context menu
      const overflowBtn = agentItem.locator('[data-testid="action-overflow"]');
      const overflowVisible = await overflowBtn.isVisible({ timeout: 2_000 }).catch(() => false);

      if (overflowVisible) {
        await overflowBtn.click();
        await window.waitForTimeout(300);

        const ctxDelete = window.locator('[data-testid="ctx-delete"]');
        await expect(ctxDelete).toBeVisible({ timeout: 3_000 });
        await ctxDelete.click();
      } else {
        // Fall back to right-click context menu
        await agentItem.click({ button: 'right' });
        await window.waitForTimeout(300);

        const ctxDelete = window.locator('[data-testid="ctx-delete"]');
        await expect(ctxDelete).toBeVisible({ timeout: 3_000 });
        await ctxDelete.click();
      }
    }

    await window.waitForTimeout(500);

    // The delete dialog should appear with the agent name
    const removeHeader = window.locator(`text=Remove ${AGENT_NAME}`).first();
    const deleteHeader = window.locator(`text=Delete ${AGENT_NAME}`).first();

    const removeVisible = await removeHeader.isVisible({ timeout: 5_000 }).catch(() => false);
    const deleteVisible = await deleteHeader.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(removeVisible || deleteVisible).toBe(true);
  });

  test('confirming deletion removes agent from the list', async () => {
    // Find the confirm button — "Remove" (for non-worktree) or "Delete" or "Force delete"
    // Non-worktree agents show a simple "Remove" button
    const removeBtn = window.locator('button:has-text("Remove")').last();
    const deleteBtn = window.locator('button:has-text("Delete")').last();
    const leaveBtn = window.locator('button:has-text("Leave files")');

    const removeVisible = await removeBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    const deleteVisible = await deleteBtn.isVisible({ timeout: 1_000 }).catch(() => false);
    const leaveVisible = await leaveBtn.isVisible({ timeout: 1_000 }).catch(() => false);

    // For non-worktree agents: click "Remove"
    // For clean worktree agents: click "Delete"
    // For dirty worktree agents: click "Leave files" (safest choice)
    if (removeVisible) {
      await removeBtn.click();
    } else if (leaveVisible && deleteVisible) {
      // Dirty worktree — use "Leave files" for safety
      await leaveBtn.click();
    } else if (deleteVisible) {
      await deleteBtn.click();
    }

    // Wait for the dialog to close and agent to be removed
    await window.waitForTimeout(2_000);

    // The agent should no longer be in the list
    const agentItem = window.locator(`[data-agent-name="${AGENT_NAME}"]`);
    await expect(agentItem).not.toBeVisible({ timeout: 10_000 });
  });

  test('agent list updates correctly after deletion', async () => {
    // Agent list should still be visible
    const agentList = window.locator('[data-testid="agent-list"]');
    await expect(agentList).toBeVisible({ timeout: 3_000 });

    // The deleted agent should definitely be gone
    const listContent = window.locator('[data-testid="agent-list-content"]');
    const contentText = await listContent.textContent();
    expect(contentText).not.toContain(AGENT_NAME);
  });
});

// ---------------------------------------------------------------------------
// 7. Dropdown Menu Variants
// ---------------------------------------------------------------------------

test.describe('Agent Creation Dropdown', () => {
  test('dropdown shows Durable and Quick Agent options', async () => {
    // Click the dropdown caret (▾) button
    const dropdownBtn = window.locator('button:has-text("▾")');
    await dropdownBtn.click();
    await window.waitForTimeout(300);

    // Should show both options
    const durableOption = window.locator('button:has-text("Durable")');
    const quickOption = window.locator('button:has-text("Quick Agent")');

    await expect(durableOption).toBeVisible({ timeout: 3_000 });
    await expect(quickOption).toBeVisible({ timeout: 3_000 });

    // Dismiss by clicking elsewhere
    await window.locator('.fixed.inset-0').click();
    await window.waitForTimeout(200);
  });
});
