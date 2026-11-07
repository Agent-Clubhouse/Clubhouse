import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installContentContextMenu } from '../preload/content-context-menu';
import { contentContext } from '../shared/content-context-target';

function context(el: Element, x = 12, y = 20) {
  const event = new MouseEvent('contextmenu', { clientX: x, clientY: y });
  Object.defineProperty(event, 'target', { value: el });
  return contentContext(event, document);
}
const hit = vi.fn();
beforeEach(() => { Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit }); });
afterEach(() => { Reflect.deleteProperty(document, 'elementFromPoint'); document.body.innerHTML = ''; document.getSelection()?.removeAllRanges(); });

describe('content menu targets', () => {
  it('copies a nested link destination, not its rendered label', () => {
    document.body.innerHTML = '<a href="https://example.com/path?q=1#part"><strong>Friendly label</strong></a>';
    expect(context(document.querySelector('strong')!)).toEqual({ link: 'https://example.com/path?q=1#part', editable: false });
  });
  it('preserves local Markdown destinations without activating them or copying inert markers', () => {
    document.body.innerHTML = '<a href="#clubhouse-local-file-123-0">file</a>';
    const a = document.querySelector('a')!;
    expect(context(a)).toBeNull();
    a.setAttribute('data-clubhouse-local-file', 'C:\\work\\notes.md');
    expect(context(a)?.link).toBe('C:\\work\\notes.md');
  });
  it('copies a file chip path without resolving the file', () => {
    document.body.innerHTML = '<button data-chat-file="text" data-chat-path="/tmp/report.md"><span>report.md</span></button>';
    expect(context(document.querySelector('span')!)?.path).toBe('/tmp/report.md');
  });
  it('offers image pixels only after load, and retains both linked-image targets', () => {
    document.body.innerHTML = '<a href="https://example.com/article"><img src="https://example.com/pic.png"></a>';
    const img = document.querySelector('img')!;
    expect(context(img)?.image).toEqual({ address: 'https://example.com/pic.png' });
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect; hit.mockReturnValue(img);
    expect(context(img)).toEqual({ link: 'https://example.com/article', image: { point: { x: 12, y: 20 }, address: 'https://example.com/pic.png' }, editable: false });
  });
  it.each(['data:image/png;base64,AA==', 'blob:https://example.com/private'])('copies rendered pixels but not ephemeral image address %s', (src) => {
    const img = document.createElement('img'); img.src = src;
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    hit.mockReturnValue(img);
    img.getBoundingClientRect = () => ({ left: 30, top: 40, right: 50, bottom: 70, width: 20, height: 30 }) as DOMRect;
    expect(context(img, 0, 0)?.image).toEqual({ point: { x: 40, y: 55 } });
  });
  it.each(['clipped', 'offscreen', 'covered', 'zero-sized'])('keeps addresses independent of %s image pixel availability', (kind) => {
    document.body.innerHTML = '<a href="https://example.com/article"><img src="https://example.com/image.png"></a>';
    const img = document.querySelector('img')!;
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    const rect = kind === 'offscreen' ? { left: -100, right: -20, top: 10, bottom: 30, width: 80, height: 20 }
      : kind === 'zero-sized' ? { left: 10, right: 10, top: 10, bottom: 10, width: 0, height: 0 }
      : { left: -50, right: 50, top: 10, bottom: 30, width: 100, height: 20 };
    img.getBoundingClientRect = () => rect as DOMRect;
    hit.mockReturnValue(kind === 'clipped' ? img : document.body);
    const result = context(img, 0, 0)!;
    expect(result.link).toBe('https://example.com/article');
    expect(result.image?.address).toBe('https://example.com/image.png');
    if (kind === 'clipped') {
      expect(result.image?.point).toEqual({ x: 25, y: 20 }); expect(hit).toHaveBeenCalledWith(25, 20);
    } else expect(result.image?.point).toBeUndefined();
  });
  it('does not copy pixels when ancestor clipping hides the candidate point', () => {
    const img = document.createElement('img'); img.src = 'data:image/png;base64,AA==';
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } });
    img.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 }) as DOMRect;
    hit.mockReturnValue(null);
    expect(context(img, 0, 0)).toBeNull();
  });
  it('preserves exact selected multiline text', () => {
    const p = document.createElement('p'); p.textContent = 'first\n second'; document.body.append(p);
    const range = document.createRange(); range.selectNodeContents(p); document.getSelection()!.addRange(range);
    expect(context(p)?.selection).toBe('first\n second');
  });
  it('distinguishes editable, readonly and password input', () => {
    const input = document.createElement('input'); input.value = 'example'; input.setSelectionRange(1, 4);
    expect(context(input)).toEqual({ editable: true, selection: 'xam' });
    input.readOnly = true; expect(context(input)?.editable).toBe(false);
    input.type = 'password'; expect(context(input)).toBeNull();
  });
  it('supports editable HTML and honors a nested noneditable region', () => {
    document.body.innerHTML = '<div contenteditable><span>edit</span><p contenteditable="false">read</p></div>';
    expect(context(document.querySelector('span')!)?.editable).toBe(true);
    expect(context(document.querySelector('p')!)).toBeNull();
    document.querySelector('div')!.setAttribute('contenteditable', 'plaintext-only');
    expect(context(document.querySelector('span')!)?.editable).toBe(true);
  });
  it('does not infer copying whole content when nothing is selected', () => {
    const p = document.createElement('p'); p.textContent = 'not selected'; expect(context(p)).toBeNull();
  });
  it('leaves existing custom menus and synthetic requests alone; removes its listener', async () => {
    let listener!: (e: MouseEvent) => void;
    const add = vi.spyOn(window, 'addEventListener').mockImplementation((_type, fn) => { listener = fn as typeof listener; });
    const remove = vi.spyOn(window, 'removeEventListener'); const show = vi.fn(async () => {});
    const dispose = installContentContextMenu(window, show);
    document.body.innerHTML = '<a href="https://example.com">link</a>';
    const target = document.querySelector('a')!;
    const preventDefault = vi.fn();
    listener({ target, isTrusted: false, defaultPrevented: false, preventDefault } as unknown as MouseEvent);
    listener({ target, isTrusted: true, defaultPrevented: true, preventDefault } as unknown as MouseEvent);
    expect(show).not.toHaveBeenCalled();
    listener({ target, isTrusted: true, defaultPrevented: false, preventDefault } as unknown as MouseEvent);
    expect(preventDefault).toHaveBeenCalledOnce(); expect(show).toHaveBeenCalledWith({ link: 'https://example.com/', editable: false });
    dispose(); expect(remove).toHaveBeenCalledWith('contextmenu', listener); add.mockRestore();
  });
});
