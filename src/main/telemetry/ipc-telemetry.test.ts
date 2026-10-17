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
  const flow = vi.fn((_n: string, _o: unknown, fn: () => unknown) => fn());
  setRuntime({ level, flow } as unknown as TelemetryRuntime);
  return flow;
}

describe('IPC telemetry', () => {
  it('times invokes at Detailed only, by channel, and passes results through', async () => {
    const registered = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ipc = { handle: (ch: string, l: (e: unknown, ...a: unknown[]) => unknown) => { registered.set(ch, l); } };
    installIpcTelemetry(ipc as never);
    ipc.handle(IPC.PROJECT.LIST, async (_e, x) => `ok:${x}`);
    const handler = registered.get(IPC.PROJECT.LIST)!;

    const standard = runtime('standard');
    expect(await handler({}, 1)).toBe('ok:1');
    expect(standard).not.toHaveBeenCalled();

    const detailed = runtime('detailed');
    expect(await handler({}, 2)).toBe('ok:2');
    expect(detailed).toHaveBeenCalledWith('clubhouse.ipc.invoke', { attrs: [ATTR.ipcChannel(IPC.PROJECT.LIST)] }, expect.any(Function), undefined);
  });

  it('registers every IPC constant as a channel value; unknown channels become other', () => {
    const values = getAttributeSpec('clubhouse.ipc.channel')?.values ?? [];
    expect(values).toContain(IPC.PROJECT.LIST);
    expect(values).toContain(IPC.PTY.WRITE);
    expect(ATTR.ipcChannel('plugin:made-up' as never).value).toBe('other');
  });
});
