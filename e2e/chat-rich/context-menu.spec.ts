import { test, expect, type Locator } from '@playwright/test';
import type { Menu, PopupOptions } from 'electron';
import * as path from 'node:path';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectImageLoaded, openRichChat, TURN_TIMEOUT } from './harness';

interface MenuProbe {
  original: Menu['popup'];
  menu?: Menu;
  calls: number;
  externalAttempts: number;
  originalExternal: (url: string, options?: Electron.OpenExternalOptions) => Promise<void>;
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
  let primaryFailed = false;
  try {
    await chat.send('Show the copy fixtures.');
    await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await app.evaluate(({ Menu, shell }) => {
      const state: MenuProbe = { original: Menu.prototype.popup, calls: 0, externalAttempts: 0, originalExternal: shell.openExternal };
      (globalThis as ProbeGlobal).__copyMenuProbe = state;
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
      await app.evaluate(({ BrowserWindow }, name) => {
        const state = (globalThis as ProbeGlobal).__copyMenuProbe!;
        const item = state.menu?.items.find(i => i.label === name || i.role === name);
        if (!item || !item.enabled) throw new Error(`Missing enabled menu item: ${name}`);
        const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'));
        if (!win) throw new Error('Missing owned window');
        state.menu!.closePopup();
        // Electron's actual MenuItem callback, not a reconstructed test action.
        // This does NOT claim to automate native OS menu selection itself.
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
    expect(await menu(image)).toContain('Copy image');
    await choose('Copy image');
    await expect.poll(() => app.evaluate(async ({ clipboard }) => {
      const image = await clipboard.readImage();
      return { size: image.getSize(), pixels: image.toBitmap().toString('base64') };
    })).toEqual(expected);

    // Production CSP does not load arbitrary HTTP images. An address is
    // still copyable independently, without weakening CSP or fetching bytes.
    const address = 'https://example.invalid/clipboard-fixture.png';
    const originalSource = await image.getAttribute('src');
    await image.evaluate((el, src) => { el.style.width = '100px'; el.style.height = '100px'; el.setAttribute('src', src); }, address);
    await expect.poll(() => image.evaluate(el => el.complete && el.naturalWidth === 0)).toBe(true);
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
    expect(await menu(selected)).toContain('Copy');
    await choose('Copy'); await expect.poll(text).toBe('Selection fixture text.');
    await page.evaluate(() => document.getSelection()?.removeAllRanges());

    await dom.composer.fill('Editable copy fixture');
    await dom.composer.selectText();
    expect(await menu(dom.composer)).toContain('copy');
    await choose('copy'); await expect.poll(text).toBe('Editable copy fixture');
    await dom.composer.fill('');

    // Existing agent-row menus retain control; the fallback must not open.
    const before = await app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.calls);
    await page.getByTestId(`agent-item-${chat.agentId}`).click({ button: 'right' });
    await expect(page.getByTestId('agent-context-menu')).toBeVisible();
    expect(await app.evaluate(() => (globalThis as ProbeGlobal).__copyMenuProbe!.calls)).toBe(before);
    await page.keyboard.press('Escape');
    await chat.expectScriptComplete();
    await page.screenshot({ path: test.info().outputPath('copy-content.png') });
  } catch (error) {
    primaryFailed = true; throw error;
  } finally {
    // Clear only the disposable runner's clipboard, never a user's clipboard.
    // Keep close in finally even if observer cleanup fails.
    try {
      try {
      await app.evaluate(async ({ Menu, shell, clipboard }) => {
        const state = (globalThis as ProbeGlobal).__copyMenuProbe;
        if (state) { state.menu?.closePopup(); Menu.prototype.popup = state.original; shell.openExternal = state.originalExternal; }
        delete (globalThis as ProbeGlobal).__copyMenuProbe;
        await clipboard.clear();
      });
      } finally { await chat.close(); }
    } catch (cleanupError) { if (!primaryFailed) throw cleanupError; }
  }
});
