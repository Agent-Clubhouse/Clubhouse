/**
 * Failed writes to a Copilot CLI that is going away (#2706).
 *
 * vscode-jsonrpc 8.2.1 (Copilot SDK 1.0.28) `sendRequest` rejected the
 * caller's promise with a MessageWriteError and then rethrew the write's own
 * error from its async promise executor. Nothing held that promise, so the
 * second copy reached `process.on('unhandledRejection')`.
 *
 * vscode-jsonrpc 10.0.0 (SDK 1.0.29) only rejects the caller's promise and
 * logs, and catches failed response writes too, so `sendRequest` leaves no
 * stray copy. The marking stays as a guard: `sendNotification` still rethrows
 * the writer's error to its caller, so a notification the SDK sends without
 * catching it (it sends none today) or a later jsonrpc that rethrows again
 * would bring the stray rejection back, and these hooks would still catch it.
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

/**
 * Mark the errors a client's writers throw, from its first write on. The SDK
 * makes a new writer each time it connects (`connectToServer`, private), and
 * start() itself sends a request, so this wraps the connect step rather than
 * the writer start() leaves. Call before start().
 */
export function markFailedCopilotWritesFromStart(client: unknown): void {
  const c = client as { connectToServer?: () => Promise<void> } | null;
  if (!c || typeof c.connectToServer !== 'function') return;
  const connectToServer = c.connectToServer.bind(c);
  c.connectToServer = async () => {
    await connectToServer();
    markFailedCopilotWrites(c);
  };
}

/** Wrap a client's current message writer so the errors it throws are marked. Safe to call twice. */
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
