import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

const FIXTURE_A = path.resolve(__dirname, 'fixtures/project-a');
const AGENTS_JSON = path.join(FIXTURE_A, '.clubhouse', 'agents.json');

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

/** Write durable agents to agents.json in the fixture project. */
function writeAgentsJson(
  agents: Array<{ id: string; name: string; color: string }>,
) {
  const dir = path.join(FIXTURE_A, '.clubhouse');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const configs = agents.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    createdAt: new Date().toISOString(),
  }));
  fs.writeFileSync(
    path.join(dir, 'agents.json'),
    JSON.stringify(configs, null, 2),
    'utf-8',
  );
}

/** Get agent IDs in DOM order from the agent list. */
async function getDurableAgentOrder(): Promise<string[]> {
  // Wait for at least one durable agent to render before querying DOM order.
  // Durable agents load asynchronously via IPC after the project is added,
  // so a raw evaluate() can return an empty array if called too early.
  await expect(
    window.locator('[data-testid^="durable-drag-"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  return window.evaluate(() => {
    const items = document.querySelectorAll('[data-testid^="durable-drag-"]');
    return Array.from(items).map((el) => el.getAttribute('data-agent-id') || '');
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // Write durable agents to agents.json BEFORE launching the app
  // so they load when the project is first added
  writeAgentsJson([
    { id: 'durable_r1', name: 'alpha-agent', color: 'indigo' },
    { id: 'durable_r2', name: 'beta-agent', color: 'green' },
    { id: 'durable_r3', name: 'gamma-agent', color: 'red' },
  ]);

  ({ electronApp, window } = await launchApp());
  await addProject(FIXTURE_A);
  await window.waitForTimeout(1_000);
});

test.afterAll(async () => {
  // Clean up agents.json
  if (fs.existsSync(AGENTS_JSON)) {
    fs.writeFileSync(AGENTS_JSON, '[]', 'utf-8');
  }
  await electronApp?.close();
});

// ---------------------------------------------------------------------------
// 1. Completed Footer — Always Visible
// ---------------------------------------------------------------------------

test.describe('Completed Footer', () => {
  test('completed footer is visible even with zero completed agents', async () => {
    const footer = window.locator('[data-testid="completed-footer"]');
    await expect(footer).toBeVisible({ timeout: 5_000 });

    const toggle = window.locator('[data-testid="completed-toggle"]');
    await expect(toggle).toContainText('Completed (0)');
  });

  test('"Clear all" is hidden when no completed agents', async () => {
    const clearBtn = window.locator('[data-testid="completed-clear-all"]');
    await expect(clearBtn).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2. Collapsible Completed Section
// ---------------------------------------------------------------------------

test.describe('Collapsible Completed Section', () => {
  test('clicking toggle collapses the completed items', async () => {
    // Ensure expanded first
    const items = window.locator('[data-testid="completed-items"]');
    let maxHeight = await items.evaluate((el) => el.style.maxHeight);
    if (maxHeight === '0px' || maxHeight === '0') {
      await window.locator('[data-testid="completed-toggle"]').click();
      await window.waitForTimeout(400);
    }

    // Now collapse
    await window.locator('[data-testid="completed-toggle"]').click();
    await window.waitForTimeout(400);

    maxHeight = await items.evaluate((el) => el.style.maxHeight);
    expect(maxHeight).toBe('0px');
  });

  test('clicking toggle again expands the completed items', async () => {
    await window.locator('[data-testid="completed-toggle"]').click();
    await window.waitForTimeout(400);

    const items = window.locator('[data-testid="completed-items"]');
    const maxHeight = await items.evaluate((el) => el.style.maxHeight);
    expect(maxHeight).toBe('33vh');
  });

  test('"Clear all" is hidden when collapsed', async () => {
    // Collapse
    await window.locator('[data-testid="completed-toggle"]').click();
    await window.waitForTimeout(400);

    const clearBtn = window.locator('[data-testid="completed-clear-all"]');
    await expect(clearBtn).not.toBeVisible();

    // Expand back
    await window.locator('[data-testid="completed-toggle"]').click();
    await window.waitForTimeout(400);
  });

  test('collapse state persists in localStorage', async () => {
    // Collapse
    await window.locator('[data-testid="completed-toggle"]').click();
    await window.waitForTimeout(400);

    const storedValue = await window.evaluate(() =>
      localStorage.getItem('clubhouse_completed_collapsed'),
    );
    expect(storedValue).toBe('true');

    // Expand back
    await window.locator('[data-testid="completed-toggle"]').click();
    await window.waitForTimeout(400);

    const storedValue2 = await window.evaluate(() =>
      localStorage.getItem('clubhouse_completed_collapsed'),
    );
    expect(storedValue2).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// 3. Completed Footer with Items
// ---------------------------------------------------------------------------
// NOTE: Injecting completed agents via localStorage + page reload is fragile
// in e2e (Zustand store re-init timing + dynamic project IDs). The core
// completed-section behaviors (always-visible footer, collapse/expand toggle,
// localStorage persistence, Clear all visibility, 33vh cap) are covered above.
// The "Clear all removes items" flow is best tested via unit tests.

// ---------------------------------------------------------------------------
// 4. Drag-to-Reorder Durable Agents
// ---------------------------------------------------------------------------

test.describe('Drag-to-Reorder', () => {
  test('durable agents render in insertion order from agents.json', async () => {
    const order = await getDurableAgentOrder();
    expect(order).toContain('durable_r1');
    expect(order).toContain('durable_r2');
    expect(order).toContain('durable_r3');

    const idx1 = order.indexOf('durable_r1');
    const idx2 = order.indexOf('durable_r2');
    const idx3 = order.indexOf('durable_r3');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  test('durable agent containers have draggable attribute', async () => {
    const drag0 = window.locator('[data-testid="durable-drag-0"]');
    await expect(drag0).toBeVisible({ timeout: 5_000 });
    const draggable = await drag0.getAttribute('draggable');
    expect(draggable).toBe('true');
  });

  test('all three durable agents have drag containers', async () => {
    for (let i = 0; i < 3; i++) {
      const drag = window.locator(`[data-testid="durable-drag-${i}"]`);
      await expect(drag).toBeVisible();
      expect(await drag.getAttribute('draggable')).toBe('true');
    }
  });

  test('each drag container has an agent-id attribute', async () => {
    const expectedIds = ['durable_r1', 'durable_r2', 'durable_r3'];
    for (let i = 0; i < 3; i++) {
      const drag = window.locator(`[data-testid="durable-drag-${i}"]`);
      const agentId = await drag.getAttribute('data-agent-id');
      expect(expectedIds).toContain(agentId);
    }
  });

  test('agent name text is visible for each durable agent', async () => {
    const names = ['alpha-agent', 'beta-agent', 'gamma-agent'];
    for (const name of names) {
      await expect(
        window.locator(`[data-agent-name="${name}"]`).first(),
      ).toBeVisible({ timeout: 3_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Completed Footer Position (pinned at bottom)
// ---------------------------------------------------------------------------

test.describe('Completed Footer Position', () => {
  test('completed footer is below the scrollable agent area', async () => {
    const agentList = window.locator('[data-testid="agent-list"]');
    const footer = window.locator('[data-testid="completed-footer"]');

    await expect(agentList).toBeVisible();
    await expect(footer).toBeVisible();

    const agentListBox = await agentList.boundingBox();
    const footerBox = await footer.boundingBox();

    expect(agentListBox).not.toBeNull();
    expect(footerBox).not.toBeNull();

    // Footer bottom should be at or near the agent-list bottom
    const agentListBottom = agentListBox!.y + agentListBox!.height;
    const footerBottom = footerBox!.y + footerBox!.height;
    expect(footerBottom).toBeCloseTo(agentListBottom, -1);
  });

  test('completed items max-height CSS is 33vh when expanded', async () => {
    // Ensure expanded
    const items = window.locator('[data-testid="completed-items"]');
    const maxHeight = await items.evaluate((el) => el.style.maxHeight);
    if (maxHeight === '0px' || maxHeight === '0') {
      await window.locator('[data-testid="completed-toggle"]').click();
      await window.waitForTimeout(400);
    }

    const mh = await items.evaluate((el) => el.style.maxHeight);
    expect(mh).toBe('33vh');
  });
});
