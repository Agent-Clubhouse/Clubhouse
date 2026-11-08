/**
 * Failed writes to a Copilot CLI that is going away (#2706).
 *
 * vscode-jsonrpc 8.2.1 `sendRequest` writes from an async promise executor.
 * When the write fails it rejects the caller's promise with a
 * MessageWriteError, which the caller handles, and then rethrows the write's
 * own error from the executor. Nothing holds the executor's promise, so that
 * second copy reaches `process.on('unhandledRejection')`. The SDK only quiets
 * these once it has seen the connection close, and a write can fail first.
 *
 * The driver marks each error its writer throws, and main's rejection handler
 * logs a marked one as a warning instead of reporting a main process error.
 * Kept free of imports so `src/main/index.ts` can load it without the SDK.
 */

const failedWrites = new WeakSet<object>();
const MARKED = Symbol('clubhouse.copilotWritesMarked');

interface MessageWriterLike {
  write(msg: unknown): Promise<void>;
}

/** Wrap a client's message writer so the errors it throws are marked. Safe to call twice. */
export function markFailedCopilotWrites(client: unknown): void {
  const writer = (client as { messageWriter?: MessageWriterLike | null } | null)?.messageWriter;
  if (!writer || typeof writer.write !== 'function' || (writer as { [MARKED]?: true })[MARKED]) return;
  const write = writer.write.bind(writer);
  writer.write = async (msg: unknown) => {
    try {
      await write(msg);
    } catch (error) {
      if (error !== null && typeof error === 'object') failedWrites.add(error);
      throw error;
    }
  };
  (writer as { [MARKED]?: true })[MARKED] = true;
}

/** True for an error a Copilot client's writer threw: its caller already got a MessageWriteError. */
export function isFailedCopilotWrite(reason: unknown): boolean {
  return reason !== null && typeof reason === 'object' && failedWrites.has(reason);
}
