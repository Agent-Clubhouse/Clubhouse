import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type ElectronApp } from './launch';
import { addProject } from './smoke-helpers';

/**
 * The default layout on a real Mac, on one launch: what differs there is the
 * title bar around the traffic lights and the Cmd shortcuts. The other paths are
 * in e2e/layout-default.spec.ts, on Linux and Windows. Runs only in the macOS
 * smoke set. No provider is installed, so no CLI can start.
 */

test.skip(process.platform !== 'darwin', 'macOS only');

let electronApp: ElectronApp;
let w: Page;
let fakes: FakeClis;
let root: string;

test.beforeAll(async () => {
  fakes = await installFakeClis({});
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-macos-'));
  const dir = path.join(root, 'macos-smoke');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# default shell on macOS\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  ({ electronApp, window: w } = await launchApp({ label: 'default-macos', env: fakes.env }));
  await expect(w.locator('[data-testid="chrome-title-bar"]')).toBeVisible({ timeout: 15_000 });
  await addProject(electronApp, w, dir);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fakes?.cleanup();
  if (root) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('the title bar leaves room for the traffic lights and drags the window', async () => {
  const titleBar = w.locator('[data-testid="chrome-title-bar"]');
  await expect(titleBar).toHaveCSS('padding-left', '78px');
  await expect(titleBar).toHaveCSS('-webkit-app-region', 'drag');
  const box = await w.locator('[data-testid="chrome-sidebar-toggle"]').boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(78);
});

test('Cmd shortcuts reach the palette, the sidebar and settings', async () => {
  const palette = w.locator('[data-testid="command-palette-overlay"]');
  await w.keyboard.press('Meta+k');
  await expect(palette).toBeVisible({ timeout: 5_000 });
  await w.keyboard.press('Escape');
  await expect(palette).toBeHidden({ timeout: 5_000 });

  const sidebarToggle = w.locator('[data-testid="chrome-sidebar-toggle"]');
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');
  await w.keyboard.press('Meta+b');
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false');
  await w.keyboard.press('Meta+b');
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');

  const settings = w.locator('[data-testid="settings-nav"]');
  await w.keyboard.press('Meta+,');
  await expect(settings).toBeVisible({ timeout: 10_000 });
  await w.keyboard.press('Meta+,');
  await expect(settings).toBeHidden({ timeout: 10_000 });
});
