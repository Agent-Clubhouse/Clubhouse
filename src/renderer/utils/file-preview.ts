import { useFilePreviewStore } from '../stores/filePreviewStore';
import { wholeFilePath } from '../features/agents/chat/rich/file-paths';

/** Electron wraps main-process errors; recognize only the existing scope denial. */
export function isFileScopeDenied(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Access denied: path ".*" is outside allowed project directories$/.test(message)
    || message === 'Path traversal is not allowed';
}

/** Resolve a UI path on the desktop's host, without treating drive paths as relative. */
export function absoluteViewPath(root: string, file: string): string {
  return /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|file:\/\/)/i.test(file) ? file : `${root}/${file}`;
}

/** Local absolute Markdown links are explicit view requests, never renderer navigation. */
export function openLocalFileLink(href: string): boolean {
  if (!/^(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|file:\/\/)/i.test(href)) return false;
  const location = wholeFilePath(href);
  useFilePreviewStore.getState().open(location?.path ?? href, location?.line, location?.col);
  return true;
}
