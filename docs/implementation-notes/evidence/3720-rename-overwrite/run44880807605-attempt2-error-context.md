# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: annex-v2\settings-page.spec.ts >> two desktops join from the page, and one renames and removes the other
- Location: e2e\annex-v2\settings-page.spec.ts:39:5

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByTestId('annex-device-row').first()
Expected substring: "Studio in the network"
Received string:    "Rrunnervmhh3zgConnectedat 10.1.0.105:60973In this networkThis computer can reach it. It can reach this computer.RenameAddressRemove"
Timeout: 10000ms

Call log:
  - Expect "toContainText" getByTestId('annex-device-row').first() with timeout 10000ms
  - waiting for getByTestId('annex-device-row').first()
    24 × locator resolved to <div data-role="member" data-state="connected" data-testid="annex-device-row" class="flex items-center gap-3 min-h-[46px] py-2">…</div>
       - unexpected value "Rrunnervmhh3zgConnectedat 10.1.0.105:60973In this networkThis computer can reach it. It can reach this computer.RenameAddressRemove"

```

```yaml
- text: runnervmhh3zg Connected at 10.1.0.105:60973 In this network This computer can reach it. It can reach this computer.
- button "Rename"
- button "Address"
- button "Remove"
```

# Test source

```ts
  1   | /**
  2   |  * Settings > Annex Network (#3067): one page for the whole network.
  3   |  *
  4   |  * Two desktops turn Annex Network on from the page, pair, and each lists the
  5   |  * other as a device in its network. On one, the other is renamed and then
  6   |  * removed from the page; the other leaves the network.
  7   |  */
  8   | import { test, expect, type Page } from '@playwright/test';
  9   | import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
  10  | import { openSettings, openSettingsPage } from '../smoke-helpers';
  11  | 
  12  | let handles: DualInstanceHandles;
  13  | 
  14  | test.setTimeout(300_000);
  15  | 
  16  | test.beforeAll(async () => {
  17  |   handles = await launchDual();
  18  | });
  19  | 
  20  | test.afterAll(async () => {
  21  |   if (handles) await cleanupDual(handles);
  22  | });
  23  | 
  24  | async function openPage(w: Page): Promise<void> {
  25  |   await openSettings(w);
  26  |   await openSettingsPage(w, 'annex', 'Annex Network');
  27  |   await expect(w.getByTestId('annex-network-toggle')).toBeVisible({ timeout: 10_000 });
  28  | }
  29  | 
  30  | async function turnOn(w: Page): Promise<void> {
  31  |   await w.getByRole('switch', { name: 'Annex Network on this computer' }).click();
  32  |   await expect(w.getByText('Add a device')).toBeVisible({ timeout: 15_000 });
  33  | }
  34  | 
  35  | function status(w: Page): Promise<{ fingerprint: string; pairingUrl?: string; port: number; pin: string; tlsCertificateFingerprint: string }> {
  36  |   return w.evaluate(() => (window as any).clubhouse.annex.getStatus());
  37  | }
  38  | 
  39  | test('two desktops join from the page, and one renames and removes the other', async () => {
  40  |   const { satellite: a, controller: b } = handles;
  41  |   await openPage(a.window);
  42  |   await openPage(b.window);
  43  |   await turnOn(a.window);
  44  |   await turnOn(b.window);
  45  | 
  46  |   // A's page shows a one-time code, its pairing link and where it's reachable.
  47  |   await expect(a.window.getByTestId('annex-pairing-code')).toContainText(/\d{6}/, { timeout: 15_000 });
  48  |   await expect(a.window.getByTestId('annex-pairing-link')).toContainText('clubhousego://pair', { timeout: 15_000 });
  49  |   await expect(a.window.getByTestId('annex-certificate-code')).toBeVisible();
  50  | 
  51  |   // B pairs from manually supplied details, without a pairing link.
  52  |   const details = await status(a.window);
  53  |   await expect(a.window.getByLabel('Certificate fingerprint', { exact: true })).toHaveValue(details.tlsCertificateFingerprint);
  54  |   await b.window.getByRole('button', { name: 'Pair with another computer' }).click();
  55  |   await b.window.getByRole('button', { name: 'Pair without a link' }).click();
  56  |   await b.window.getByLabel('Address and port', { exact: true }).fill(`127.0.0.1:${details.port}`);
  57  |   await b.window.getByTestId('pairing-wizard').getByLabel('Certificate fingerprint', { exact: true }).fill(details.tlsCertificateFingerprint);
  58  |   await b.window.getByLabel('One-time code', { exact: true }).fill(details.pin);
  59  |   await b.window.getByRole('button', { name: 'Pair manually' }).click();
  60  |   await expect(b.window.getByText(/^Paired with /)).toBeVisible({ timeout: 15_000 });
  61  |   await b.window.getByRole('button', { name: 'Done', exact: true }).click();
  62  | 
  63  |   // Each page lists the other, connected, in its network.
  64  |   const rowOn = (w: Page) => w.getByTestId('annex-device-row').first();
  65  |   for (const w of [a.window, b.window]) {
  66  |     await expect(rowOn(w)).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  67  |     await expect(rowOn(w)).toHaveAttribute('data-role', 'member');
  68  |     await expect(rowOn(w)).toContainText('In this network');
  69  |   }
  70  | 
  71  |   // Changing the listener mode keeps the pairing and reconnects through loopback.
  72  |   const loopback = a.window.getByRole('switch', { name: 'Only accept connections from this computer' });
  73  |   await expect(loopback).toHaveAttribute('aria-checked', 'false');
  74  |   for (const enabled of [true, false]) {
  75  |     await loopback.click();
  76  |     await expect(loopback).toHaveAttribute('aria-checked', String(enabled));
  77  |     await expect.poll(() => a.window.evaluate(() => (window as any).clubhouse.annex.getSettings().then((s: { loopbackOnly?: boolean }) => s.loopbackOnly)))
  78  |       .toBe(enabled);
  79  |     await expect.poll(async () => !!(await status(a.window)).pairingUrl, { timeout: 15_000 }).toBe(true);
  80  |     if (enabled) {
  81  |       await expect(a.window.getByTestId('annex-reachable-hosts')).toContainText('127.0.0.1');
  82  |       expect(await a.window.evaluate(() => (window as any).clubhouse.annex.getStatus().then((s: { advertising: boolean }) => s.advertising))).toBe(false);
  83  |     }
  84  |     for (const w of [a.window, b.window]) {
  85  |       await expect(rowOn(w)).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  86  |       await expect(rowOn(w)).toHaveAttribute('data-role', 'member');
  87  |     }
  88  |   }
  89  | 
  90  |   // B renames A.
  91  |   await b.window.getByRole('button', { name: 'Rename' }).first().click();
  92  |   const name = b.window.getByTestId('annex-rename-editor').getByRole('textbox');
  93  |   await name.fill('Studio in the network');
  94  |   await b.window.getByTestId('annex-rename-editor').getByRole('button', { name: 'Save' }).click();
> 95  |   await expect(rowOn(b.window)).toContainText('Studio in the network', { timeout: 10_000 });
      |                                 ^ Error: expect(locator).toContainText(expected) failed
  96  | 
  97  |   // B removes A: gone from B's page, and A is no longer connected to B. Whether A hears
  98  |   // the removal before the connection drops is timing, so its row may stay as needing pairing.
  99  |   await b.window.getByRole('button', { name: 'Remove' }).first().click();
  100 |   await b.window.getByRole('button', { name: 'Confirm' }).first().click();
  101 |   await expect(b.window.getByTestId('annex-device-row')).toHaveCount(0, { timeout: 30_000 });
  102 |   await expect(a.window.locator('[data-testid="annex-device-row"][data-state="connected"]')).toHaveCount(0, { timeout: 30_000 });
  103 | });
  104 | 
```