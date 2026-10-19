/**
 * PTY input helpers: chunked bracketed paste and paste-then-submit with
 * provider-specific timing. Used by the PTY agent runtime; previously lived
 * in clubhouse-mcp/tools/agent-tools.ts (still re-exported there).
 */

import * as ptyManager from '../pty-manager';
import type { PasteSubmitTiming } from '../../orchestrators';
import { AgentStoppingError } from './agent-stopping';

/** Sleep helper for async delays. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write multi-line content to a PTY using chunked bracketed paste.
 *
 * Sends the bracketed paste start marker, then the body (optionally in
 * chunks with delays between them), then the end marker.
 *
 * Small delays are ALWAYS inserted after the start marker and before the
 * end marker to prevent race conditions where the CLI hasn't entered or
 * exited paste mode before content/markers arrive.  This applies to all
 * providers, not just slow CLIs.
 *
 * When chunkSize is set and the body exceeds it, the body is split into
 * chunks with `chunkDelayMs` between each write.
 *
 * A dedicated `postEndMarkerDelayMs` is inserted AFTER the end marker to
 * give the CLI time to exit paste mode before any subsequent writes (like
 * an Enter keystroke).  Without this, `\r` can be folded into the paste.
 */
export async function writeChunkedBracketedPaste(
  agentId: string,
  body: string,
  chunkSize?: number,
  chunkDelayMs = 30,
  postEndMarkerDelayMs = 150,
): Promise<void> {
  ptyManager.write(agentId, '\x1b[200~');

  // Always delay after start marker so the CLI can enter paste mode
  await sleep(chunkDelayMs);

  if (!chunkSize || body.length <= chunkSize) {
    ptyManager.write(agentId, body);
  } else {
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      if (offset > 0) await sleep(chunkDelayMs);
      ptyManager.write(agentId, body.slice(offset, offset + chunkSize));
    }
  }

  // Always delay before end marker so the last write is fully processed
  await sleep(chunkDelayMs);

  ptyManager.write(agentId, '\x1b[201~');

  // Delay AFTER end marker so the CLI can exit paste mode before \r arrives
  await sleep(postEndMarkerDelayMs);
}

/**
 * Wait until the agent's PTY buffer length is unchanged for `quiescenceMs`,
 * or until `maxWaitMs` elapses (whichever comes first).
 *
 * Used to detect when a TUI like GitHub Copilot CLI has finished rendering
 * its paste-preview UI before sending the submit Enter.  GHCP's preview
 * render time varies with network latency; a fixed sleep races against it,
 * causing the `\r` to be folded into the bracketed paste and swallowed.
 *
 * Returns `quiet: true` if the buffer settled, `quiet: false` if maxWait
 * fired first.  Either way the caller should proceed — quiet:false just
 * means we gave up waiting and will fall back to the existing retry logic.
 */
export async function waitForBufferQuiescence(
  agentId: string,
  options: { quiescenceMs: number; maxWaitMs: number; pollMs?: number },
): Promise<{ quiet: boolean; waitedMs: number }> {
  const pollMs = options.pollMs ?? 50;
  const startTs = Date.now();
  let lastLen = ptyManager.getBuffer(agentId)?.length ?? 0;
  let lastChangeTs = startTs;

  while (Date.now() - startTs < options.maxWaitMs) {
    await sleep(pollMs);
    const cur = ptyManager.getBuffer(agentId)?.length ?? 0;
    if (cur !== lastLen) {
      lastLen = cur;
      lastChangeTs = Date.now();
    } else if (Date.now() - lastChangeTs >= options.quiescenceMs) {
      return { quiet: true, waitedMs: Date.now() - startTs };
    }
  }
  return { quiet: false, waitedMs: Date.now() - startTs };
}

/**
 * Submit content that was just pasted into an agent's PTY.
 *
 * Sends `\r` (Enter) with provider-specific delays and buffer health checks.
 * If the first Enter doesn't trigger processing (buffer doesn't grow), a
 * second Enter is sent as a retry — some CLIs show a paste preview that
 * requires Enter to accept before another Enter actually submits.
 *
 * When `timing.quiescenceMs` is set, the fixed `initialDelayMs` and
 * `retryDelayMs` sleeps are replaced with quiescence waits capped at those
 * values.  This addresses GitHub Copilot CLI's variable paste-preview
 * render time — a fixed 1200ms delay races against network jitter and
 * causes the `\r` to be folded into the paste payload (then ignored).
 */
export async function submitAfterPaste(
  agentId: string,
  timing: PasteSubmitTiming,
): Promise<void> {
  const bufferBefore = ptyManager.getBuffer(agentId)?.length ?? 0;

  if (timing.quiescenceMs) {
    await waitForBufferQuiescence(agentId, {
      quiescenceMs: timing.quiescenceMs,
      maxWaitMs: timing.initialDelayMs,
      pollMs: timing.quiescencePollMs,
    });
  } else {
    await sleep(timing.initialDelayMs);
  }
  ptyManager.write(agentId, '\r');

  if (timing.quiescenceMs) {
    await waitForBufferQuiescence(agentId, {
      quiescenceMs: timing.quiescenceMs,
      maxWaitMs: timing.retryDelayMs,
      pollMs: timing.quiescencePollMs,
    });
  } else {
    await sleep(timing.retryDelayMs);
  }
  const bufferAfterFirst = ptyManager.getBuffer(agentId)?.length ?? 0;
  if (bufferAfterFirst > bufferBefore) return; // First Enter worked

  // Second Enter — submit the message
  ptyManager.write(agentId, '\r');
  await sleep(timing.finalCheckDelayMs);
}


/**
 * Type one line and press Enter after a fixed delay. Kept byte-for-byte for
 * the call sites that always used it (MCP send_file notifications).
 */
export async function writeLineThenEnter(agentId: string, line: string, delayMs: number): Promise<void> {
  if (ptyManager.isStopping(agentId)) throw new AgentStoppingError(agentId);
  ptyManager.write(agentId, line);
  await sleep(delayMs);
  ptyManager.write(agentId, '\r');
}

/**
 * Group-project inject delivery as it has always worked: a single line is
 * typed with an immediate Enter; multi-line text is pasted and submitted.
 */
export async function injectPtyText(agentId: string, text: string, timing: PasteSubmitTiming): Promise<void> {
  if (ptyManager.isStopping(agentId)) throw new AgentStoppingError(agentId);
  if (text.includes('\n')) {
    await writeChunkedBracketedPaste(agentId, text, timing.chunkSize, timing.chunkDelayMs);
    await submitAfterPaste(agentId, timing);
  } else {
    ptyManager.write(agentId, text);
    ptyManager.write(agentId, '\r');
  }
}
