/**
 * The new chrome layout (docs/chrome-redesign-spec.md §4.1) is chosen once per
 * session. Main reads the experimental flag when it creates the main window and
 * passes it as a launch argument, so the renderer can pick its shell
 * synchronously before the first render, with no IPC round trip.
 */
export const NEW_CHROME_FLAG = 'newChrome';
export const NEW_CHROME_ARG = '--clubhouse-new-chrome';
