/**
 * Shared helpers for E2E smoke tests.
 *
 * All functions accept `electronApp` / `window` as parameters — no
 * module-level globals so each spec file can manage its own lifecycle.
 */
import { expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

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
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
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

  const bodyText = await root.evaluate((el) => el.innerText.trim());
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

/** Open Settings by clicking the settings button in the rail. */
export async function openSettings(window: Page) {
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  await window.waitForTimeout(500);

  const titleBar = window.locator('[data-testid="title-bar"]');
  await expect(titleBar).toContainText('Settings', { timeout: 5_000 });
}

/**
 * Navigate to the Display & UI settings sub-page.
 * Settings must already be open.
 */
export async function navigateToDisplaySettings(window: Page) {
  const displayBtn = window.locator('button:has-text("Display & UI")');
  await expect(displayBtn).toBeVisible({ timeout: 5_000 });
  await displayBtn.click();
  await window.waitForTimeout(500);

  const colorThemeHeading = window.locator('text=Color Theme').first();
  await expect(colorThemeHeading).toBeVisible({ timeout: 5_000 });
}

/**
 * Ensure we're on the agents tab for the smoke project.
 * Clicks the project in the rail and waits.
 */
export async function navigateToSmokeProject(window: Page) {
  const proj = window.locator('[title="project-smoke"]').first();
  await proj.click();
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
