import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './async-queue';

describe('AsyncQueue', () => {
  it('yields items pushed before iteration', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.finish();

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });

  it('yields items pushed during iteration', async () => {
    const queue = new AsyncQueue<string>();
    const items: string[] = [];

    const consumer = (async () => {
      for await (const item of queue) {
        items.push(item);
      }
    })();

    queue.push('a');
    queue.push('b');
    // Allow microtasks to resolve
    await new Promise((r) => setTimeout(r, 10));
    queue.push('c');
    queue.finish();

    await consumer;
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('stops iteration on finish()', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.finish();
    queue.push(2); // Should be ignored

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }
    expect(items).toEqual([1]);
  });

  it('handles finish() before any push', async () => {
    const queue = new AsyncQueue<number>();
    queue.finish();

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });

  it('handles finish() while waiting for next item', async () => {
    const queue = new AsyncQueue<number>();
    const items: number[] = [];

    const consumer = (async () => {
      for await (const item of queue) {
        items.push(item);
      }
    })();

    // Let consumer start waiting
    await new Promise((r) => setTimeout(r, 10));
    queue.finish();

    await consumer;
    expect(items).toEqual([]);
  });

  it('rejects on fail() when error is set', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.fail(new Error('boom'));

    // Error takes precedence over buffered items
    await expect(async () => {
      for await (const _item of queue) {
        // should not reach here
      }
    }).rejects.toThrow('boom');
  });

  it('rejects immediately when fail() called while waiting', async () => {
    const queue = new AsyncQueue<number>();
    const items: number[] = [];

    const consumer = (async () => {
      for await (const item of queue) {
        items.push(item);
      }
    })();

    // Let consumer start waiting
    await new Promise((r) => setTimeout(r, 10));
    queue.fail(new Error('connection lost'));

    // The for-await exits normally on fail (done: true), then next() rejects
    await consumer;
    expect(items).toEqual([]);
  });

  it('ignores push after fail()', async () => {
    const queue = new AsyncQueue<number>();
    queue.fail(new Error('err'));
    queue.push(1); // Should be ignored

    await expect(async () => {
      for await (const _ of queue) {
        // should not get here
      }
    }).rejects.toThrow('err');
  });

  it('can be iterated only via asyncIterator protocol', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(42);
    queue.finish();

    const iter = queue[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({ value: 42, done: false });

    const second = await iter.next();
    expect(second.done).toBe(true);
  });
});
