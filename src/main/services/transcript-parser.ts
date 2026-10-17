import { StreamJsonEvent } from './jsonl-parser';
import { summarizeHeadlessTranscript } from '../../shared/headless-transcript';

export interface TranscriptSummary {
  summary: string | null;
  filesModified: string[];
  costUsd: number;
  durationMs: number;
  toolsUsed: string[];
}

/**
 * Extracts a structured summary from an array of JSONL transcript events
 * produced by Claude Code's `--verbose --output-format stream-json`.
 *
 * Thin wrapper over the shared `summarizeHeadlessTranscript`, which the
 * renderer also uses, defaulting cost and duration to 0.
 */
export function parseTranscript(events: StreamJsonEvent[]): TranscriptSummary {
  const s = summarizeHeadlessTranscript(events);
  return {
    summary: s.summary,
    filesModified: s.filesModified,
    costUsd: s.costUsd ?? 0,
    durationMs: s.durationMs ?? 0,
    toolsUsed: s.toolsUsed,
  };
}
