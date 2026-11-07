import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ handle: vi.fn(), owner: vi.fn(), write: vi.fn(async () => {}), error: vi.fn(), build: vi.fn(), popup: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: mock.owner }, clipboard: { writeText: mock.write }, dialog: { showErrorBox: mock.error }, ipcMain: { handle: mock.handle }, Menu: { buildFromTemplate: mock.build } }));
import { contentMenuItems, registerContentContextMenu } from './content-context-menu-handlers';
import { isContentContextMenu } from '../../shared/content-context-menu';
import { IPC } from '../../shared/ipc-channels';
const frame = {};
const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false), copyImageAt: vi.fn() };
const wc = contents as unknown as Electron.WebContents;
function click(item: Electron.MenuItemConstructorOptions) { item.click?.({} as Electron.MenuItem, {} as Electron.BaseWindow, {} as Electron.KeyboardEvent); }
beforeEach(() => { mock.owner.mockReturnValue({}); mock.build.mockReturnValue({ popup: mock.popup }); contents.isDestroyed.mockReturnValue(false); });
describe('native copy content menu', () => {
  it('copies the requested address and selected text separately without opening anything', async () => {
    const items = contentMenuItems({ link: 'https://example.com/real', selection: 'visible\ntext', editable: false }, wc);
    expect(items.map(i => i.label || i.type)).toEqual(['Copy link address', 'separator', 'Copy']);
    click(items[0]); click(items[2]);
    expect(mock.write.mock.calls).toEqual([['https://example.com/real'], ['visible\ntext']]);
  });
  it('copies image pixels in the requesting web contents, not the image URL or a new fetch', () => {
    const items = contentMenuItems({ editable: false, image: { point: { x: 10, y: 23 }, address: 'https://example.com/a.png' } }, wc);
    click(items[0]); expect(contents.copyImageAt).toHaveBeenCalledWith(10, 23); expect(mock.write).not.toHaveBeenCalled();
    click(items[1]); expect(mock.write).toHaveBeenCalledWith('https://example.com/a.png');
    contents.isDestroyed.mockReturnValue(true); click(items[0]); expect(contents.copyImageAt).toHaveBeenCalledOnce();
  });
  it('keeps image addresses available without a verified pixel target', () => {
    const items = contentMenuItems({ editable: false, image: { address: 'https://example.com/a.png' } }, wc);
    expect(items.map(i => i.label)).toEqual(['Copy image address']);
    click(items[0]); expect(mock.write).toHaveBeenCalledWith('https://example.com/a.png');
    expect(contents.copyImageAt).not.toHaveBeenCalled();
  });
  it('uses native editing roles, and copy-only for readonly selection', () => {
    expect(contentMenuItems({ editable: true }, wc).map(i => i.role || i.type)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll']);
    expect(contentMenuItems({ editable: false, selection: 'read only' }, wc).map(i => i.label)).toEqual(['Copy']);
  });
  it('reports asynchronous clipboard failure without content in the error', async () => {
    mock.write.mockRejectedValueOnce(new Error('private clipboard contents'));
    click(contentMenuItems({ editable: false, path: '/private/file' }, wc)[0]);
    await vi.waitFor(() => expect(mock.error).toHaveBeenCalledOnce());
    expect(JSON.stringify(mock.error.mock.calls)).not.toContain('/private/file');
  });
  it('validates payloads without accepting nonfinite coordinates or malformed strings', () => {
    expect(isContentContextMenu({ editable: false, image: { point: { x: NaN, y: 0 } } })).toBe(false);
    expect(isContentContextMenu({ editable: false, image: { point: { x: -1, y: 0 } } })).toBe(false);
    expect(isContentContextMenu({ editable: false, link: {} })).toBe(false);
    expect(isContentContextMenu({ editable: false, selection: 'x'.repeat(1_000_001) })).toBe(false);
    expect(isContentContextMenu({ editable: false, link: 'file:///tmp/a' })).toBe(true);
  });
  it('registers only an app top-frame menu and never exposes navigation/file operations', () => {
    registerContentContextMenu(); expect(mock.handle.mock.calls[0][0]).toBe(IPC.APP.CONTENT_CONTEXT_MENU);
    const handler = mock.handle.mock.calls[0][1]; const event = { sender: wc, senderFrame: frame };
    handler(event, { editable: false, link: 'file:///tmp/a' }); expect(mock.popup).toHaveBeenCalledOnce();
    expect(() => handler({ ...event, senderFrame: {} }, { editable: true })).toThrow('app window');
    mock.owner.mockReturnValue(null); expect(() => handler(event, { editable: true })).toThrow('app window');
    mock.owner.mockReturnValue({}); expect(() => handler(event, { editable: true, image: { point: { x: Infinity, y: 0 } } })).toThrow('Invalid');
    expect(mock.popup).toHaveBeenCalledOnce();
  });
});
