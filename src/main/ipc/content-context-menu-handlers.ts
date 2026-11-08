import { BrowserWindow, clipboard, dialog, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { isContentContextMenu, type ContentContextMenu } from '../../shared/content-context-menu';

export function contentMenuItems(context: ContentContextMenu, contents: Electron.WebContents): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const failed = () => dialog.showErrorBox('Copy failed', 'The content could not be written to the clipboard. Please try again.');
  const write = (text: string) => {
    void clipboard.writeText(text).catch(failed);
  };
  if (context.link) items.push({ label: 'Copy link address', click: () => write(context.link!) });
  if (context.path) items.push({ label: 'Copy file path', click: () => write(context.path!) });
  if (context.image) {
    const image = context.image;
    const point = image.point;
    if (point) items.push({ label: 'Copy image', click: () => {
      if (contents.isDestroyed()) return;
      try {
        // DOM hit tests use CSS client coordinates; CopyImageAt takes DIPs.
        // Chromium converts DIPs to Blink space itself: do not apply device scale.
        const zoom = contents.getZoomFactor();
        if (!Number.isFinite(zoom) || zoom <= 0) { failed(); return; }
        contents.copyImageAt(Math.round(point.x * zoom), Math.round(point.y * zoom));
      } catch { failed(); }
    } });
    if (image.address) items.push({ label: 'Copy image address', click: () => write(image.address!) });
  }
  if (items.length && (context.selection || context.editable)) items.push({ type: 'separator' });
  if (context.editable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  } else if (context.selection) {
    items.push({ role: 'copy' });
  }
  return items;
}

export function registerContentContextMenu(): void {
  ipcMain.handle(IPC.APP.CONTENT_CONTEXT_MENU, (event, context: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Content menu requires an app window');
    if (!isContentContextMenu(context)) throw new Error('Invalid content menu');
    const items = contentMenuItems(context, event.sender);
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
}
