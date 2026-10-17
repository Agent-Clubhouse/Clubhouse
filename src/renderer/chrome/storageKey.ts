/**
 * The new chrome's localStorage key (docs/chrome-redesign-spec.md §5). Kept in
 * its own module so light stores (keyboard shortcuts) can share it without
 * importing chromeStore.
 */
export const CHROME_STORAGE_KEY = 'clubhouse_chrome_v2';
