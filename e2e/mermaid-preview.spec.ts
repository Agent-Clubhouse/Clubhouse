import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchApp } from './launch';

// Exercise the real lazy-loaded Mermaid bundle in Electron: component tests
// mock Mermaid and cannot catch packaging or browser API incompatibilities.
test('markdown preview renders diagrams and preserves invalid source', async () => {
  const { electronApp, window } = await launchApp({ experimental: {} });
  try {
    const fixturePath = path.resolve(__dirname, 'fixtures/project-mermaid');
    await electronApp.evaluate(({ dialog, BrowserWindow }, dir) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.webContents.getURL().startsWith('devtools://'),
      ) ?? null;
      BrowserWindow.getFocusedWindow = () => win;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, fixturePath);

    await window.getByTestId('nav-add-project').click();
    await window.getByTestId('explorer-tab-plugin:files').click();
    await window.getByText('diagrams.md', { exact: true }).click();

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
