/**
 * Shared helpers for E2E smoke tests.
 *
 * All functions accept `electronApp` / `window` as parameters — no
 * module-level globals so each spec file can manage its own lifecycle.
 */
import { expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { reportActionFailure } from './renderer-diagnostics';
import { isClassicRun, isNewLayout } from './layout';

type ElectronApp = Awaited<ReturnType<typeof import('@playwright/test')._electron.launch>>;

// ---------------------------------------------------------------------------
// Constants — dedicated fixtures for smoke tests (not shared with other specs)
// ---------------------------------------------------------------------------
export const FIXTURE_SMOKE = path.resolve(__dirname, 'fixtures/project-smoke');
export const FIXTURE_B = path.resolve(__dirname, 'fixtures/project-b');
export const AGENTS_JSON_DIR = path.join(FIXTURE_SMOKE, '.clubhouse');
export const AGENTS_JSON = path.join(AGENTS_JSON_DIR, 'agents.json');

// ---------------------------------------------------------------------------
// Dialog / Project helpers
// ---------------------------------------------------------------------------

/** Stub Electron's dialog so the next pickAndAddProject resolves to `dirPath`. */
export async function stubDialogForPath(electronApp: ElectronApp, dirPath: string) {
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

/** Add a fixture project by stubbing the dialog and clicking the add button. */
export async function addProject(electronApp: ElectronApp, window: Page, dirPath: string) {
  await stubDialogForPath(electronApp, dirPath);
  const addBtn = window.locator('[data-testid="nav-add-project"]');
  try {
    await addBtn.click();
  } catch (cause) {
    await reportActionFailure(electronApp, window, 'nav-add-project', cause);
    throw cause;
  }
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Click a project tab. On classic, first leave the rail's hover flyout. On the
 * new layout a tab is in the title bar or, when they don't all fit, in its
 * More menu.
 */
export async function clickExplorerTab(electronApp: ElectronApp, window: Page, testId: string) {
  try {
    if (await isNewLayout(window)) {
      await revealTitleTab(window, testId);
    } else if (await window.locator('[data-testid="rail-container"]').count()) {
      // The flyout can be wider than the rail's collapsed layout box, including
      // while it animates. The viewport's far edge leaves the whole hover region.
      const point = await window.evaluate(() => ({ x: globalThis.innerWidth - 1, y: globalThis.innerHeight / 2 }));
      await window.mouse.move(point.x, point.y);
    }
    // Normal actionability waits for the real close transition; never bypass
    // the overlay with a forced or programmatic click.
    await window.getByTestId(testId).click();
  } catch (cause) {
    await reportActionFailure(electronApp, window, testId, cause);
    throw cause;
  }
}

/** New layout: show a title bar tab, opening the More menu when it's in there. */
async function revealTitleTab(window: Page, testId: string) {
  const tab = window.getByTestId(testId);
  await expect(async () => {
    const more = window.getByTestId('title-more');
    if (!(await tab.isVisible()) && await more.isVisible()) await more.click();
    await expect(tab).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Verify the page has meaningful content (not blank-screened).
 * Uses the stronger check: children > 0 AND innerText.length > 0.
 */
export async function assertNotBlankScreen(window: Page) {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);

  const bodyText = await root.evaluate((el: HTMLElement) => el.innerText.trim());
  expect(bodyText.length).toBeGreaterThan(0);
}

/** Assert the title bar is visible and contains expected text. */
export async function assertTitleBarContains(window: Page, expected: string) {
  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toBeVisible({ timeout: 5_000 });
  await expect(titleBar).toContainText(expected, { timeout: 5_000 });
}

/** Get the title bar text. */
export async function getTitleBarText(window: Page): Promise<string> {
  return window.locator('[data-testid="title-bar"]').first().textContent() as Promise<string>;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * A project's button in the sidebar, by its name: the rail icon on classic,
 * the tree row's header on the new layout.
 */
export async function projectButton(window: Page, name: string) {
  return (await isNewLayout(window))
    ? window.locator(`[data-testid="project-tree"] [role="treeitem"][aria-label="${name}"] button[data-active]`).first()
    : window.locator(`[title="${name}"]`).first();
}

/**
 * New layout: bring back the project tree, which Settings, Help and a tab's
 * own list each take the sidebar from.
 */
export async function showProjectTree(window: Page) {
  const tree = window.getByTestId('project-tree');
  await expect(async () => {
    if (await window.getByTestId('settings-nav').isVisible()) await window.getByTestId('nav-settings').click();
    else if (await window.getByTestId('help-nav').isVisible()) await window.getByTestId('nav-help').click();
    else if (!(await tree.isVisible())) {
      const agents = window.getByTestId('explorer-tab-agents');
      const more = window.getByTestId('title-more');
      if (!(await agents.isVisible()) && await more.isVisible()) await more.click();
      if (await agents.isVisible()) await agents.click();
    }
    await expect(tree).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Select a project by name, from wherever the sidebar is. */
export async function selectProject(window: Page, name: string) {
  if (!(await isNewLayout(window))) {
    await (await projectButton(window, name)).click();
    return;
  }
  await showProjectTree(window);
  const button = await projectButton(window, name);
  await button.click();
  await expect(button).toHaveAttribute('data-active', 'true');
}

/**
 * Assert the named project is the active one: the title bar on classic, the
 * tree on the new layout, whose breadcrumb drops the project name in a
 * narrow window.
 */
export async function assertActiveProject(window: Page, name: string) {
  if (!(await isNewLayout(window))) {
    await assertTitleBarContains(window, name);
    return;
  }
  await expect(await projectButton(window, name)).toHaveAttribute('data-active', 'true', { timeout: 10_000 });
}

/** The project id Clubhouse gave a folder. */
export async function projectIdFor(window: Page, dirPath: string): Promise<string> {
  const id = await window.evaluate(async (dir) => {
    const api = (globalThis as unknown as { clubhouse: { project: { list(): Promise<Array<{ id: string; path: string }>> } } }).clubhouse;
    const projects = await api.project.list();
    return projects.find((p) => p.path === dir)?.id;
  }, dirPath);
  if (!id) throw new Error(`No project for ${dirPath}`);
  return id;
}

/**
 * Show an agent's row and return it. On the new layout a sleeping agent is in
 * its project's "sleeping" fold, which closes by itself a few seconds after
 * the pointer leaves. So this opens it whenever the row isn't showing, and
 * leaves the pointer on the fold's own row to keep it open.
 */
export async function revealAgent(window: Page, agentId: string, timeout = 30_000) {
  const row = window.locator(`[data-testid="agent-item-${agentId}"]`);
  if (!(await isNewLayout(window))) {
    await expect(row).toBeVisible({ timeout });
    return row;
  }
  const tree = window.getByTestId('project-tree');
  await expect(async () => {
    if (!(await row.isVisible())) {
      for (const fold of await tree.locator('[data-testid^="sleeping-fold-"][aria-expanded="false"]').all()) {
        await fold.click();
      }
    }
    await expect(row).toBeVisible({ timeout: 1_000 });
    // An awake agent isn't in a fold; a sleeping one's fold row is in its project's group.
    const fold = tree.locator('[data-testid^="project-group-"]').filter({ has: row })
      .locator('[data-testid^="sleeping-fold-"][aria-expanded="true"]');
    if (await fold.count()) await fold.first().hover();
    await expect(row).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout });
  return row;
}

/** Open Settings from the sidebar. On the new layout this leaves it open if it already is. */
export async function openSettings(window: Page) {
  const titleBar = window.locator('[data-testid="title-bar"]');
  if (await isNewLayout(window)) {
    const nav = window.getByTestId('settings-nav');
    if (!(await nav.isVisible())) await window.getByTestId('nav-settings').click();
    await expect(nav).toBeVisible({ timeout: 10_000 });
    await expect(titleBar).toContainText('Settings', { timeout: 5_000 });
    return;
  }
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  await window.waitForTimeout(500);
  await expect(titleBar).toContainText('Settings', { timeout: 5_000 });
}

/** Close Settings with the sidebar's settings button. */
export async function closeSettings(window: Page) {
  if (await isNewLayout(window)) {
    const nav = window.getByTestId('settings-nav');
    if (await nav.isVisible()) await window.getByTestId('nav-settings').click();
    await expect(nav).toBeHidden({ timeout: 10_000 });
    return;
  }
  await window.locator('[data-testid="nav-settings"]').click();
  await window.waitForTimeout(500);
}

/** Go to an app settings page by its id (`display`, `about`, …). Settings must already be open. */
export async function openSettingsPage(window: Page, page: string, label: string) {
  const button = (await isNewLayout(window))
    ? window.getByTestId(`settings-nav-app-${page}`)
    : window.locator(`button:has-text("${label}")`).first();
  await expect(button).toBeVisible({ timeout: 5_000 });
  await button.click();
}

/**
 * Navigate to the Display & UI settings sub-page.
 * Settings must already be open.
 */
export async function navigateToDisplaySettings(window: Page) {
  if (await isNewLayout(window)) {
    await openSettingsPage(window, 'display', 'Display & UI');
  } else {
    const displayBtn = window.locator('button:has-text("Display & UI")');
    await expect(displayBtn).toBeVisible({ timeout: 5_000 });
    await displayBtn.click();
    await window.waitForTimeout(500);
  }

  const colorThemeHeading = window.locator('text=Color theme').first();
  await expect(colorThemeHeading).toBeVisible({ timeout: 5_000 });
}

/**
 * Fail fast if this launch isn't on the layout its job runs: new by default,
 * classic in the Classic layout E2E job. Otherwise a spec's layout branches
 * would quietly test the other one.
 */
export async function assertRunLayout(window: Page) {
  expect(await isNewLayout(window), isClassicRun ? 'Classic layout E2E run, so classic' : 'new layout by default').toBe(!isClassicRun);
}

/** Select the smoke project, from wherever the sidebar is. */
export async function navigateToSmokeProject(window: Page) {
  await selectProject(window, 'project-smoke');
  await window.waitForTimeout(500);
}

/** Read the current CSS variable for --ctp-base (background color). */
export async function getBaseColorVar(window: Page): Promise<string> {
  return window.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim();
  });
}

// ---------------------------------------------------------------------------
// Agents JSON helpers
// ---------------------------------------------------------------------------

/** Write durable agents to agents.json in the smoke fixture project. */
export function writeAgentsJson(
  agents: Array<{ id: string; name: string; color: string }>,
) {
  if (!fs.existsSync(AGENTS_JSON_DIR)) fs.mkdirSync(AGENTS_JSON_DIR, { recursive: true });
  const configs = agents.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    createdAt: new Date().toISOString(),
  }));
  fs.writeFileSync(AGENTS_JSON, JSON.stringify(configs, null, 2), 'utf-8');
}

/** Clean up agents.json to restore fixture state. */
export function cleanupAgentsJson() {
  if (fs.existsSync(AGENTS_JSON_DIR)) {
    fs.rmSync(AGENTS_JSON_DIR, { recursive: true, force: true });
  }
}
