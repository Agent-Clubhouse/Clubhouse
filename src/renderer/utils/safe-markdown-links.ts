import { openLocalFileLink } from './file-preview';
import React, { useCallback } from 'react';

/**
 * Click handler that intercepts anchor clicks in rendered markdown HTML.
 * - External URLs (http/https/mailto) are opened via shell.openExternal
 * - Absolute local file links open a read-only in-app preview.
 * - Other links (relative, anchor, etc.) are suppressed to prevent
 *   Electron renderer navigation which causes blank screen crashes.
 */
export function useSafeMarkdownLinks(allowLocalFiles = true): React.MouseEventHandler<HTMLDivElement> {
  return useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;

    e.preventDefault();

    const href = target.getAttribute('href');
    if (!href) return;

    if (allowLocalFiles && openLocalFileLink(href)) return;

    if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) {
      window.clubhouse.app.openExternalUrl(href);
    }
    // Internal/relative links are silently ignored to prevent navigation
  }, [allowLocalFiles]);
}
