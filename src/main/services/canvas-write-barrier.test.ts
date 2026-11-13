import { describe, expect, it } from 'vitest';
import { createCanvasWriteBarrier } from './canvas-write-barrier';

describe('canvas write barrier', () => {
  it('orders stale saves after deletion, and releases the barrier on failure', async () => {
    const guard = createCanvasWriteBarrier();
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deletion = guard(async () => { calls.push('delete start'); await blocked; calls.push('delete end'); throw new Error('failed'); });
    const save = guard(async () => { calls.push('save'); });
    await Promise.resolve();
    expect(calls).toEqual(['delete start']);
    release();
    await expect(deletion).rejects.toThrow('failed');
    await save;
    expect(calls).toEqual(['delete start', 'delete end', 'save']);
  });
});
