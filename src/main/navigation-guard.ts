/**
 * Returns true if the URL is an app-internal navigation target.
 * Allows file:// protocol and localhost dev server; blocks everything else.
 */
export function isAllowedNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]') return true;
    return false;
  } catch {
    return false;
  }
}
