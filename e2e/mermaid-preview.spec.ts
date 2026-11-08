import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';
import { assertRunLayout, clickExplorerTab } from './smoke-helpers';

// Exercise the real lazy-loaded Mermaid bundle in Electron: component tests
// mock Mermaid and cannot catch packaging or browser API incompatibilities.
test('markdown preview renders diagrams and preserves invalid source', async () => {
  const { electronApp, window } = await launchApp();
  try {
    await assertRunLayout(window);
    const fixturePath = path.resolve(__dirname, 'fixtures/project-mermaid');
    await electronApp.evaluate(({ dialog, BrowserWindow }, dir) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.webContents.getURL().startsWith('devtools://'),
      ) ?? null;
      BrowserWindow.getFocusedWindow = () => win;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, fixturePath);

    await window.getByTestId('nav-add-project').click();
    await clickExplorerTab(electronApp, window, 'explorer-tab-plugin:files');
    // The Files tree: the accessory column on classic, the sidebar on the new layout.
    await window.locator('[role="treeitem"][data-path$="diagrams.md"]').click();

    const diagrams = window.getByTestId('mermaid-diagram');
    await expect(diagrams).toHaveCount(4, { timeout: 30_000 });
    for (const [index, label] of ['Start', 'Alice', 'Animal', 'Ready'].entries()) {
      const svg = diagrams.nth(index).locator('svg');
      await expect(svg).toBeVisible();
      await expect(svg).toContainText(label);
      const bounds = await svg.boundingBox();
      expect(bounds?.width).toBeGreaterThan(0);
      expect(bounds?.height).toBeGreaterThan(0);
    }

    const error = window.getByRole('alert').filter({ hasText: 'Mermaid diagram error' });
    await expect(error).toBeVisible();
    await expect(error).toContainText('this is not a valid diagram');
  } finally {
    await electronApp.close();
  }
});
