/**
 * Orchestrator-aware polling instruction messages for group projects.
 *
 * Used by both the renderer (polling toggle button) and the main process
 * (auto-inject on join when polling is already enabled).
 *
 * Channel model: every project has protected "general" and "control" channels
 * plus a per-agent "inbox-<agent>" channel. Agents poll the digest filtered to
 * their standard set (general + control + own inbox + tracked work channels)
 * to avoid paying tokens for unrelated chatter.
 */

import type { OrchestratorId } from './types';

function standardChannelsHint(inboxChannel: string | null): string {
  const inboxPart = inboxChannel ? `"${inboxChannel}"` : '"inbox-<your-name>"';
  return (
    `channels=["general","control",${inboxPart}, ...any work channels you are actively tracking]`
  );
}

export function pollingStartMsg(
  projectName: string,
  orchestrator?: OrchestratorId,
  inboxChannel?: string | null,
): string {
  const hint = standardChannelsHint(inboxChannel ?? null);
  const common =
    `Group Project "${projectName}": start polling. ` +
    'Call read_bulletin every 60 seconds with since=<latestTimestamp from your last read> and ' +
    `${hint}. ` +
    'Only drill into a channel with read_topic when its newMessageCount > 0.';
  switch (orchestrator) {
    case 'claude-code':
      return `${common} Automate with: /loop 60s read_bulletin`;
    default:
      return common;
  }
}

export function pollingStopMsg(projectName: string, orchestrator?: OrchestratorId): string {
  switch (orchestrator) {
    case 'claude-code':
      return (
        `Group Project notification: Stop polling the bulletin board for "${projectName}". ` +
        'Cancel any /loop or scheduled task you set up for this polling.'
      );
    default:
      return `Group Project notification: Stop periodic bulletin board polling for "${projectName}".`;
  }
}

export function pollingNudgeMsg(
  projectName: string,
  orchestrator?: OrchestratorId,
  inboxChannel?: string | null,
): string {
  const hint = standardChannelsHint(inboxChannel ?? null);
  switch (orchestrator) {
    case 'claude-code':
      return (
        `Group Project nudge: if you are NOT already polling "${projectName}", start now. ` +
        `Use /loop 60s read_bulletin with since=<latestTimestamp> and ${hint}.`
      );
    default:
      return (
        `Group Project nudge: if you are NOT already polling "${projectName}", start now ` +
        `(every 60 seconds). Use read_bulletin with since=<latestTimestamp> and ${hint}.`
      );
  }
}
