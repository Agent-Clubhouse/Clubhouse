/**
 * The message of an error thrown across IPC, without the
 * "Error invoking remote method '<channel>': Error: " prefix Electron adds.
 */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
