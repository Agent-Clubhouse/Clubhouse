import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural audit test — ensures all IPC send sites in src/main/ use
 * broadcastToAllWindows() instead of single-window patterns that silently
 * miss pop-out windows.
 *
 * Problematic patterns:
 *   - BrowserWindow.getFocusedWindow()
 *   - BrowserWindow.getAllWindows()[0]
 *   - getMainWindow()
 *
 * Files that legitimately need a single window reference (e.g. as a dialog
 * parent) are listed in the allow-list with a rationale.
 *
 * @see https://github.com/Agent-Clubhouse/Clubhouse/issues/237
 */

const MAIN_SRC_DIR = path.resolve(__dirname, '..');

/**
 * Regex matching single-window targeting patterns.
 * Captures the most common ways a developer might grab "one" window.
 */
const SINGLE_WINDOW_PATTERN =
  /getFocusedWindow\s*\(\)|getAllWindows\s*\(\)\s*\[\s*0\s*\]|getMainWindow\s*\(\)/;

/**
 * Allow-list of files (relative to src/main/) where single-window access is
 * justified. Each entry documents *why* it's acceptable.
 */
const ALLOWED_FILES: Record<string, string> = {
  // Menu items target the focused window intentionally — the user clicked a
  // menu in a specific window and expects that window to respond.
  'menu.ts': 'getFocusedWindow used to target the window whose menu was clicked',

  // dialog.showOpenDialog / dialog.showSaveDialog require a parent
  // BrowserWindow so the dialog is modal to the correct window.
  'ipc/agent-handlers.ts': 'getFocusedWindow used as dialog parent for showOpenDialog / showSaveDialog',
  'ipc/project-handlers.ts': 'getFocusedWindow used as dialog parent for showOpenDialog',
};

/**
 * Recursively collect all .ts source files (excluding tests and declaration
 * files) under the given directory.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

describe('IPC broadcast audit', () => {
  it('should not use single-window IPC patterns outside the allow-list', () => {
    const files = collectSourceFiles(MAIN_SRC_DIR);
    const violations: { file: string; line: number; text: string }[] = [];

    for (const filePath of files) {
      const relative = path.relative(MAIN_SRC_DIR, filePath);
      if (ALLOWED_FILES[relative]) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (SINGLE_WINDOW_PATTERN.test(lines[i])) {
          violations.push({ file: relative, line: i + 1, text: lines[i].trim() });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.text}`)
        .join('\n');
      expect.fail(
        `Found ${violations.length} single-window IPC pattern(s) outside the allow-list.\n` +
          `Either migrate to broadcastToAllWindows() or add to the allow-list with justification.\n\n` +
          report,
      );
    }
  });

  it('should not have stale entries in the allow-list', () => {
    const stale: string[] = [];
    for (const relative of Object.keys(ALLOWED_FILES)) {
      const full = path.join(MAIN_SRC_DIR, relative);
      if (!fs.existsSync(full)) {
        stale.push(relative);
        continue;
      }
      const content = fs.readFileSync(full, 'utf-8');
      if (!SINGLE_WINDOW_PATTERN.test(content)) {
        stale.push(relative);
      }
    }

    if (stale.length > 0) {
      expect.fail(
        `Allow-list contains stale entries that no longer match any pattern:\n` +
          stale.map((f) => `  ${f}`).join('\n') +
          `\nRemove them to keep the allow-list accurate.`,
      );
    }
  });
});
