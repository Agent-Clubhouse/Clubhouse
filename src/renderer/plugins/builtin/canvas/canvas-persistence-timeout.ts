/** Storage IPC may never settle. A source switch must still remain usable. */
export const CANVAS_PERSISTENCE_TIMEOUT_MS = 5_000;

export async function withCanvasPersistenceTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Canvas storage did not respond')), CANVAS_PERSISTENCE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
