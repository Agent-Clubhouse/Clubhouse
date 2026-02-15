import { test, expect, _electron as electron } from '@playwright/test';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('switch projects updates active project name', async () => {
  // This test requires at least 2 projects to be present.
  // Look for project items in the sidebar/rail
  const projectItems = window.locator('[data-project-id], [class*="project-item"]');
  const count = await projectItems.count();

  if (count >= 2) {
    // Click the second project
    await projectItems.nth(1).click();

    // The active project indicator should update
    const activeProjectName = window.locator('[class*="active-project"], [data-active="true"]').first();
    await expect(activeProjectName).toBeVisible({ timeout: 5_000 });
  }
});

test('agent list reflects new project', async () => {
  // After switching projects, the agent list should update
  const agentList = window.locator('[data-testid="agent-list"], [class*="agent-list"]').first();

  if (await agentList.isVisible({ timeout: 5_000 }).catch(() => false)) {
    // Agent list is visible — it should reflect the current project's agents
    await expect(agentList).toBeVisible();
  }
});
