/**
 * Claude chat driver transports (docs/structured-chat-research.md §7
 * "Claude: one driver, two transports"). Both run the user's own `claude`
 * and emit the same normalized events.
 */
import { ClaudeSdkTransport } from './sdk-transport';
import { ClaudeStreamTransport } from './stream-transport';
import type { ClaudeTransport, ClaudeTransportKind, ClaudeTransportOptions } from './transport';

export type * from './events';
export type {
  ClaudeImageInput,
  ClaudePermissionDecision,
  ClaudeTransport,
  ClaudeTransportKind,
  ClaudeTransportLog,
  ClaudeTransportOptions,
  ClaudeUserInput,
} from './transport';
export { ClaudeSdkTransport, listClaudeSessions, readClaudeSession } from './sdk-transport';
export { ClaudeStreamTransport, buildStreamJsonArgs } from './stream-transport';

/** The SDK transport is the default; stream-json is the fallback mode. */
export function createClaudeTransport(kind: ClaudeTransportKind, opts: ClaudeTransportOptions): ClaudeTransport {
  return kind === 'sdk' ? new ClaudeSdkTransport(opts) : new ClaudeStreamTransport(opts);
}
