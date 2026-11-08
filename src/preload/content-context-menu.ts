import type { ContentContextMenu } from '../shared/content-context-menu';
import { contentContext } from '../shared/content-context-target';

/** Window bubbling runs after React/Monaco handlers have had a chance to claim it. */
export function installContentContextMenu(win: Window, show: (context: ContentContextMenu) => Promise<unknown>): () => void {
  const listener = (event: MouseEvent) => {
    if (!event.isTrusted || event.defaultPrevented) return;
    const context = contentContext(event, win.document);
    if (!context) return;
    event.preventDefault();
    // No content/paths in diagnostics. Main reports clipboard failures to the user.
    void show(context).catch(() => { console.warn('Content context menu unavailable'); });
  };
  win.addEventListener('contextmenu', listener);
  return () => win.removeEventListener('contextmenu', listener);
}
