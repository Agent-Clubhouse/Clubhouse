/** Response type for the project directory picker IPC channel. */
export type ProjectPickDirectoryResponse = string | null;

export type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Preserve the response type at the preload boundary instead of returning any. */
export function typedInvoke<T>(
  invoke: IpcInvoke,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return invoke(channel, ...args) as Promise<T>;
}
