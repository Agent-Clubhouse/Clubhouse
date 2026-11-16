/**
 * #3552: the app row's narrow rule for Group Projects. At the default sidebar
 * width only the selected entry shows its label; the others are icons that keep
 * their accessible names. Widening the sidebar shows all three labels.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';
import { installFakeClis } from './chat-fake-cli';

const ENTRIES = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'review', label: 'Review' },
  { id: 'group-projects', label: 'Group Projects' },
];

async function expectOnlyLabelled(window: Page, selected: string | null) {
  for (const entry of ENTRIES) {
    const button = window.getByTestId(`app-row-${entry.id}`);
    await expect(button).toHaveAttribute('aria-label', entry.label);
    await expect(button).toHaveText(entry.id === selected ? entry.label : '');
  }
}

/** Drags the sidebar's divider right by `dx`: the divider nearest the app row's right edge. */
async function widenSidebar(window: Page, dx: number) {
  const row = await window.locator('nav[aria-label="App views"]').boundingBox();
  expect(row).not.toBeNull();
  const dividers = window.getByTestId('resize-divider');
  let best: { x: number; y: number } | null = null;
  let distance = Infinity;
  for (let i = 0; i < await dividers.count(); i += 1) {
    const box = await dividers.nth(i).boundingBox();
    if (!box) continue;
    const gap = Math.abs(box.x + box.width / 2 - (row!.x + row!.width));
    if (gap < distance) { distance = gap; best = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
  }
  expect(best).not.toBeNull();
  await window.mouse.move(best!.x, best!.y);
  await window.mouse.down();
  await window.mouse.move(best!.x + dx, best!.y, { steps: 12 });
  await window.mouse.up();
}

test('only the selected app row entry shows its label when narrow, and all three when wide', async () => {
  const fakes = await installFakeClis({});
  const { electronApp, window, userDataDir } = await launchApp({ env: fakes.env });
  try {
    // Nothing selected: three icons, each still named.
    await expectOnlyLabelled(window, null);

    await window.getByTestId('app-row-group-projects').click();
    await expect(window.getByTestId('app-row-group-projects')).toHaveAttribute('aria-current', 'page');
    await expectOnlyLabelled(window, 'group-projects');

    await window.getByTestId('app-row-canvas').click();
    await expect(window.getByTestId('app-row-canvas')).toHaveAttribute('aria-current', 'page');
    await expectOnlyLabelled(window, 'canvas');
    await expect(window.getByTestId('app-row-group-projects')).not.toHaveAttribute('aria-current', 'page');

    // Back to Group Projects by keyboard: the icon is focusable and Enter selects it.
    await window.getByTestId('app-row-group-projects').focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('group-projects-hub')).toBeVisible();
    await expectOnlyLabelled(window, 'group-projects');

    // Wide: every label, selected or not.
    await widenSidebar(window, 160);
    for (const entry of ENTRIES) await expect(window.getByTestId(`app-row-${entry.id}`)).toHaveText(entry.label);
  } finally {
    await electronApp.close();
    await fakes.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
