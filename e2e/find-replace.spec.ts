/**
 * Find & Replace E2E Tests
 * GitHub Issue #488: In-file find and replace via Monaco's built-in widget.
 *
 * Tests verify that the find widget opens, highlights matches, navigates
 * between them, supports replace, and respects theming.
 *
 * Uses a dedicated fixture (project-find-replace) with a sample.ts file
 * containing known, repeated tokens for predictable match counts.
 *
 * NOTE: Cmd+H is intercepted by macOS to hide the app, so replace mode
 * is tested via Cmd+Option+F and the Toggle Replace button instead.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/project-find-replace');

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

async function clickExplorerTab(testId: string) {
  await window.waitForSelector(`[data-testid="${testId}"]`, { timeout: 10_000 });
  await window.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement;
    if (el) el.click();
  }, testId);
  await window.waitForTimeout(500);
}

async function assertNotBlankScreen() {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);
}

/** Focus the Monaco editor by clicking its view lines area. */
async function focusEditor() {
  const viewLines = window.locator('.monaco-editor .view-lines').first();
  await viewLines.click();
  await window.waitForTimeout(300);
}

/** Open find widget via Cmd+F after focusing editor. */
async function openFind() {
  await focusEditor();
  await window.keyboard.press('ControlOrMeta+f');
  await window.waitForTimeout(500);
  await expect(window.locator('.monaco-editor .find-widget.visible')).toBeVisible({ timeout: 5_000 });
}

/** Open find+replace by opening find and clicking the Toggle Replace button. */
async function openFindReplace() {
  await openFind();
  // Click the "Toggle Replace" button to expand the replace row
  const toggleBtn = window.locator('.find-widget .button.toggle[aria-label="Toggle Replace"]');
  // If replace is already expanded, skip the click
  const isExpanded = await toggleBtn.getAttribute('aria-expanded');
  if (isExpanded !== 'true') {
    await toggleBtn.click();
    await window.waitForTimeout(300);
  }
  // Verify replace part is visible
  await expect(window.locator('.find-widget.replaceToggled')).toBeVisible({ timeout: 3_000 });
}

/** Close find widget via Escape. */
async function closeFindWidget() {
  await window.keyboard.press('Escape');
  await window.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
  await addProject(FIXTURE_DIR);
  await window.waitForTimeout(1_000);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ===========================================================================
// PART A: Find Widget Activation
// ===========================================================================

test.describe('Find Widget Activation', () => {
  test('navigate to Files tab and open sample.ts in editor', async () => {
    await clickExplorerTab('explorer-tab-plugin:files');
    const filesTab = window.locator('[data-testid="explorer-tab-plugin:files"]');
    await expect(filesTab).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    // Click on sample.ts in the file tree
    const fileNode = window.locator('span:has-text("sample.ts")').first();
    await expect(fileNode).toBeVisible({ timeout: 10_000 });
    await fileNode.click();
    await window.waitForTimeout(500);

    // Wait for Monaco editor to load
    await window.waitForSelector('.monaco-editor .view-lines', { timeout: 15_000 });
    const editorContent = window.locator('.monaco-editor .view-lines');
    await expect(editorContent).toBeVisible({ timeout: 10_000 });
  });

  test('Cmd+F opens the find widget', async () => {
    await openFind();
    const findWidget = window.locator('.monaco-editor .find-widget.visible');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });
  });

  test('find widget has a search textarea', async () => {
    // Monaco uses a <textarea> for the search input
    const searchInput = window.locator('.find-widget .find-part textarea.input');
    await expect(searchInput.first()).toBeVisible({ timeout: 3_000 });
  });

  test('Escape closes the find widget', async () => {
    await closeFindWidget();
    const findWidget = window.locator('.monaco-editor .find-widget.visible');
    await expect(findWidget).not.toBeVisible({ timeout: 3_000 });
  });

  test('Cmd+Option+F opens find and replace widget', async () => {
    await focusEditor();
    await window.keyboard.press('ControlOrMeta+Alt+f');
    await window.waitForTimeout(500);

    // Find widget should appear with replace toggled
    const findWidget = window.locator('.monaco-editor .find-widget.visible.replaceToggled');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });

    // Replace textarea should be visible
    const replaceInput = window.locator('.find-widget .replace-part textarea.input');
    await expect(replaceInput.first()).toBeVisible({ timeout: 3_000 });

    await closeFindWidget();
  });

  test('Toggle Replace button expands replace row', async () => {
    await openFind();

    // Click the toggle button
    const toggleBtn = window.locator('.find-widget .button.toggle[aria-label="Toggle Replace"]');
    await expect(toggleBtn).toBeVisible({ timeout: 3_000 });
    await toggleBtn.click();
    await window.waitForTimeout(300);

    // Widget should now have replaceToggled class
    const widget = window.locator('.find-widget.replaceToggled');
    await expect(widget).toBeVisible({ timeout: 3_000 });

    // Toggle button should show expanded state
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    await closeFindWidget();
  });
});

// ===========================================================================
// PART B: Search and Match Highlighting
// ===========================================================================

test.describe('Search and Match Highlighting', () => {
  test('typing a query highlights matches in the editor', async () => {
    await openFind();

    // Type "name" — sample.ts has multiple occurrences
    await window.keyboard.type('name', { delay: 50 });
    await window.waitForTimeout(500);

    // Match highlights should appear (Monaco uses .findMatch and .currentFindMatch)
    const highlights = window.locator('.monaco-editor .cdr.findMatch, .monaco-editor .cdr.currentFindMatch');
    await expect(highlights.first()).toBeVisible({ timeout: 5_000 });
    const count = await highlights.count();
    expect(count).toBeGreaterThan(1); // "name" appears multiple times in sample.ts
  });

  test('match count is displayed in the find widget', async () => {
    // The find widget shows match count like "1 of 7"
    const matchInfo = window.locator('.find-widget .matchesCount');
    await expect(matchInfo).toBeVisible({ timeout: 3_000 });
    const text = await matchInfo.textContent();
    expect(text).toMatch(/\d+\s+of\s+\d+/);
  });

  test('Enter navigates to next match', async () => {
    const matchInfo = window.locator('.find-widget .matchesCount');
    const initialText = await matchInfo.textContent();

    await window.keyboard.press('Enter');
    await window.waitForTimeout(300);

    const nextText = await matchInfo.textContent();
    expect(nextText).not.toEqual(initialText);
  });

  test('Shift+Enter navigates to previous match', async () => {
    const matchInfo = window.locator('.find-widget .matchesCount');
    const initialText = await matchInfo.textContent();

    await window.keyboard.press('Shift+Enter');
    await window.waitForTimeout(300);

    const prevText = await matchInfo.textContent();
    expect(prevText).not.toEqual(initialText);
  });

  test('find widget option toggles are visible (case, word, regex)', async () => {
    // Monaco renders toggles as .monaco-custom-toggle with codicon classes
    const caseToggle = window.locator('.find-widget .codicon-case-sensitive');
    await expect(caseToggle).toBeVisible({ timeout: 3_000 });

    const wordToggle = window.locator('.find-widget .codicon-whole-word');
    await expect(wordToggle).toBeVisible({ timeout: 3_000 });

    const regexToggle = window.locator('.find-widget .codicon-regex');
    await expect(regexToggle).toBeVisible({ timeout: 3_000 });

    await closeFindWidget();
  });
});

// ===========================================================================
// PART C: Replace Functionality
// ===========================================================================

test.describe('Replace Functionality', () => {
  test('replace a single match and verify dirty state', async () => {
    await openFindReplace();

    // Type search query in the find textarea
    const findInput = window.locator('.find-widget .find-part textarea.input').first();
    await findInput.click();
    await window.keyboard.press('ControlOrMeta+a');
    await window.keyboard.type('_defaultName', { delay: 50 });
    await window.waitForTimeout(500);

    // Verify we found the match
    const matchInfo = window.locator('.find-widget .matchesCount');
    await expect(matchInfo).toContainText('of', { timeout: 3_000 });

    // Type replacement in the replace textarea
    const replaceInput = window.locator('.find-widget .replace-part textarea.input').first();
    await replaceInput.click();
    await window.keyboard.type('_replacedName', { delay: 50 });
    await window.waitForTimeout(300);

    // Click the Replace button (single replacement)
    const replaceBtn = window.locator('.find-widget .codicon-find-replace[aria-label*="Replace"]').first();
    await replaceBtn.click();
    await window.waitForTimeout(500);

    // Dirty indicator should appear (orange dot in header)
    const dirtyDot = window.locator('.bg-ctp-peach');
    await expect(dirtyDot).toBeVisible({ timeout: 5_000 });
  });

  test('undo reverses the replacement', async () => {
    await closeFindWidget();
    await focusEditor();

    // Undo the replacement
    await window.keyboard.press('ControlOrMeta+z');
    await window.waitForTimeout(500);

    // Dirty state should clear since we're back to original
    const dirtyDot = window.locator('.bg-ctp-peach');
    await expect(dirtyDot).not.toBeVisible({ timeout: 5_000 });
  });
});

// ===========================================================================
// PART D: Theme Integration
// ===========================================================================

test.describe('Find Widget Theme Integration', () => {
  test('find widget uses themed colors for background', async () => {
    await openFind();

    const findWidget = window.locator('.monaco-editor .find-widget.visible');
    const bgColor = await findWidget.evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });

    // Background should not be transparent or white (default) — it should be themed
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(bgColor).not.toBe('transparent');

    await closeFindWidget();
  });
});

// ===========================================================================
// PART E: Multi-cursor Find Keybindings
// ===========================================================================

test.describe('Multi-cursor Find Keybindings', () => {
  test('Cmd+D adds selection to next find match without crashing', async () => {
    await focusEditor();

    // Cmd+D should not crash the editor
    await window.keyboard.press('ControlOrMeta+d');
    await window.waitForTimeout(300);
    await window.keyboard.press('ControlOrMeta+d');
    await window.waitForTimeout(300);

    await assertNotBlankScreen();

    // Escape to deselect any multi-cursors
    await window.keyboard.press('Escape');
    await window.waitForTimeout(200);
  });

  test('Cmd+Shift+L selects all occurrences without crashing', async () => {
    await focusEditor();

    await window.keyboard.press('ControlOrMeta+Shift+l');
    await window.waitForTimeout(500);

    await assertNotBlankScreen();

    // Escape to deselect
    await window.keyboard.press('Escape');
    await window.waitForTimeout(200);
  });
});

// ===========================================================================
// PART F: Console Error Monitoring
// ===========================================================================

test.describe('Find/Replace Console Errors', () => {
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    window.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
  });

  test('exercise find/replace to collect any errors', async () => {
    await openFind();
    await window.keyboard.type('greet', { delay: 30 });
    await window.waitForTimeout(300);
    await window.keyboard.press('Enter');
    await window.waitForTimeout(200);
    await window.keyboard.press('Shift+Enter');
    await window.waitForTimeout(200);
    await closeFindWidget();

    // Open find+replace via toggle
    await openFindReplace();
    await closeFindWidget();

    await window.waitForTimeout(500);
  });

  test('no find/replace-related crash errors in console', async () => {
    const crashErrors = consoleErrors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('source map') &&
        !e.includes('favicon') &&
        !e.includes('Autofill') &&
        !e.includes('ResizeObserver') &&
        !e.includes('net::ERR') &&
        !e.includes('Failed to fetch') &&
        (e.includes('Cannot read properties of undefined') ||
         e.includes('Cannot read properties of null') ||
         e.includes('is not a function') ||
         e.includes('Maximum update depth') ||
         e.includes('findWidget') ||
         e.includes('find-widget')),
    );
    expect(crashErrors).toEqual([]);
  });
});
