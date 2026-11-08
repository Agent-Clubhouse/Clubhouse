import { test, expect, type Locator } from '@playwright/test';
import type { Menu, PopupOptions } from 'electron';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectImageLoaded, openRichChat, TURN_TIMEOUT } from './harness';

interface MenuProbe {
  original: Menu['popup'];
  menu?: Menu;
  calls: number;
  externalAttempts: number;
  originalExternal: (url: string, options?: Electron.OpenExternalOptions) => Promise<void>;
  originalCopyImageAt: Electron.WebContents['copyImageAt'];
  copyContents: Electron.WebContents;
  imageCopies: Array<{ x: number; y: number; zoom: number }>;
}
type ProbeGlobal = typeof globalThis & { __copyMenuProbe?: MenuProbe };

// These are real OS clipboard operations. Never run them on a developer's
// desktop or a self-hosted runner. The ordinary chat job uses fresh hosted VMs.
test('native copy menu preserves rich link, image and selection content', async () => {
  test.skip(process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted',
    'Real clipboard acceptance requires a disposable GitHub-hosted runner; skipped means uncovered.');
  const destination = 'https://example.com/context-copy?q=one#two';
  const chat = await openRichChat({
    cli: 'claude',
    projectFiles: { 'copy-image.png': { copy: CHAT_MEDIA.png } },
    script: ({ projectDir }) => ({ description: 'copy-only fixture content', turns: [{ steps: [{ type: 'text', text:
      `[Friendly destination](${destination})\n\nSelection fixture text.\n\n${md.image('copy pixels', path.join(projectDir, 'copy-image.png'))}`,
    }] }] }),
  });
  const app = chat.electronApp;
  const page = chat.window;
  const dom = chatDom(page);
  let cleanupFailed = false;
  let cleanupError: unknown;
  async function retainEvidence(name: string, value: unknown) {
    const filename = test.info().outputPath(name);
    await writeFile(filename, JSON.stringify(value), { flag: 'wx' });
    await test.info().attach(name, { contentType: 'application/json', path: filename });
  }
  try {
    await chat.send('Show the copy fixtures.');
    await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await app.evaluate(({ Menu, shell, BrowserWindow }) => {
      const copyContents = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'))!.webContents;
      const state: MenuProbe = { original: Menu.prototype.popup, calls: 0, externalAttempts: 0, originalExternal: shell.openExternal,
        originalCopyImageAt: copyContents.copyImageAt, copyContents, imageCopies: [] };
      (globalThis as ProbeGlobal).__copyMenuProbe = state;
      copyContents.copyImageAt = function (x: number, y: number) {
        state.imageCopies.push({ x, y, zoom: this.getZoomFactor() });
        return state.originalCopyImageAt.call(this, x, y);
      };
      Menu.prototype.popup = function (this: Menu, options?: PopupOptions) {
        state.menu = this; state.calls++;
        // Observe the actual production popup; do not replace routing or menu construction.
        return state.original.call(this, options);
      };
      // A copy must never request navigation. Record and refuse any accidental
      // external-open attempt rather than starting a browser on the runner.
      shell.openExternal = async () => { state.externalAttempts++; throw new Error('Copy attempted navigation'); };
    });
    const labels = () => app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe?.menu?.items.map(i => i.role || i.label || i.type) || []);
    async function menu(target: Locator, keyboard = false) {
      const before = await app.evaluate(() => {
        const state = (globalThis as ProbeGlobal).__copyMenuProbe!;
        state.menu?.closePopup(); state.menu = undefined; return state.calls;
      });
      if (keyboard) { await target.focus(); await page.keyboard.press('Shift+F10'); }
      else await target.click({ button: 'right' });
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.calls)).toBe(before + 1);
      return labels();
    }
    async function choose(labelOrRole: string) {
      await app.evaluate(async ({ BrowserWindow, clipboard }, name) => {
        const state = (globalThis as ProbeGlobal).__copyMenuProbe!;
        const item = state.menu?.items.find(i => i.label === name || i.role === name);
        if (!item || !item.enabled) throw new Error(`Missing enabled menu item: ${name}`);
        const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'));
        if (!win) throw new Error('Missing owned window');
        state.menu!.closePopup();
        // Electron's actual MenuItem callback, not a reconstructed test action.
        // This does NOT claim to automate native OS menu selection itself.
        await clipboard.clear();
        item.click({}, win, win.webContents);
      }, labelOrRole);
    }
    const text = () => app.evaluate(({ clipboard }) => clipboard.readText());
    const urlBefore = page.url();
    const link = dom.plainLink(destination);
    expect(await menu(link)).toContain('Copy link address');
    await choose('Copy link address'); await expect.poll(text).toBe(destination);
    expect(page.url()).toBe(urlBefore);
    expect(await app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.externalAttempts)).toBe(0);

    // A trusted keyboard context event uses the focused link target too.
    expect(await menu(link, true)).toContain('Copy link address');
    await choose('Copy link address'); await expect.poll(text).toBe(destination);

    const image = dom.markdownImage('copy pixels').locator('img');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'))!.webContents.setZoomFactor(1.25); });
    await image.scrollIntoViewIfNeeded();
    await expectImageLoaded(image);
    const expected = await app.evaluate(({ nativeImage }, filename) => {
      const image = nativeImage.createFromPath(filename);
      return { size: image.getSize(), pixels: image.toBitmap().toString('base64') };
    }, path.join(chat.projectDir, 'copy-image.png'));
    await retainEvidence('image-target.json', await image.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { rect: rect.toJSON(), devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
    }));
    expect(await menu(image)).toContain('Copy image');
    await choose('Copy image');
    await expect.poll(() => app.evaluate(async ({ clipboard, nativeImage }) => {
      const items = await clipboard.read();
      const formats = items.map(item => item.types);
      const type = ['image/png', 'image/jpeg'].find(mime => items.some(item => item.types.includes(mime)));
      if (!type) return { formats, image: null };
      const blob = await items.find(item => item.types.includes(type))!.getType(type);
      if (!('arrayBuffer' in blob)) throw new Error('Expected clipboard image bytes');
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      return { formats, image: { size: image.getSize(), pixels: image.toBitmap().toString('base64') } };
    })).toEqual(expect.objectContaining({ image: expected }));

    // Production CSP does not load arbitrary HTTP images. An address is
    // still copyable independently, without weakening CSP or fetching bytes.
    const address = 'https://example.invalid/clipboard-fixture.png';
    const originalSource = await image.getAttribute('src');
    await image.evaluate((el, src) => { el.style.width = '100px'; el.style.height = '100px'; el.setAttribute('src', src); }, address);
    await expect.poll(() => image.evaluate(el => { if (!(el instanceof HTMLImageElement)) throw new Error('Expected image fixture'); return el.complete && el.naturalWidth === 0; })).toBe(true);
    const unavailable = await menu(image);
    expect(unavailable).toContain('Copy image address'); expect(unavailable).not.toContain('Copy image');
    await choose('Copy image address'); await expect.poll(text).toBe(address);
    await image.evaluate((el, src) => { el.setAttribute('src', src!); el.style.width = ''; el.style.height = ''; }, originalSource);
    await expectImageLoaded(image);

    // A clipped keyboard fixture retains its enclosing link independently.
    // Reparent only this fixture image, then restore it before further UI work.
    await image.evaluate((el, href) => {
      const link = document.createElement('a'); link.href = href; el.replaceWith(link); link.append(el);
      el.tabIndex = 0; el.style.clipPath = 'inset(0 0 75% 0)';
    }, destination);
    const clipped = await menu(image, true);
    expect(clipped).toContain('Copy link address'); expect(clipped).not.toContain('Copy image');
    await choose('Copy link address'); await expect.poll(text).toBe(destination);
    await image.evaluate(el => { const wrapper = el.parentElement!; wrapper.replaceWith(el); el.style.clipPath = ''; el.removeAttribute('tabindex'); });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'))!.webContents.setZoomFactor(1); });

    const selected = page.getByText('Selection fixture text.', { exact: true });
    await selected.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(range); });
    // A read-only selection uses the native copy role, so its text never crosses IPC.
    expect(await menu(selected)).toContain('copy');
    await choose('copy'); await expect.poll(text).toBe('Selection fixture text.');
    await page.evaluate(() => document.getSelection()?.removeAllRanges());

    const composerInput = dom.composer.getByRole('textbox', { name: 'Message', exact: true });
    await composerInput.fill('Editable copy fixture');
    await composerInput.selectText();
    expect(await menu(composerInput)).toContain('copy');
    await choose('copy'); await expect.poll(text).toBe('Editable copy fixture');
    await composerInput.fill('');

    // Existing agent-row menus retain control; the fallback must not open.
    const before = await app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.calls);
    await page.getByTestId(`agent-item-${chat.agentId}`).click({ button: 'right' });
    await expect(page.getByTestId('agent-context-menu')).toBeVisible();
    // The fallback would arrive over async IPC, so give it time to show up before asserting it did not.
    await page.waitForTimeout(500);
    expect(await app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.calls)).toBe(before);
    await page.keyboard.press('Escape');
    expect(page.url()).toBe(urlBefore);
    expect(await app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.externalAttempts)).toBe(0);
    await chat.expectScriptComplete();
    await page.screenshot({ path: test.info().outputPath('copy-content.png') });
  } finally {
    // Preserve actual native coordinates/zoom and returned format names on failure too.
    try {
      const evidence = await app.evaluate(async ({ clipboard }) => ({
        imageCopies: (globalThis as ProbeGlobal).__copyMenuProbe?.imageCopies,
        formats: (await clipboard.read()).map(item => item.types),
      }));
      await retainEvidence('native-copy-evidence.json', evidence);
    } catch (error) { cleanupFailed = true; cleanupError = error; }
    // Clear only the disposable runner's clipboard, never a user's clipboard.
    // Keep close in finally even if observer cleanup fails.
    try {
      try {
      await app.evaluate(async ({ Menu, shell, clipboard }) => {
        const state = (globalThis as ProbeGlobal).__copyMenuProbe;
        if (state) { state.menu?.closePopup(); Menu.prototype.popup = state.original; shell.openExternal = state.originalExternal;
          if (!state.copyContents.isDestroyed()) state.copyContents.copyImageAt = state.originalCopyImageAt; }
        delete (globalThis as ProbeGlobal).__copyMenuProbe;
        await clipboard.clear();
      });
      } finally { await chat.close(); }
    } catch (error) { cleanupFailed = true; cleanupError = error; }
  }
  // A body failure propagates through finally unchanged. Only a successful
  // body reaches this point, where a cleanup failure must still fail the test.
  if (cleanupFailed) throw cleanupError;
});
