import type { ServerResponse } from 'http';
import { currentTraceparent } from './facade';

/** Includes callback-based body handlers and response flush/close in the request lifetime. */
export async function traceHttpResponse(res: ServerResponse, handler: () => Promise<void>): Promise<void> {
  const tc = currentTraceparent();
  if (tc && !res.headersSent) res.setHeader('traceparent', tc);
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  res.once('finish', done);
  res.once('close', done);
  try {
    await handler();
    if (!res.writableFinished && !res.destroyed) await finished;
  } finally {
    res.removeListener('finish', done);
    res.removeListener('close', done);
  }
}
