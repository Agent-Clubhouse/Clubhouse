/**
 * Title-bar room for the platform's window controls (spec §4.7): the traffic
 * lights on macOS, the overlay on Windows and, in the new layout, Linux.
 */
export function titleBarPadding(platform: string): string {
  if (platform === 'darwin') return 'pl-[78px]';
  if (platform === 'win32' || platform === 'linux') return 'pl-2 win-overlay-padding';
  return 'pl-2';
}
