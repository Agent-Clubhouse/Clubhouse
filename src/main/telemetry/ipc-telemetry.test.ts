import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipc-channels';
import { ATTR, getAttributeSpec } from '../../shared/telemetry/attributes';
import { setRuntime } from './facade';
import { _resetIpcTelemetryForTests, installIpcTelemetry } from './ipc-telemetry';
import type { TelemetryLevel } from '../../shared/telemetry/attributes';
import type { TelemetryRuntime } from './types';

afterEach(() => {
  setRuntime(null);
  _resetIpcTelemetryForTests();
});

function runtime(level: TelemetryLevel) {
  const replaySpan = vi.fn();
  const exception = vi.fn();
  setRuntime({ level, replaySpan, exception } as unknown as TelemetryRuntime);
  return { replaySpan, exception };
}

function install() {
  const registered = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const ipc = { handle: (ch: string, l: (e: unknown, ...a: unknown[]) => unknown) => { registered.set(ch, l); } };
  installIpcTelemetry(ipc as never);
  return { ipc, registered };
}

describe('IPC telemetry', () => {
  it('times invokes at Detailed only, by channel, and passes results through', async () => {
    const { ipc, registered } = install();
    ipc.handle(IPC.PROJECT.LIST, async (_e, x) => `ok:${x}`);
    const handler = registered.get(IPC.PROJECT.LIST)!;

    const standard = runtime('standard');
    expect(await handler({}, 1)).toBe('ok:1');
    expect(standard.replaySpan).not.toHaveBeenCalled();

    const detailed = runtime('detailed');
    expect(await handler({}, 2)).toBe('ok:2');
    await Promise.resolve();
    expect(detailed.replaySpan).toHaveBeenCalledWith(expect.objectContaining({
      name: 'clubhouse.ipc.invoke', attrs: [ATTR.ipcChannel(IPC.PROJECT.LIST)], outcome: 'ok',
    }));
  });

  it('records rejections and sync throws as errors without an exception record, rethrowing the same error', async () => {
    const { ipc, registered } = install();
    const rejected = new Error('no such project');
    const thrown = new TypeError('bad arg');
    ipc.handle(IPC.PROJECT.ADD, async () => { throw rejected; });
    ipc.handle(IPC.PROJECT.REMOVE, () => { throw thrown; });
    const { replaySpan, exception } = runtime('detailed');

    await expect(registered.get(IPC.PROJECT.ADD)!({})).rejects.toBe(rejected);
    expect(() => registered.get(IPC.PROJECT.REMOVE)!({})).toThrow(thrown);
    await Promise.resolve();
    expect(replaySpan.mock.calls.map((c) => [c[0].attrs[0], c[0].outcome, c[0].errorType])).toEqual([
      [ATTR.ipcChannel(IPC.PROJECT.ADD), 'error', 'unknown'],
      [ATTR.ipcChannel(IPC.PROJECT.REMOVE), 'error', 'unknown'],
    ]);
    expect(exception).not.toHaveBeenCalled();
  });

  it('registers every IPC constant as a channel value; unknown channels become other', () => {
    const values = getAttributeSpec('clubhouse.ipc.channel')?.values ?? [];
    expect(values).toContain(IPC.PROJECT.LIST);
    expect(values).toContain(IPC.PTY.WRITE);
    expect(ATTR.ipcChannel('plugin:made-up' as never).value).toBe('other');
  });
});
