/**
 * Orchestrator-aware polling instruction messages for group projects.
 *
 * Used by both the renderer (polling toggle button) and the main process
 * (auto-inject on join when polling is already enabled).
 */

import type { OrchestratorId } from './types';

export function pollingStartMsg(projectName: string, orchestrator?: OrchestratorId): string {
  switch (orchestrator) {
    case 'claude-code':
      return (
        `Group Project notification: Set up automatic polling for "${projectName}". ` +
        'Schedule a recurring task to call read_bulletin every 60 seconds and act on any relevant updates. ' +
        'Use /loop to automate: /loop 60s read_bulletin'
      );
    default:
      return (
        `Group Project notification: Poll the bulletin board for "${projectName}" every 60 seconds ` +
        'when idle or between turns. Use read_bulletin to check for updates.'
      );
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
