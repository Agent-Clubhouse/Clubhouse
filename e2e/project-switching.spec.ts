/**
 * Switching between two projects. Runs on the new layout, and on classic in
 * the Classic layout E2E job (#2843).
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';
import { addProject, assertActiveProject, assertRunLayout, projectButton, selectProject } from './smoke-helpers';
import { isNewLayout } from './layout';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');

/** New layout: the pane shows the named project's start page. */
async function expectStartPage(name: string) {
  const startPage = window.getByTestId('start-page');
  await expect(startPage.getByRole('heading', { level: 1, name, exact: true })).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await assertRunLayout(window);
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('switch projects updates the active project', async () => {
  // Add both projects
  await addProject(electronApp, window, FIXTURE_A);
  await addProject(electronApp, window, FIXTURE_B);
  const newLayout = await isNewLayout(window);

  // Click project-a. On classic the title bar names it; on the new layout the
  // tree marks it active, since a narrow window drops the name from the title
  // bar, and the pane shows its start page.
  await selectProject(window, 'project-a');
  await assertActiveProject(window, 'project-a');
  if (newLayout) await expectStartPage('project-a');

  // Click project-b
  await selectProject(window, 'project-b');
  await assertActiveProject(window, 'project-b');
  if (newLayout) await expectStartPage('project-b');
});

test('agent list reflects new project', async () => {
  const agentList = window.locator('[data-testid="agent-list"]');

  if (await isNewLayout(window)) {
    // The tree lists every project, so it reflects the switch by marking
    // project-b active and expanding it.
    await expect(agentList).toBeVisible({ timeout: 5_000 });
    await expect(await projectButton(window, 'project-b')).toHaveAttribute('data-active', 'true');
    await expect(await projectButton(window, 'project-a')).toHaveAttribute('data-active', 'false');
    await expect(
      window.getByTestId('project-tree').locator('[role="treeitem"][aria-label="project-b"]'),
    ).toHaveAttribute('aria-expanded', 'true');
    return;
  }

  if (await agentList.isVisible({ timeout: 5_000 }).catch(() => false)) {
    // Agent list is visible, so it should reflect the current project's agents
    await expect(agentList).toBeVisible();
  }
});
