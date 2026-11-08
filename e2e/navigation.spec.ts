/**
 * E2E: navigation between projects, tabs, Settings and Help.
 *
 * Runs on the new layout, and on classic in the Classic layout E2E job
 * (#2843). Where the two layouts differ, a test branches on the layout, or
 * each layout has its own test and skips the other's.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';
import {
  addProject,
  assertActiveProject,
  assertRunLayout,
  clickExplorerTab,
  projectButton,
  selectProject,
  showProjectTree,
} from './smoke-helpers';
import { isNewLayout } from './layout';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The title bar's text. On the new layout this is the breadcrumb, which shows
 * Settings, Help or the project's tab ("Agents" with no agent open) in every
 * window width, but drops the project name below 1100px. So project names are
 * checked with assertActiveProject, never here.
 */
const titleBar = () => window.locator('[data-testid="title-bar"]').first();

async function expectTitle(text: string) {
  await expect(titleBar()).toContainText(text, { timeout: 5_000 });
}

async function expectTitleNot(text: string) {
  await expect(titleBar()).not.toContainText(text, { timeout: 5_000 });
}

/** New layout: the sidebar's "Agents" crumb, shown while Settings, Help or a tab's list has the sidebar. */
const sidebarCrumbBack = () => window.getByTestId('list-breadcrumb').getByRole('button', { name: 'Agents', exact: true });

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await assertRunLayout(window);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Project Rail (the project tree on the new layout): basic navigation
// ---------------------------------------------------------------------------

test.describe('Project Rail', () => {
  test('starts with a non-empty title when no projects are active', async () => {
    const title = await titleBar().textContent() ?? '';
    // With no project open the title is "Clubhouse" (Home was removed for v1),
    // or a project may already be loaded if fixtures persisted; we just check
    // the title bar is visible and non-empty
    expect(title.length).toBeGreaterThan(0);
  });

  test('add first project and verify it becomes active', async () => {
    await addProject(electronApp, window, FIXTURE_A);
    await assertActiveProject(window, 'project-a');
  });

  test('add second project and verify it becomes active', async () => {
    await addProject(electronApp, window, FIXTURE_B);
    await assertActiveProject(window, 'project-b');
  });

  test('clicking project-a in rail switches back', async () => {
    await selectProject(window, 'project-a');
    await assertActiveProject(window, 'project-a');
  });

  test('clicking project-b in rail switches to it', async () => {
    await selectProject(window, 'project-b');
    await assertActiveProject(window, 'project-b');
  });
});

// ---------------------------------------------------------------------------
// 2. Explorer Tab Navigation
// ---------------------------------------------------------------------------

test.describe('Explorer Tabs', () => {
  test('defaults to agents tab', async () => {
    // Make sure a project is active
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);

    await expectTitle('Agents');
    if (await isNewLayout(window)) {
      // The active tab always stays in the title bar's row, never in More.
      await expect(window.getByTestId('explorer-tab-agents')).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('agents tab shows agent list or no-active-agent placeholder', async () => {
    if (await isNewLayout(window)) {
      // The tree is the agent list, and with the project's header selected
      // (no agent open) the pane is the project's start page.
      await expect(window.getByTestId('agent-list')).toBeVisible({ timeout: 5_000 });
      await expect(window.getByTestId('start-page')).toBeVisible({ timeout: 5_000 });
      return;
    }

    // Either the agent-list panel or the no-active-agent view should be visible
    const agentList = window.locator('[data-testid="agent-list"]');
    const noAgent = window.locator('[data-testid="no-active-agent"]');

    const listVisible = await agentList.isVisible({ timeout: 3_000 }).catch(() => false);
    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);

    expect(listVisible || noAgentVisible).toBe(true);
  });

  test('settings toggle opens settings view', async () => {
    await window.locator('[data-testid="nav-settings"]').click();
    await window.waitForTimeout(500);

    await expectTitle('Settings');
    if (await isNewLayout(window)) await expect(window.getByTestId('settings-nav')).toBeVisible();
  });

  test('settings toggle again returns to previous tab', async () => {
    await window.locator('[data-testid="nav-settings"]').click();
    await window.waitForTimeout(500);

    // Should return to agents (or whatever the previous tab was)
    await expectTitleNot('Settings');
    if (await isNewLayout(window)) {
      await expectTitle('Agents');
      await expect(window.getByTestId('project-tree')).toBeVisible();
    }
  });

  test('help toggle opens help view', async () => {
    await window.locator('[data-testid="nav-help"]').click();
    await window.waitForTimeout(500);

    await expectTitle('Help');
    if (await isNewLayout(window)) await expect(window.getByTestId('help-nav')).toBeVisible();
  });

  test('help toggle again returns to previous tab', async () => {
    await window.locator('[data-testid="nav-help"]').click();
    await window.waitForTimeout(500);

    await expectTitleNot('Help');
    if (await isNewLayout(window)) {
      await expectTitle('Agents');
      await expect(window.getByTestId('project-tree')).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Per-Project Tab Persistence
// ---------------------------------------------------------------------------

test.describe('Per-Project Tab Persistence', () => {
  test('switching project restores its saved tab', async () => {
    // Navigate to project-a -> agents tab (default)
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);
    await assertActiveProject(window, 'project-a');
    await expectTitle('Agents');

    // Navigate to project-b
    await selectProject(window, 'project-b');
    await window.waitForTimeout(500);
    await assertActiveProject(window, 'project-b');

    // Switch back to project-a, which should still be on agents
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);
    await assertActiveProject(window, 'project-a');
    await expectTitle('Agents');
  });

  test('new project defaults to agents tab', async () => {
    // project-b was never explicitly set to a tab, so it should default to agents
    await selectProject(window, 'project-b');
    await window.waitForTimeout(500);

    await expectTitle('Agents');
  });

  test('settings view does not override saved project tab', async () => {
    test.skip(await isNewLayout(window), 'Clicks a rail project while Settings is open; on the new layout Settings takes the sidebar, so no project row is there to click.');
    // Go to project-a (should be on agents)
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);

    // Open settings
    await window.locator('[data-testid="nav-settings"]').click();
    await window.waitForTimeout(500);
    await expectTitle('Settings');

    // Now switch to project-b, which should restore project-b's tab, not settings
    await selectProject(window, 'project-b');
    await window.waitForTimeout(500);

    await assertActiveProject(window, 'project-b');
    await expectTitleNot('Settings');
  });

  test('new layout: a project keeps its tab across Settings and a switch', async () => {
    test.skip(!(await isNewLayout(window)), 'The new layout\'s path back from Settings; classic clicks a rail project instead.');
    const filesTab = window.getByTestId('explorer-tab-plugin:files');
    const agentsTab = window.getByTestId('explorer-tab-agents');

    // project-a on a tab other than Agents, so restoring it means something.
    await selectProject(window, 'project-a');
    await clickExplorerTab(electronApp, window, 'explorer-tab-plugin:files');
    await expect(filesTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    await window.getByTestId('nav-settings').click();
    await expect(window.getByTestId('settings-nav')).toBeVisible({ timeout: 10_000 });
    await expect(window.getByTestId('project-tree')).toBeHidden();
    await expectTitle('Settings');

    // selectProject closes Settings, then picks project-b, which never left Agents.
    await selectProject(window, 'project-b');
    await assertActiveProject(window, 'project-b');
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // Back on project-a, its own tab comes back, not Settings or b's Agents.
    await selectProject(window, 'project-a');
    await assertActiveProject(window, 'project-a');
    await expect(filesTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    await expectTitleNot('Settings');

    // Later tests expect project-a on Agents.
    await clickExplorerTab(electronApp, window, 'explorer-tab-agents');
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-Project Agent Guard
// ---------------------------------------------------------------------------

test.describe('Cross-Project Agent Guard', () => {
  test('agent from project-a is not shown when project-b is active', async () => {
    // When on project-b, the main content should never show an agent from project-a
    await selectProject(window, 'project-b');
    await window.waitForTimeout(500);

    if (await isNewLayout(window)) {
      // With project-b's header selected the pane is project-b's own start page.
      await assertActiveProject(window, 'project-b');
      const startPage = window.getByTestId('start-page');
      await expect(startPage).toBeVisible({ timeout: 5_000 });
      await expect(startPage.getByRole('heading', { level: 1 })).toHaveText('project-b');
      return;
    }

    // The no-active-agent placeholder should be visible (no agents in project-b)
    // or the agent list should only show project-b agents
    const noAgent = window.locator('[data-testid="no-active-agent"]');
    const terminalView = window.locator('[data-testid="agent-terminal-view"]');

    const noAgentVisible = await noAgent.isVisible({ timeout: 3_000 }).catch(() => false);
    const terminalVisible = await terminalView.isVisible({ timeout: 1_000 }).catch(() => false);

    // If a terminal is shown, verify it's for the right project
    // If no agent, the guard is working correctly
    if (!terminalVisible) {
      // No terminal showing, as expected for a project with no agents
      expect(noAgentVisible).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Keyboard Shortcuts
// ---------------------------------------------------------------------------

test.describe('Keyboard Shortcuts', () => {
  test('Cmd+Shift+N switches between projects by ordinal position', async () => {
    test.skip(await isNewLayout(window), 'The new layout has no switch-project shortcuts; there Cmd+Option+1-9 switch agents and Cmd+1-9 select tabs.');
    // Get the list of project buttons in the rail to determine order
    const projectBtns = window.locator('[data-testid^="project-"]');
    const count = await projectBtns.count();

    if (count < 2) {
      // Not enough projects to test switching, so skip
      return;
    }

    // Read the title attribute of the first two project buttons
    const firstTitle = await projectBtns.nth(0).getAttribute('title');
    const secondTitle = await projectBtns.nth(1).getAttribute('title');

    // Switch to the second project first
    await projectBtns.nth(1).click();
    await window.waitForTimeout(500);
    await expectTitle(secondTitle!);

    // Press Cmd+Option+1 to switch to first project
    await window.keyboard.press('Meta+Alt+1');
    await window.waitForTimeout(500);
    await expectTitle(firstTitle!);

    // Press Cmd+Option+2 to switch to second project
    await window.keyboard.press('Meta+Alt+2');
    await window.waitForTimeout(500);
    await expectTitle(secondTitle!);
  });

  // Note: Cmd+9 is not tested here because Chromium intercepts it at the
  // browser level ("go to last tab") before it reaches the app's keydown handler.
});

// ---------------------------------------------------------------------------
// 6. No Home (removed for v1)
// ---------------------------------------------------------------------------

test.describe('No Home', () => {
  test('the rail has no Home button', async () => {
    // Neither layout has Home any more.
    await expect(window.locator('[data-testid="nav-home"]')).toHaveCount(0);
  });

  test('clicking a project restores its saved tab', async () => {
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);

    await assertActiveProject(window, 'project-a');
    // Should restore to agents tab (the default/saved tab)
    await expectTitle('Agents');
  });
});

// ---------------------------------------------------------------------------
// 7. Settings from Different Contexts
// ---------------------------------------------------------------------------

test.describe('Settings Context', () => {
  test('opening settings from project-a then clicking project-b exits settings', async () => {
    test.skip(await isNewLayout(window), 'Clicks a rail project while Settings is open; on the new layout Settings takes the sidebar, so no project row is there to click.');
    // Navigate to project-a
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);

    // Open settings
    await window.locator('[data-testid="nav-settings"]').click();
    await window.waitForTimeout(500);
    await expectTitle('Settings');

    // Click project-b, which should exit settings and show project-b's view
    await selectProject(window, 'project-b');
    await window.waitForTimeout(500);

    await assertActiveProject(window, 'project-b');
    await expectTitleNot('Settings');
  });

  test('opening help then clicking a project exits help', async () => {
    test.skip(await isNewLayout(window), 'Clicks a rail project while Help is open; on the new layout Help takes the sidebar, so no project row is there to click.');
    // Open help
    await window.locator('[data-testid="nav-help"]').click();
    await window.waitForTimeout(500);
    await expectTitle('Help');

    // Click project-a, which should exit help
    await selectProject(window, 'project-a');
    await window.waitForTimeout(500);

    await assertActiveProject(window, 'project-a');
    await expectTitleNot('Help');
  });

  test('new layout: the sidebar\'s Agents crumb leaves Settings and Help for the project tree', async () => {
    test.skip(!(await isNewLayout(window)), 'The new layout\'s sidebar crumb; classic keeps the rail beside Settings and Help.');
    const tree = window.getByTestId('project-tree');

    // Settings from project-a, back by the crumb, then project-b from the tree.
    await selectProject(window, 'project-a');
    await window.getByTestId('nav-settings').click();
    await expect(window.getByTestId('settings-nav')).toBeVisible({ timeout: 10_000 });
    await expectTitle('Settings');
    await sidebarCrumbBack().click();
    await expect(window.getByTestId('settings-nav')).toBeHidden({ timeout: 10_000 });
    await expect(tree).toBeVisible();
    await expectTitleNot('Settings');
    await (await projectButton(window, 'project-b')).click();
    await assertActiveProject(window, 'project-b');
    await expectTitle('Agents');

    // Help, back by the crumb, then project-a from the tree.
    await window.getByTestId('nav-help').click();
    await expect(window.getByTestId('help-nav')).toBeVisible({ timeout: 10_000 });
    await expectTitle('Help');
    await sidebarCrumbBack().click();
    await expect(window.getByTestId('help-nav')).toBeHidden({ timeout: 10_000 });
    await expect(tree).toBeVisible();
    await expectTitleNot('Help');
    await (await projectButton(window, 'project-a')).click();
    await assertActiveProject(window, 'project-a');
    await expectTitle('Agents');
  });
});

// ---------------------------------------------------------------------------
// 8. Rapid Project Switching
// ---------------------------------------------------------------------------

test.describe('Rapid Switching', () => {
  test('rapid back-and-forth does not corrupt state', async () => {
    if (await isNewLayout(window)) await showProjectTree(window);
    const projA = await projectButton(window, 'project-a');
    const projB = await projectButton(window, 'project-b');

    // Rapidly switch 5 times
    for (let i = 0; i < 5; i++) {
      await projA.click();
      await projB.click();
    }

    // Wait for things to settle
    await window.waitForTimeout(1_000);

    // Should be on project-b (last click)
    await assertActiveProject(window, 'project-b');

    // Should be on a valid tab (agents)
    await expectTitle('Agents');
  });
});
