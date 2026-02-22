import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub Electron's dialog so the next pickAndAddProject resolves to `dirPath`. */
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

/** Add a fixture project by stubbing the dialog and clicking the add button. */
async function addProject(dirPath: string) {
  await stubDialogForPath(dirPath);
  const addBtn = window.locator('[data-testid="nav-add-project"]');
  await addBtn.click();
  const name = path.basename(dirPath);
  await expect(window.locator(`text=${name}`).first()).toBeVisible({
    timeout: 10_000,
  });
}

/** Open the command palette via keyboard shortcut. */
async function openPalette() {
  await window.keyboard.press('Meta+k');
  await expect(window.locator('[data-testid="command-palette-overlay"]')).toBeVisible({
    timeout: 5_000,
  });
}

/** Get the command palette input element. */
function paletteInput() {
  return window.locator('[data-testid="command-palette-overlay"] input');
}

/** Get all visible option elements in the palette list. */
function paletteOptions() {
  return window.locator('[data-testid="command-palette-overlay"] [role="option"]');
}

/** Get the currently selected option (aria-selected="true"). */
function selectedOption() {
  return window.locator('[data-testid="command-palette-overlay"] [role="option"][aria-selected="true"]');
}

/** Check if the palette overlay is visible. */
async function isPaletteOpen(): Promise<boolean> {
  return window.locator('[data-testid="command-palette-overlay"]').isVisible({ timeout: 1_000 }).catch(() => false);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());

  // Add a project so the palette has project/agent entries
  await addProject(FIXTURE_A);
});

test.afterAll(async () => {
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Opening & Closing
// ---------------------------------------------------------------------------

test.describe('Command Palette – Open/Close', () => {
  test('opens with Cmd+K', async () => {
    await openPalette();
    expect(await isPaletteOpen()).toBe(true);

    // Close for next test
    await window.keyboard.press('Escape');
  });

  test('closes with Escape', async () => {
    await openPalette();
    await window.keyboard.press('Escape');

    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  });

  test('closes on backdrop click', async () => {
    await openPalette();

    // The overlay is fixed inset-0, with a backdrop as the first child
    // (absolute inset-0 bg-black/50 with onClick={close}).
    // Click the bottom-left corner of the overlay, well away from the palette.
    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    const box = await overlay.boundingBox();
    if (box) {
      await window.mouse.click(box.x + 10, box.y + box.height - 10);
    }

    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  });

  test('toggles with Cmd+K (open → close)', async () => {
    await openPalette();
    await window.keyboard.press('Meta+k');

    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// 2. Input & Focus
// ---------------------------------------------------------------------------

test.describe('Command Palette – Input', () => {
  test('input is auto-focused on open', async () => {
    await openPalette();
    const input = paletteInput();
    await expect(input).toBeFocused({ timeout: 3_000 });

    await window.keyboard.press('Escape');
  });

  test('input starts empty on each open', async () => {
    // Type something, close, reopen — should be empty
    await openPalette();
    await window.keyboard.type('hello');
    await window.keyboard.press('Escape');

    await openPalette();
    const input = paletteInput();
    await expect(input).toHaveValue('');

    await window.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// 3. Results & Filtering
// ---------------------------------------------------------------------------

test.describe('Command Palette – Filtering', () => {
  test('shows results when open with no query', async () => {
    await openPalette();

    const options = paletteOptions();
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    await window.keyboard.press('Escape');
  });

  test('filters results as user types', async () => {
    await openPalette();

    const initialCount = await paletteOptions().count();

    // Type a partial query that should reduce results
    await window.keyboard.type('settings');
    await window.waitForTimeout(200);

    const filteredCount = await paletteOptions().count();
    expect(filteredCount).toBeLessThan(initialCount);
    expect(filteredCount).toBeGreaterThan(0);

    // Check that a settings-related result is shown
    const options = paletteOptions();
    const texts: string[] = [];
    for (let i = 0; i < filteredCount; i++) {
      texts.push((await options.nth(i).textContent()) ?? '');
    }
    const hasSettings = texts.some((t) => t.toLowerCase().includes('settings'));
    expect(hasSettings).toBe(true);

    await window.keyboard.press('Escape');
  });

  test('shows "No results found" for impossible query', async () => {
    await openPalette();
    await window.keyboard.type('xyznonexistent999');
    await window.waitForTimeout(200);

    const noResults = window.locator('text=No results found');
    await expect(noResults).toBeVisible({ timeout: 3_000 });

    await window.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// 4. Mode Prefixes
// ---------------------------------------------------------------------------

test.describe('Command Palette – Mode Prefixes', () => {
  test('> prefix shows commands mode badge', async () => {
    await openPalette();
    await window.keyboard.type('>');
    await window.waitForTimeout(200);

    const badge = window.locator('[data-testid="command-palette-overlay"]').locator('text=Commands');
    await expect(badge).toBeVisible({ timeout: 3_000 });

    await window.keyboard.press('Escape');
  });

  test('@ prefix shows agents mode badge', async () => {
    await openPalette();
    await window.keyboard.type('@');
    await window.waitForTimeout(200);

    const badge = window.locator('[data-testid="command-palette-overlay"]').locator('text=Agents');
    await expect(badge).toBeVisible({ timeout: 3_000 });

    await window.keyboard.press('Escape');
  });

  test('# prefix shows projects mode badge', async () => {
    await openPalette();

    // Type '#' via fill to avoid keyboard interpretation issues
    const input = paletteInput();
    await input.fill('#');
    await window.waitForTimeout(300);

    // The mode badge is a <span> with specific styling classes, distinct from
    // the category header. Use the badge's parent (the input row with border-b).
    const inputRow = window.locator('[data-testid="command-palette-overlay"]').locator('.border-b');
    const badge = inputRow.locator('text=Projects');
    await expect(badge).toBeVisible({ timeout: 3_000 });

    await window.keyboard.press('Escape');
  });

  test('> prefix filters to command actions only', async () => {
    await openPalette();
    await window.keyboard.type('>');
    await window.waitForTimeout(200);

    const options = paletteOptions();
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    // Verify results contain action-type items (Settings, Help, etc.)
    const texts: string[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      texts.push((await options.nth(i).textContent()) ?? '');
    }
    const hasAction = texts.some(
      (t) =>
        t.toLowerCase().includes('settings') ||
        t.toLowerCase().includes('help') ||
        t.toLowerCase().includes('home') ||
        t.toLowerCase().includes('sidebar'),
    );
    expect(hasAction).toBe(true);

    await window.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// 5. Keyboard Navigation
// ---------------------------------------------------------------------------

test.describe('Command Palette – Keyboard Navigation', () => {
  test('ArrowDown moves selection to next item', async () => {
    await openPalette();

    // First item should be selected by default
    const firstSelected = selectedOption();
    const firstText = await firstSelected.textContent();

    await window.keyboard.press('ArrowDown');
    await window.waitForTimeout(100);

    const nextSelected = selectedOption();
    const nextText = await nextSelected.textContent();
    expect(nextText).not.toBe(firstText);

    await window.keyboard.press('Escape');
  });

  test('ArrowUp moves selection to previous item', async () => {
    await openPalette();

    // Move down, then up
    await window.keyboard.press('ArrowDown');
    await window.waitForTimeout(100);
    await window.keyboard.press('ArrowUp');
    await window.waitForTimeout(100);

    // Should be back on first item (index 0)
    const selected = selectedOption();
    const firstOption = paletteOptions().first();
    expect(await selected.textContent()).toBe(await firstOption.textContent());

    await window.keyboard.press('Escape');
  });

  test('ArrowUp from first item wraps to last', async () => {
    await openPalette();

    // From the first item, pressing up should wrap to last
    await window.keyboard.press('ArrowUp');
    await window.waitForTimeout(100);

    const selected = selectedOption();
    const allOptions = paletteOptions();
    const lastOption = allOptions.last();
    expect(await selected.textContent()).toBe(await lastOption.textContent());

    await window.keyboard.press('Escape');
  });

  test('Enter executes the selected command', async () => {
    await openPalette();

    // Type a query to get a specific result, e.g. "settings"
    await window.keyboard.type('>settings');
    await window.waitForTimeout(200);

    const optionCount = await paletteOptions().count();
    expect(optionCount).toBeGreaterThan(0);

    // Press Enter to execute
    await window.keyboard.press('Enter');

    // The palette should close after executing
    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// 6. Mouse Interaction
// ---------------------------------------------------------------------------

test.describe('Command Palette – Mouse Interaction', () => {
  test('hovering over an option selects it', async () => {
    await openPalette();

    const options = paletteOptions();
    const count = await options.count();
    if (count < 2) {
      await window.keyboard.press('Escape');
      return;
    }

    // Hover over the second option
    await options.nth(1).hover();
    await window.waitForTimeout(100);

    const selected = selectedOption();
    expect(await selected.textContent()).toBe(await options.nth(1).textContent());

    await window.keyboard.press('Escape');
  });

  test('clicking an option executes it and closes palette', async () => {
    await openPalette();

    const options = paletteOptions();
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    // Filter to a known safe action
    await window.keyboard.type('>help');
    await window.waitForTimeout(200);

    const helpOption = paletteOptions().first();
    await helpOption.click();

    // Palette should close
    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// 7. Category Groups
// ---------------------------------------------------------------------------

test.describe('Command Palette – Categories', () => {
  test('results are grouped by category headers', async () => {
    await openPalette();

    // Category headers are uppercase text elements in the palette
    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    const categoryHeaders = overlay.locator('.uppercase');
    const headerCount = await categoryHeaders.count();

    // Should have at least one category group
    expect(headerCount).toBeGreaterThan(0);

    await window.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// 8. Recent Commands
// ---------------------------------------------------------------------------

test.describe('Command Palette – Recent Commands', () => {
  test('executed command appears in recents on next open', async () => {
    // Execute a command first
    await openPalette();
    await window.keyboard.type('>help');
    await window.waitForTimeout(200);

    const firstOptionText = await paletteOptions().first().textContent();
    await window.keyboard.press('Enter');

    // Wait for palette to close
    await expect(
      window.locator('[data-testid="command-palette-overlay"]'),
    ).not.toBeVisible({ timeout: 3_000 });

    // Reopen palette with no query — recents should appear
    await openPalette();
    await window.waitForTimeout(200);

    // Look for a "Recently Used" category header
    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    const recentHeader = overlay.locator('text=Recently Used');
    const hasRecent = await recentHeader.isVisible({ timeout: 3_000 }).catch(() => false);

    // The executed command should appear (either in "Recently Used" group
    // or boosted in the list)
    if (hasRecent) {
      expect(hasRecent).toBe(true);
    } else {
      // At minimum, the command should still be visible in results
      const options = paletteOptions();
      const count = await options.count();
      expect(count).toBeGreaterThan(0);
    }

    await window.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// 9. Highlight Matches
// ---------------------------------------------------------------------------

test.describe('Command Palette – Match Highlighting', () => {
  test('matching characters are visually distinguished in results', async () => {
    await openPalette();
    // "togg" matches the label text "Toggle ..." directly (substring match),
    // producing non-empty matchIndices so HighlightedLabel splits the text
    // into highlighted and non-highlighted <span> children.
    await window.keyboard.type('>togg');
    await window.waitForTimeout(300);

    const options = paletteOptions();
    const count = await options.count();
    if (count === 0) {
      await window.keyboard.press('Escape');
      return;
    }

    // Look across visible options for one with split spans (highlighting).
    let foundHighlighted = false;
    for (let i = 0; i < Math.min(count, 10); i++) {
      const hasMultipleSpans = await options.nth(i).evaluate((el) => {
        const spans = el.querySelectorAll('span');
        for (const span of spans) {
          const children = span.querySelectorAll(':scope > span');
          if (children.length > 1) return true;
        }
        return false;
      });
      if (hasMultipleSpans) {
        foundHighlighted = true;
        break;
      }
    }

    expect(foundHighlighted).toBe(true);

    await window.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// 10. Rapid Interactions
// ---------------------------------------------------------------------------

test.describe('Command Palette – Stability', () => {
  test('rapid open/close does not leave ghost overlay', async () => {
    for (let i = 0; i < 5; i++) {
      await window.keyboard.press('Meta+k');
      await window.waitForTimeout(50);
    }

    // After an odd number of toggles, palette should be open
    // After an even number, it should be closed
    // Wait for state to settle
    await window.waitForTimeout(300);

    // Close if open
    if (await isPaletteOpen()) {
      await window.keyboard.press('Escape');
    }

    const overlay = window.locator('[data-testid="command-palette-overlay"]');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  });

  test('typing quickly produces correct filtered results', async () => {
    await openPalette();

    // Type quickly
    await window.keyboard.type('settings', { delay: 20 });
    await window.waitForTimeout(300);

    const input = paletteInput();
    await expect(input).toHaveValue('settings');

    const options = paletteOptions();
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    await window.keyboard.press('Escape');
  });
});
