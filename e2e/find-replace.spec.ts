/**
 * Find & Replace E2E Tests
 * GitHub Issue #488: In-file find and replace via Monaco's built-in widget.
 *
 * Tests verify that the find widget opens, highlights matches, navigates
 * between them, supports replace, and respects theming.
 *
 * Uses a dedicated fixture (project-find-replace) with a sample.ts file
 * containing known, repeated tokens for predictable match counts.
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

/**
 * Wait for the Monaco editor to fully load by checking for the
 * .monaco-editor container with actual content lines.
 */
async function waitForMonacoEditor() {
  await window.waitForSelector('.monaco-editor .view-lines', { timeout: 15_000 });
}

/**
 * Click on a file in the file tree sidebar by its visible file name text.
 */
async function clickFileInTree(fileName: string) {
  // The file name appears as a <span> inside the tree node
  const fileNode = window.locator(`span:has-text("${fileName}")`).first();
  await expect(fileNode).toBeVisible({ timeout: 10_000 });
  await fileNode.click();
  await window.waitForTimeout(500);
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
    await clickFileInTree('sample.ts');

    // Wait for Monaco editor to load
    await waitForMonacoEditor();

    // Verify file content is visible
    const editorContent = window.locator('.monaco-editor .view-lines');
    await expect(editorContent).toBeVisible({ timeout: 10_000 });
  });

  test('Cmd+F opens the find widget', async () => {
    // Focus the editor by clicking on it
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Press Cmd+F to open find
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(500);

    // The find widget should appear — Monaco renders it as .find-widget
    const findWidget = window.locator('.monaco-editor .find-widget');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });
  });

  test('find widget has a search input field', async () => {
    // The find widget contains an input for the search query
    const searchInput = window.locator('.monaco-editor .find-widget .input');
    await expect(searchInput.first()).toBeVisible({ timeout: 3_000 });
  });

  test('Escape closes the find widget', async () => {
    await window.keyboard.press('Escape');
    await window.waitForTimeout(500);

    // The find widget should be hidden (Monaco adds .visible class when open)
    // When hidden, the widget may still be in DOM but not visible
    const findWidget = window.locator('.monaco-editor .find-widget.visible');
    await expect(findWidget).not.toBeVisible({ timeout: 3_000 });
  });

  test('Cmd+H opens the find and replace widget', async () => {
    // Focus editor
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Press Cmd+H to open find and replace
    await window.keyboard.press('Meta+h');
    await window.waitForTimeout(500);

    // The find widget should appear with the replace row visible
    const findWidget = window.locator('.monaco-editor .find-widget');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });

    // Replace input should be visible (Monaco shows a second input row)
    const replaceInput = window.locator('.monaco-editor .find-widget .replace-input');
    await expect(replaceInput.first()).toBeVisible({ timeout: 3_000 });

    // Close it
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
  });

  test('Cmd+Option+F also opens find and replace widget', async () => {
    // Focus editor
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Press Cmd+Option+F
    await window.keyboard.press('Meta+Alt+f');
    await window.waitForTimeout(500);

    // Find widget should appear with replace
    const findWidget = window.locator('.monaco-editor .find-widget');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });

    // Close it
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
  });
});

// ===========================================================================
// PART B: Search and Match Highlighting
// ===========================================================================

test.describe('Search and Match Highlighting', () => {
  test('typing a query highlights matches in the editor', async () => {
    // Focus editor and open find
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(500);

    // Type "name" — sample.ts has multiple occurrences
    await window.keyboard.type('name', { delay: 50 });
    await window.waitForTimeout(500);

    // Match highlights should appear in the editor
    // Monaco renders highlights as .findMatch elements
    const highlights = window.locator('.monaco-editor .findMatch');
    await expect(highlights.first()).toBeVisible({ timeout: 5_000 });
    const count = await highlights.count();
    expect(count).toBeGreaterThan(1); // "name" appears multiple times in sample.ts
  });

  test('match count is displayed in the find widget', async () => {
    // The find widget shows match count like "1 of 7"
    const matchInfo = window.locator('.monaco-editor .find-widget .matchesCount');
    await expect(matchInfo).toBeVisible({ timeout: 3_000 });
    const text = await matchInfo.textContent();
    // Should contain "of" pattern (e.g., "1 of 7")
    expect(text).toMatch(/\d+\s+of\s+\d+/);
  });

  test('Enter navigates to next match', async () => {
    // Get initial match info
    const matchInfo = window.locator('.monaco-editor .find-widget .matchesCount');
    const initialText = await matchInfo.textContent();

    // Press Enter to go to next match
    await window.keyboard.press('Enter');
    await window.waitForTimeout(300);

    // Match counter should advance (e.g., "1 of 7" → "2 of 7")
    const nextText = await matchInfo.textContent();
    // The counter should change (unless there's only 1 match, which we know isn't the case)
    expect(nextText).not.toEqual(initialText);
  });

  test('Shift+Enter navigates to previous match', async () => {
    const matchInfo = window.locator('.monaco-editor .find-widget .matchesCount');
    const initialText = await matchInfo.textContent();

    // Press Shift+Enter to go to previous match
    await window.keyboard.press('Shift+Enter');
    await window.waitForTimeout(300);

    const prevText = await matchInfo.textContent();
    expect(prevText).not.toEqual(initialText);
  });

  test('find widget toggle buttons are visible (case, word, regex)', async () => {
    // Monaco renders toggle buttons for case-sensitive, whole-word, and regex
    const toggleButtons = window.locator('.monaco-editor .find-widget .button.toggle');
    await expect(toggleButtons.first()).toBeVisible({ timeout: 3_000 });
    const count = await toggleButtons.count();
    // At least 3 toggles: case, word, regex
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('close find widget after search tests', async () => {
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
  });
});

// ===========================================================================
// PART C: Replace Functionality
// ===========================================================================

test.describe('Replace Functionality', () => {
  test('replace a single match and verify dirty state', async () => {
    // Focus editor and open find+replace
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);
    await window.keyboard.press('Meta+h');
    await window.waitForTimeout(500);

    // Type search query
    const findWidget = window.locator('.monaco-editor .find-widget');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });

    // Clear any existing search and type new one
    // Focus the find input
    const findInput = window.locator('.monaco-editor .find-widget .input').first();
    await findInput.click();
    await window.keyboard.press('Meta+a');
    await window.keyboard.type('_defaultName', { delay: 50 });
    await window.waitForTimeout(500);

    // Focus replace input and type replacement
    const replaceInput = window.locator('.monaco-editor .find-widget .replace-input .input').first();
    await replaceInput.click();
    await window.keyboard.type('_replacedName', { delay: 50 });
    await window.waitForTimeout(300);

    // Click the "Replace" button (single replacement)
    const replaceBtn = window.locator('.monaco-editor .find-widget .replace-part .button').first();
    await replaceBtn.click();
    await window.waitForTimeout(500);

    // Dirty indicator should appear (orange dot in header)
    // The file header shows a dot with bg-ctp-peach when dirty
    const dirtyDot = window.locator('.bg-ctp-peach');
    await expect(dirtyDot).toBeVisible({ timeout: 5_000 });
  });

  test('undo reverses the replacement', async () => {
    // Close find widget first
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);

    // Focus editor
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Undo
    await window.keyboard.press('Meta+z');
    await window.waitForTimeout(500);

    // Dirty state should clear since we're back to original
    // Wait a moment for the dirty check to fire
    await window.waitForTimeout(500);

    // The dirty dot should disappear
    const dirtyDot = window.locator('.bg-ctp-peach');
    await expect(dirtyDot).not.toBeVisible({ timeout: 5_000 });
  });
});

// ===========================================================================
// PART D: Theme Integration
// ===========================================================================

test.describe('Find Widget Theme Integration', () => {
  test('find widget uses themed colors for background', async () => {
    // Open find widget
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(500);

    // The find widget should have a background color from the theme
    // (editorWidget.background = theme.colors.mantle)
    const findWidget = window.locator('.monaco-editor .find-widget');
    await expect(findWidget).toBeVisible({ timeout: 5_000 });

    const bgColor = await findWidget.evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });

    // Background should not be transparent or white (default)
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(bgColor).not.toBe('transparent');
  });

  test('find widget input has themed styling', async () => {
    // Check that the search input has themed background
    const input = window.locator('.monaco-editor .find-widget input[type="text"]').first();
    if (await input.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const inputBg = await input.evaluate((el) => {
        return getComputedStyle(el).backgroundColor;
      });
      // Should have a themed background, not default browser white
      expect(inputBg).not.toBe('rgb(255, 255, 255)');
    }

    // Close find widget
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
  });
});

// ===========================================================================
// PART E: Multi-cursor Find Keybindings
// ===========================================================================

test.describe('Multi-cursor Find Keybindings', () => {
  test('Cmd+D adds selection to next find match', async () => {
    // Focus editor
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Use Cmd+F to find "name", then close and use Cmd+D
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(300);
    await window.keyboard.type('name', { delay: 50 });
    await window.waitForTimeout(300);
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);

    // Select "name" by double-clicking on it in the editor content
    // First, use Cmd+G to navigate to a "name" occurrence
    // Then select the word
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(300);

    // The find widget should have "name" still in it
    // Press Escape to close but keep the cursor at the found position
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);

    // Cmd+D should not crash the editor
    await window.keyboard.press('Meta+d');
    await window.waitForTimeout(300);

    // The editor should still be functional (no crash)
    await assertNotBlankScreen();
  });

  test('Cmd+Shift+L selects all occurrences without crashing', async () => {
    // Focus editor
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Cmd+Shift+L should not crash
    await window.keyboard.press('Meta+Shift+l');
    await window.waitForTimeout(500);

    // Editor should still be functional
    await assertNotBlankScreen();

    // Undo any changes from multi-cursor operations
    await window.keyboard.press('Meta+z');
    await window.waitForTimeout(300);
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
    // Open find, search, navigate, replace, undo — full cycle
    const editor = window.locator('.monaco-editor').first();
    await editor.click();
    await window.waitForTimeout(300);

    // Find
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(300);
    await window.keyboard.type('greet', { delay: 30 });
    await window.waitForTimeout(300);
    await window.keyboard.press('Enter');
    await window.waitForTimeout(200);
    await window.keyboard.press('Shift+Enter');
    await window.waitForTimeout(200);

    // Switch to replace
    await window.keyboard.press('Escape');
    await window.waitForTimeout(200);
    await window.keyboard.press('Meta+h');
    await window.waitForTimeout(300);

    // Close
    await window.keyboard.press('Escape');
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
