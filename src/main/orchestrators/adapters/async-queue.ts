/**
 * Minimal async queue bridging push-based callbacks to an AsyncIterable.
 * Pure Node.js, no Electron dependencies.
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  fail(err: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = err;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      // Signal done so the for-await loop exits, then throw on next iteration
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.error) {
          return Promise.reject(this.error);
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
