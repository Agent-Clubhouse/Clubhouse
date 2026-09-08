import { IPC } from './ipc-channels';

export type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** The response contract is keyed by channel so both IPC endpoints derive from it. */
export interface IpcResponseMap {
  [IPC.PROJECT.PICK_DIR]: string | null;
}

export type IpcResponse<Channel extends keyof IpcResponseMap> = IpcResponseMap[Channel];

export function typedInvoke<Channel extends keyof IpcResponseMap>(
  invoke: IpcInvoke,
  channel: Channel,
  ...args: unknown[]
): Promise<IpcResponse<Channel>> {
  return invoke(channel, ...args) as Promise<IpcResponse<Channel>>;
}
