/**
 * AgentRuntime over a PTY. Wraps the terminal-specific input path (chunked
 * bracketed paste, provider-timed submit, slash commands, Ctrl-C) that was
 * previously duplicated across MCP tools, shoulder taps, group projects and
 * Annex.
 */

import * as ptyManager from '../pty-manager';
import { getProvider, isSessionCapable } from '../../orchestrators';
import type { PasteSubmitTiming } from '../../orchestrators';
import { agentRegistry } from '../agent-registry';
import * as permissionQueue from '../annex-permission-queue';
import { onAgentExit } from '../agent-exit-broadcast';
import type {
  AgentRuntime,
  ContentBlock,
  RuntimeSendOptions,
  RuntimeSendResult,
  RuntimeTranscriptSlice,
  RuntimeExitInfo,
  ChatSessionState,
} from '../../../shared/chat';
import { writeChunkedBracketedPaste, submitAfterPaste, sleep } from './pty-input';

/** Fallback when the provider is unknown (matches the MCP send_message defaults). */
export const DEFAULT_PASTE_TIMING: PasteSubmitTiming = {
  initialDelayMs: 500,
  retryDelayMs: 300,
  finalCheckDelayMs: 250,
  chunkSize: 512,
  chunkDelayMs: 50,
  postEndMarkerDelayMs: 150,
};

/** Flatten content blocks to the text a terminal can receive. Files become their paths. */
export function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      switch (block.type) {
        case 'text': return block.text;
        case 'file': return block.path;
        case 'image': return block.path ?? block.uri ?? '';
        case 'resource': return block.text ?? block.uri;
      }
    })
    .filter((part) => part.length > 0)
    .join('\n');
}

export class PtyAgentRuntime implements AgentRuntime {
  readonly kind = 'pty' as const;

  constructor(readonly agentId: string) {}

  private timing(): PasteSubmitTiming {
    const reg = agentRegistry.get(this.agentId);
    const provider = reg ? getProvider(reg.orchestrator) : undefined;
    return provider?.getPasteSubmitTiming() ?? DEFAULT_PASTE_TIMING;
  }

  isRunning(): boolean {
    return ptyManager.isRunning(this.agentId);
  }

  /** PTY status comes from hooks; this is only a liveness hint. */
  getState(): ChatSessionState {
    return this.isRunning() ? 'idle' : 'sleeping';
  }

  async sendMessage(content: string | ContentBlock[], opts: RuntimeSendOptions): Promise<RuntimeSendResult> {
    const text = contentToText(content);
    const timing = this.timing();
    if (text.includes('\n')) {
      await writeChunkedBracketedPaste(this.agentId, text, timing.chunkSize, timing.chunkDelayMs, timing.postEndMarkerDelayMs);
    } else {
      ptyManager.write(this.agentId, text);
    }
    if (opts.submit !== false) {
      await submitAfterPaste(this.agentId, timing);
    }
    return { delivery: 'prompt' };
  }

  async interrupt(): Promise<void> {
    ptyManager.write(this.agentId, '\x03');
  }

  async stop(opts?: { graceful?: boolean }): Promise<void> {
    if (opts?.graceful === false) {
      ptyManager.kill(this.agentId);
      return;
    }
    const reg = agentRegistry.get(this.agentId);
    const provider = reg ? getProvider(reg.orchestrator) : undefined;
    ptyManager.gracefulKill(this.agentId, provider?.getExitCommand());
  }

  async clearContext(): Promise<void> {
    await this.slashCommand('/clear');
  }

  async compact(): Promise<void> {
    await this.slashCommand('/compact');
  }

  private async slashCommand(command: string): Promise<void> {
    ptyManager.write(this.agentId, command);
    ptyManager.write(this.agentId, '\r');
  }

  /** PTY permissions go through the hook-driven queue: option ids are 'allow' or 'deny'. */
  async respondPermission(requestId: string, optionId: string): Promise<void> {
    const decision = optionId === 'allow' ? 'allow' : 'deny';
    const result = permissionQueue.resolvePermissionDetailed(requestId, decision, {
      expectedAgentId: this.agentId,
      source: 'desktop',
    });
    if (result.status !== 'resolved') {
      throw new Error(`Permission ${requestId} could not be resolved: ${result.reason}`);
    }
  }

  async answerQuestion(): Promise<void> {
    throw new Error('Terminal agents answer questions in the terminal');
  }

  /** The id the CLI printed into the terminal, when the provider can recognise it. */
  getNativeSessionId(): string | undefined {
    const reg = agentRegistry.get(this.agentId);
    const provider = reg ? getProvider(reg.orchestrator) : undefined;
    if (!provider || !isSessionCapable(provider)) return undefined;
    return provider.extractSessionId(ptyManager.getBuffer(this.agentId) ?? '') ?? undefined;
  }

  /** Terminals only report liveness here; status detail comes from hooks. */
  onStateChange(listener: (state: ChatSessionState) => void): () => void {
    return onAgentExit((agentId) => { if (agentId === this.agentId) listener('sleeping'); });
  }

  onExit(listener: (info: RuntimeExitInfo) => void): () => void {
    return onAgentExit((agentId, exitCode) => {
      if (agentId === this.agentId) listener({ reason: 'process_exit', exitCode });
    });
  }

  async readTranscript(opts?: { tail?: number }): Promise<RuntimeTranscriptSlice> {
    const buffer = ptyManager.getBuffer(this.agentId) ?? '';
    const text = opts?.tail ? buffer.split('\n').slice(-opts.tail).join('\n') : buffer;
    return { kind: 'pty', text };
  }
}

// Re-exported for call sites that still need a bare delay (e.g. send_file).
export { sleep };
