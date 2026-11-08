import { describe, expect, it } from 'vitest';
import { isFailedCopilotWrite, markFailedCopilotWrites } from './failed-writes';

describe('markFailedCopilotWrites (#2706)', () => {
  it('marks what the writer throws, and only that', async () => {
    const broken = new Error('write EPIPE');
    const client = { messageWriter: { write: async (msg: unknown) => { if (msg === 'fail') throw broken; } } };
    markFailedCopilotWrites(client);
    await expect(client.messageWriter.write('ok')).resolves.toBeUndefined();
    await expect(client.messageWriter.write('fail')).rejects.toBe(broken);
    expect(isFailedCopilotWrite(broken)).toBe(true);
    expect(isFailedCopilotWrite(new Error('write EPIPE'))).toBe(false);
    expect(isFailedCopilotWrite('write EPIPE')).toBe(false);
    expect(isFailedCopilotWrite(null)).toBe(false);
  });

  it('wraps a writer once, and leaves a client with no writer alone', async () => {
    let calls = 0;
    const client = { messageWriter: { write: async () => { calls++; } } };
    markFailedCopilotWrites(client);
    const wrapped = client.messageWriter.write;
    markFailedCopilotWrites(client);
    expect(client.messageWriter.write).toBe(wrapped);
    await client.messageWriter.write();
    expect(calls).toBe(1);
    expect(() => markFailedCopilotWrites({ messageWriter: null })).not.toThrow();
    expect(() => markFailedCopilotWrites(undefined)).not.toThrow();
  });
});
