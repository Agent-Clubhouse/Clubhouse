/**
 * Settings > Annex Network (#3067): one page for the whole network.
 *
 * Two desktops turn Annex Network on from the page, pair, and each lists the
 * other as a device in its network. On one, the other is renamed and then
 * removed from the page; the other leaves the network.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import { openSettings, openSettingsPage } from '../smoke-helpers';

let handles: DualInstanceHandles;

test.setTimeout(300_000);

test.beforeAll(async () => {
  handles = await launchDual();
});

test.afterAll(async () => {
  if (handles) await cleanupDual(handles);
});

async function openPage(w: Page): Promise<void> {
  await openSettings(w);
  await openSettingsPage(w, 'annex', 'Annex Network');
  await expect(w.getByTestId('annex-network-toggle')).toBeVisible({ timeout: 10_000 });
}

async function turnOn(w: Page): Promise<void> {
  await w.getByRole('switch', { name: 'Annex Network on this computer' }).click();
  await expect(w.getByText('Add a device')).toBeVisible({ timeout: 15_000 });
}

function status(w: Page): Promise<{ fingerprint: string; pairingUrl?: string; port: number; pin: string; tlsCertificateFingerprint: string }> {
  return w.evaluate(() => (window as any).clubhouse.annex.getStatus());
}

test('two desktops join from the page, and one renames and removes the other', async () => {
  const { satellite: a, controller: b } = handles;
  await openPage(a.window);
  await openPage(b.window);
  await turnOn(a.window);
  await turnOn(b.window);

  // A's page shows a one-time code, its pairing link and where it's reachable.
  await expect(a.window.getByTestId('annex-pairing-code')).toContainText(/\d{6}/, { timeout: 15_000 });
  await expect(a.window.getByTestId('annex-pairing-link')).toContainText('clubhousego://pair', { timeout: 15_000 });
  await expect(a.window.getByTestId('annex-certificate-code')).toBeVisible();

  // B pairs from manually supplied details, without a pairing link.
  const details = await status(a.window);
  await expect(a.window.getByLabel('Certificate fingerprint', { exact: true })).toHaveValue(details.tlsCertificateFingerprint);
  await b.window.getByRole('button', { name: 'Pair with another computer' }).click();
  await b.window.getByRole('button', { name: 'Pair without a link' }).click();
  await b.window.getByLabel('Address and port', { exact: true }).fill(`127.0.0.1:${details.port}`);
  await b.window.getByTestId('pairing-wizard').getByLabel('Certificate fingerprint', { exact: true }).fill(details.tlsCertificateFingerprint);
  await b.window.getByLabel('One-time code', { exact: true }).fill(details.pin);
  await b.window.getByRole('button', { name: 'Pair manually' }).click();
  await expect(b.window.getByText(/^Paired with /)).toBeVisible({ timeout: 15_000 });
  await b.window.getByRole('button', { name: 'Done', exact: true }).click();

  // Each page lists the other, connected, in its network.
  const rowOn = (w: Page) => w.getByTestId('annex-device-row').first();
  for (const w of [a.window, b.window]) {
    await expect(rowOn(w)).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(rowOn(w)).toHaveAttribute('data-role', 'member');
    await expect(rowOn(w)).toContainText('In this network');
  }

  // B renames A.
  await b.window.getByRole('button', { name: 'Rename' }).first().click();
  const name = b.window.getByTestId('annex-rename-editor').getByRole('textbox');
  await name.fill('Studio in the network');
  await b.window.getByTestId('annex-rename-editor').getByRole('button', { name: 'Save' }).click();
  await expect(rowOn(b.window)).toContainText('Studio in the network', { timeout: 10_000 });

  // B removes A: gone from B's page, and A is no longer connected to B. Whether A hears
  // the removal before the connection drops is timing, so its row may stay as needing pairing.
  await b.window.getByRole('button', { name: 'Remove' }).first().click();
  await b.window.getByRole('button', { name: 'Confirm' }).first().click();
  await expect(b.window.getByTestId('annex-device-row')).toHaveCount(0, { timeout: 30_000 });
  await expect(a.window.locator('[data-testid="annex-device-row"][data-state="connected"]')).toHaveCount(0, { timeout: 30_000 });
});
