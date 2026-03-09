/**
 * Structured feed item from a parsed transcript.
 * Used by both the main process (headless-manager) and renderer (HeadlessAgentView).
 */
export type TranscriptFeedItem =
  | { kind: 'tool'; name: string; ts: number }
  | { kind: 'text'; text: string; ts: number }
  | { kind: 'result'; text: string; ts: number };
