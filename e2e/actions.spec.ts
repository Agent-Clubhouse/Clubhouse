import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchApp, type LaunchedApp } from './launch';

/**
 * Settings > Actions (#2918) at the UI level. Nothing here starts an agent or
 * spends tokens: the steps are "Notify me", and one seeded action shows the
 * reason Clubhouse turned it off.
 *
 * - the empty state offers three starters that open the form pre-filled;
 * - a new action is saved from the form and listed in plain words;
 * - Run now records a run on its card;
 * - turning it off from its row is saved to actions.json;
 * - an action Clubhouse turned off shows why under its name.
 *
 * Runs in the Chat E2E job (Linux and Windows) with the other new-layout
 * specs, not the sharded E2E run, so it never lengthens the E2E long pole.
 */

let app: LaunchedApp | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app?.profile.dispose();
  app = undefined;
});

async function openActions(w: Page): Promise<void> {
  const nav = w.getByRole('button', { name: 'Actions', exact: true });
  if (!(await nav.isVisible().catch(() => false))) await w.locator('[data-testid="nav-settings"]').click();
  await nav.click();
  await expect(w.getByTestId('actions-settings')).toBeVisible();
}

/**
 * The saved actions people can see, or undefined while the file is missing or
 * can't be parsed yet, so a poll tries again. Clubhouse's own hidden actions
 * (owner 'app', e.g. the Dispatcher's upkeep, #3040) are saved in the same
 * file and left out, as every list leaves them out.
 */
async function readActions(userDataDir: string): Promise<Array<{ name: string; enabled: boolean }> | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'actions.json'), 'utf8'));
    if (!Array.isArray(parsed?.actions)) return undefined;
    return (parsed.actions as Array<{ name: string; enabled: boolean; owner?: { kind?: string } }>).filter((a) => a.owner?.kind !== 'app');
  } catch {
    return undefined;
  }
}

test('create, run and turn off an action from Settings', async () => {
  app = await launchApp({ label: 'actions' });
  const w = app.window;
  await openActions(w);

  // Empty: what actions do, and three starters.
  const empty = w.getByTestId('actions-empty');
  await expect(empty).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Use' })).toHaveCount(3);

  // New action: weekdays at 9, notify me.
  await w.getByTestId('actions-new').click();
  const form = w.getByTestId('action-form');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('action-form-schedule-words')).toContainText('Weekdays at 9:00 AM');
  await form.getByLabel('Step 1 type').selectOption('notify');
  await form.getByLabel('Notice text').fill('Plan the day');
  await form.getByLabel('Name').fill('Morning check');
  await form.getByTestId('action-form-save').click();
  await expect(form).toBeHidden();

  const row = w.getByTestId('action-row').filter({ hasText: 'Morning check' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Weekdays at 9:00 AM → Notify you');
  await expect(row).toContainText('You');
  await expect.poll(async () => (await readActions(app!.userDataDir))?.map((a) => a.name)).toEqual(['Morning check']);

  // Run now from its card records a run.
  await row.getByText('Morning check', { exact: true }).click();
  const card = w.getByTestId('action-card');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Run now' }).click();
  await expect(card.getByTestId('action-run').first()).toContainText('Done');
  await card.getByRole('button', { name: 'Close' }).click().catch(() => w.keyboard.press('Escape'));
  await expect(card).toBeHidden();

  // Turn it off from its row; it's saved.
  await row.getByRole('switch').click();
  await expect.poll(async () => (await readActions(app!.userDataDir))?.[0]?.enabled).toBe(false);
  await w.getByRole('tab', { name: 'Turned off' }).click();
  await expect(w.getByTestId('action-row')).toHaveCount(1);
});

test('shows why Clubhouse turned an action off', async () => {
  app = await launchApp({
    label: 'actions-off',
    userDataFiles: {
      'actions.json': {
        version: 1,
        actions: [{
          id: 'act_seeded', name: 'Wake the pm', owner: { kind: 'user' }, enabled: false,
          offReason: 'Turned off: pm was deleted',
          trigger: { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' },
          steps: [{ kind: 'notify', text: 'x' }], overlap: 'skip', createdAt: 1, updatedAt: 1,
        }],
        state: { nextAt: {}, waits: [] },
      },
    },
  });
  const w = app.window;
  await openActions(w);
  const row = w.getByTestId('action-row').filter({ hasText: 'Wake the pm' });
  await expect(row.getByTestId('action-row-reason')).toHaveText('Turned off: pm was deleted');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
});
