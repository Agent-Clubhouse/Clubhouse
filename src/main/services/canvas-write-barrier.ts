/** Serializes canvas writes with a destructive group-project cascade. */
export function createCanvasWriteBarrier() {
  let tail: Promise<void> = Promise.resolve();
  return async function withCanvasWriteBarrier<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export const withCanvasWriteBarrier = createCanvasWriteBarrier();
