/**
 * Bridge from the manifest's global ⌥⌘← / ⌥⌘→ commands (registered in
 * `activate`) to the mounted Review panel.
 */
export const reviewNav: { prev: (() => void) | null; next: (() => void) | null } = { prev: null, next: null };
