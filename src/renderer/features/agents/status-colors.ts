/**
 * Shared status ring colors for agent avatars.
 * Uses CSS custom properties for theme compatibility.
 */
export const STATUS_RING_COLORS: Record<string, string> = {
  running: 'rgb(var(--ctp-success))',
  sleeping: 'rgb(var(--ctp-surface2))',
  waking: 'rgb(var(--ctp-warning))',
  creating: 'rgb(var(--ctp-accent))',
  error: 'rgb(var(--ctp-error))',
};
