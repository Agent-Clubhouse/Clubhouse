/**
 * How Validate's unit job splits test files across its shards.
 *
 * vitest's own --shard sorts files by a hash of their path and cuts the list
 * into equal counts. That put every git-heavy handoff test in shard 2/2, which
 * on Windows took about three times as long as shard 1/2 and was the run's
 * long pole (docs/ci.md, "Unit shards"). test/unit-sequencer.ts uses
 * partitionByWeight instead: every shard gets every file exactly once, packed
 * by measured time.
 *
 * UNIT_FILE_SECONDS: the slow files, in seconds of JUnit test time on Windows
 * plus Linux (the median of the main runs 43778593486, 43781203632 and
 * 43799649284). Every other file counts as DEFAULT_FILE_SECONDS, which stands
 * for its import and setup. A stale or missing entry only makes the split less
 * even; it can't drop or repeat a file.
 *
 * Left at the default while #3571 changes them, so their slow Windows times
 * don't skew the split: dispatcher-federation-local-work, and managed-agents'
 * activation and retired-builtins tests.
 *
 * Plain .mjs with no vitest imports, so the sequencer and its test can both load it.
 */

export const DEFAULT_FILE_SECONDS = 1;

/** @type {Record<string, number>} repo-relative path with forward slashes, to seconds */
export const UNIT_FILE_SECONDS = {
  'src/main/services/handoff-host-transfer.test.ts': 302,
  'src/main/services/handoff-git-receive.test.ts': 260,
  'src/main/services/handoff-snapshot.test.ts': 180,
  'src/main/services/handoff-apply.test.ts': 176,
  'scripts/check-claude-sdk-chunk.test.ts': 152,
  'scripts/check-telemetry-chunk-size.test.ts': 150,
  'src/main/services/annex-server.test.ts': 147,
  'src/main/services/framebriar/feedback-service.sdk.test.ts': 119,
  'src/main/services/project-import/service.test.ts': 75,
  'src/main/services/clubhouse-mcp/tools/project-import-tools.test.ts': 68,
  'src/main/services/handoff-git-bundle.test.ts': 64,
  'src/main/services/handoff-transfer-integration.test.ts': 64,
  'src/renderer/plugins/builtin/canvas/main.test.ts': 63,
  'test/annex-v2/annex-harness.test.ts': 57,
  'test/annex-v2/annex-appearance.test.ts': 49,
  'src/main/services/agent-runtime/checkpoints.test.ts': 39,
  'src/main/services/annex-mobile-contract.test.ts': 39,
  'src/main/chat/copilot/fixture-replay.test.ts': 37,
  'src/main/services/git-watcher.git.test.ts': 36,
  'src/main/telemetry/health.test.ts': 34,
  'src/main/services/handoff-preparations.test.ts': 32,
  'src/main/services/git-service.branch.test.ts': 30,
  'scripts/ci/release-publish.test.ts': 29,
  'src/renderer/features/agents/chat/ChatView.test.tsx': 27,
  'src/main/services/pty-headless-terminal.budget.test.ts': 26,
  'src/main/services/annex-chat-pages.test.ts': 25,
  'src/renderer/features/settings/GroupProjectsSettingsView.test.tsx': 24,
  'src/main/services/agent-runtime/checkpoint-tracker.test.ts': 23,
  'src/main/services/prepare-handoff-skill.test.ts': 23,
  'src/main/services/annex-chat-bounds.test.ts': 22,
  'src/main/services/asset-catalog/store.test.ts': 22,
  'src/main/services/dispatcher-controls.test.ts': 22,
  'src/renderer/features/agents/AgentSettingsView.test.tsx': 22,
  'src/main/services/handoff-retention.test.ts': 21,
  'src/renderer/chrome/ChromeSidebar.test.tsx': 21,
  'src/main/services/clubhouse-mcp/tools/managed-tools.test.ts': 20,
  'src/main/services/dispatcher/dispatcher-copy.test.ts': 20,
  'src/main/services/group-project-lifecycle.test.ts': 20,
  'src/main/services/managed-agents/delivery.test.ts': 20,
  'src/renderer/features/agents/chat/ChatStream.reading.test.tsx': 20,
  'src/main/services/agent-config-helpers.git.test.ts': 19,
  'test/e2e-cleanup.test.ts': 17,
  'scripts/ci/stable-candidate.test.ts': 16,
  'src/main/services/agent-runtime/agent-mcp-launch.test.ts': 16,
  'src/main/services/annex-agent-calls.test.ts': 16,
  'src/renderer/features/feedback/FeedbackReviewDialog.test.tsx': 16,
  'src/main/telemetry/export-graduation.test.ts': 15,
  'src/main/services/dispatcher/dispatcher-service.test.ts': 14,
  'src/renderer/features/settings/DispatcherSettingsView.test.tsx': 14,
  'src/renderer/plugins/builtin/canvas/canvas-hydration.test.ts': 14,
  'src/renderer/plugins/builtin/files/FileTree.test.tsx': 14,
  'src/renderer/plugins/plugin-api-factory.test.ts': 14,
  'src/main/chat/copilot/driver.test.ts': 13,
  'src/main/services/group-project-shoulder-tap.test.ts': 13,
  'src/main/services/managed-agents/service.test.ts': 13,
  'src/renderer/chrome/pages/NewAgentPage.managed.test.tsx': 13,
  'src/renderer/features/agents/chat/ChatStream.perf.test.tsx': 13,
  'src/renderer/features/agents/details/AgentDetailsAsleep.test.tsx': 13,
  'src/renderer/plugins/builtin/canvas/WireInstructionsDialog.test.tsx': 13,
  'src/main/services/framebriar/feedback-service.test.ts': 12,
  'src/main/services/goobers-daemon.test.ts': 12,
  'src/main/services/group-project-network.sim.test.ts': 12,
  'src/renderer/features/managed/ManagedBuilder.test.tsx': 12,
  'src/renderer/features/settings/OrchestratorSettingsView.test.tsx': 12,
  'test/annex-v2/annex-forward.test.ts': 12,
  'src/main/services/annex-delivery-store.test.ts': 11,
  'src/main/services/clubhouse-mcp/tools/connection-tools.test.ts': 11,
  'src/main/services/clubhouse-owned-files.test.ts': 11,
  'src/main/services/delete-review-state.test.ts': 11,
  'src/main/services/handoff-secret-snapshot.test.ts': 11,
  'src/main/services/managed-agents/plain.test.ts': 11,
  'src/renderer/features/group-projects/GroupProjectWorkspace.test.tsx': 11,
  'src/renderer/features/managed/SharedEdits.test.tsx': 11,
  'scripts/ci/release-notes.test.ts': 10,
  'src/main/services/agent-creation-defaults.git.test.ts': 10,
  'src/main/services/annex-client.test.ts': 10,
  'src/main/services/handoff-transfer-receiver.test.ts': 10,
  'src/main/services/managed-agents/git-excludes.git.test.ts': 10,
  'src/renderer/features/agents/helpers/ConnectionsCard.test.tsx': 10,
  'src/renderer/features/managed/ManagedSettings.test.tsx': 10,
  'src/main/services/headless-prompt.test.ts': 9,
  'src/main/services/helper-pressure-replay.test.ts': 9,
  'src/renderer/features/group-projects/board/GroupProjectBoard.test.tsx': 9,
  'src/renderer/plugins/builtin/group-project/GroupProjectCanvasWidget.chrome.test.tsx': 9,
  'src/main/services/managed-agents/agents.test.ts': 8,
  'src/renderer/features/actions/ActionsSettingsView.test.tsx': 8,
  'src/renderer/features/managed/DialogDismissal.test.tsx': 8,
  'src/renderer/features/settings/DisplaySettingsView.themes.test.tsx': 8,
  'scripts/ci/cli-denylist.test.ts': 7,
  'src/main/chat/claude/driver.test.ts': 7,
  'src/main/chat/claude/transports.test.ts': 7,
  'src/main/services/connection-grants.test.ts': 7,
  'src/main/services/goobers-service.test.ts': 7,
  'src/main/services/handoff-quarantine.test.ts': 7,
  'src/renderer/chrome/ProjectSettingsTransitions.test.tsx': 7,
  'src/renderer/features/agents/AgentGrantsSettings.test.tsx': 7,
  'src/renderer/features/agents/chat/AgentRuntimePane.test.tsx': 7,
  'src/renderer/features/group-projects/GroupProjectsHub.test.tsx': 7,
  'src/renderer/features/skills/CatalogSkillBundleEditor.test.tsx': 7,
  'scripts/chat-fixtures/chat-fixtures.test.ts': 6,
  'src/main/services/agent-system.test.ts': 6,
  'src/main/services/annex-tls.test.ts': 6,
  'src/main/services/clubhouse-mcp/tools/group-project-tools.test.ts': 6,
  'src/main/services/dispatcher-federation-receiver.test.ts': 6,
  'src/main/services/handoff-transfer-source.test.ts': 6,
  'src/main/services/managed-agents/discovery.test.ts': 6,
  'src/main/services/managed-agents/downgrade.test.ts': 6,
  'src/main/services/managed-agents/project-templates.test.ts': 6,
  'src/renderer/chrome/pages/NewAgentPage.test.tsx': 6,
  'src/renderer/features/agents/chat/ChatHistory.test.tsx': 6,
  'src/renderer/features/agents/chat/copilot-steering-integration.test.tsx': 6,
  'src/renderer/features/agents/helpers/connection-target-navigation.test.tsx': 6,
  'src/renderer/features/managed/SkillImport.test.tsx': 6,
  'src/renderer/features/settings/FeedbackSettingsView.test.tsx': 6,
  'src/renderer/features/skills/SkillBundleEditor.test.tsx': 6,
  'src/main/orchestrators/adapters/testing/chat-script.test.ts': 5,
  'src/main/services/agent-config.branch-delete.test.ts': 5,
  'src/main/services/goobers-event-stream.test.ts': 5,
  'src/renderer/chrome/ProjectContextSettings.test.tsx': 5,
  'src/renderer/chrome/sidebar/ProjectTree.test.tsx': 5,
  'src/renderer/features/agents/chat/AgentMap.test.tsx': 5,
  'src/renderer/features/agents/details/AgentDetails.test.tsx': 5,
  'src/renderer/features/settings/DisplaySettingsView.test.tsx': 5,
  'src/renderer/features/settings/HelperPresetsSection.test.tsx': 5,
  'src/renderer/features/settings/TelemetrySettingsSection.test.tsx': 5,
  'test/e2e-delivery-crash-readiness.test.ts': 5,
};

/**
 * Splits files into `count` shards, heaviest first, each into the lightest
 * shard so far (ties go to the lower shard, then the path decides). The result
 * depends only on the set of files, not their order, so every shard's process
 * computes the same split.
 * @param {string[]} files repo-relative paths with forward slashes
 * @param {number} count
 * @param {Record<string, number>} [seconds]
 * @returns {string[][]} one list per shard, shard 1 first
 */
export function partitionByWeight(files, count, seconds = UNIT_FILE_SECONDS) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const weight = (file) => seconds[file] ?? DEFAULT_FILE_SECONDS;
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], load: 0 }));
  for (const file of ordered) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.load < lightest.load) lightest = shard;
    lightest.files.push(file);
    lightest.load += weight(file);
  }
  return shards.map((shard) => shard.files);
}
