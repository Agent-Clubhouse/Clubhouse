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
 * UNIT_FILE_SECONDS: the files that take 5 s or more on Windows, the slowest
 * OS, in seconds of JUnit test time on windows-latest: the larger of the median
 * over main runs 43778593486, 43781203632, 43790201353 and 43799649284 and the
 * latest of them, so a test that just grew counts at its new time. Every other
 * file counts as DEFAULT_FILE_SECONDS, which stands for its import and setup.
 * Linux has room to spare and balances closely enough on the same split.
 *
 * A stale entry only makes the split less even; it can't drop or repeat a
 * file. A name that no longer matches a file is ignored. Refresh from recent
 * Windows runs (docs/ci.md, "Unit shards"). The four files #3574 sped up use
 * its reported Windows times (dispatcher-federation-local-work and -requests;
 * managed-agents' activation and retired-builtins now fall under 5 s).
 *
 * Plain .mjs with no vitest imports, so the sequencer and its test can both load it.
 */

export const DEFAULT_FILE_SECONDS = 1;

/** @type {Record<string, number>} repo-relative path with forward slashes, to seconds */
export const UNIT_FILE_SECONDS = {
  'src/main/services/handoff-host-transfer.test.ts': 270,
  'src/main/services/handoff-git-receive.test.ts': 236,
  'src/main/services/handoff-snapshot.test.ts': 172,
  'src/main/services/handoff-apply.test.ts': 144,
  'src/main/services/framebriar/feedback-service.sdk.test.ts': 111,
  'src/main/services/annex-server.test.ts': 75,
  'src/main/services/project-import/service.test.ts': 73,
  'src/main/services/clubhouse-mcp/tools/project-import-tools.test.ts': 58,
  'src/main/services/handoff-git-bundle.test.ts': 55,
  'src/main/services/git-service.branch.test.ts': 53,
  'src/main/services/handoff-transfer-integration.test.ts': 52,
  'src/main/services/agent-runtime/checkpoints.test.ts': 36,
  'src/renderer/plugins/builtin/canvas/main.test.ts': 33,
  'src/main/services/git-watcher.git.test.ts': 32,
  'src/main/services/handoff-preparations.test.ts': 28,
  'test/annex-v2/annex-harness.test.ts': 28,
  'test/annex-v2/annex-appearance.test.ts': 25,
  'src/main/services/prepare-handoff-skill.test.ts': 23,
  'src/main/services/agent-runtime/checkpoint-tracker.test.ts': 22,
  'src/main/services/annex-mobile-contract.test.ts': 21,
  'src/main/services/asset-catalog/store.test.ts': 19,
  'src/main/services/dispatcher-controls.test.ts': 19,
  'src/main/services/managed-agents/delivery.test.ts': 19,
  'src/main/services/dispatcher-federation-local-work.test.ts': 18,
  'src/main/chat/copilot/fixture-replay.test.ts': 17,
  'src/main/services/agent-config-helpers.git.test.ts': 17,
  'src/main/services/annex-agent-calls.test.ts': 17,
  'src/main/telemetry/health.test.ts': 17,
  'src/renderer/features/settings/GroupProjectsSettingsView.test.tsx': 17,
  'src/renderer/features/agents/chat/ChatView.test.tsx': 16,
  'src/main/services/dispatcher/dispatcher-copy.test.ts': 15,
  'src/main/services/agent-runtime/agent-mcp-launch.test.ts': 14,
  'src/main/services/clubhouse-mcp/tools/managed-tools.test.ts': 14,
  'src/main/services/handoff-retention.test.ts': 14,
  'src/main/services/pty-headless-terminal.budget.test.ts': 14,
  'src/main/services/annex-chat-pages.test.ts': 13,
  'src/renderer/features/agents/AgentSettingsView.test.tsx': 13,
  'test/e2e-cleanup.test.ts': 13,
  'src/main/services/clubhouse-owned-files.test.ts': 12,
  'src/main/services/dispatcher/dispatcher-service.test.ts': 12,
  'src/renderer/chrome/ChromeSidebar.test.tsx': 12,
  'src/main/services/annex-chat-bounds.test.ts': 11,
  'src/main/services/handoff-quarantine.test.ts': 11,
  'src/main/services/handoff-secret-snapshot.test.ts': 11,
  'src/main/services/managed-agents/plain.test.ts': 11,
  'src/main/services/managed-agents/service.test.ts': 11,
  'src/renderer/features/agents/chat/ChatStream.reading.test.tsx': 11,
  'src/main/services/delete-review-state.test.ts': 10,
  'src/main/services/group-project-lifecycle.test.ts': 10,
  'src/main/telemetry/export-graduation.test.ts': 10,
  'scripts/ci/release-notes.test.ts': 9,
  'scripts/ci/stable-candidate.test.ts': 9,
  'src/main/services/agent-creation-defaults.git.test.ts': 9,
  'src/main/services/clubhouse-mcp/tools/connection-tools.test.ts': 9,
  'src/main/services/headless-prompt.test.ts': 9,
  'src/main/services/managed-agents/git-excludes.git.test.ts': 9,
  'src/main/services/dispatcher-federation-requests.test.ts': 8,
  'src/renderer/features/agents/details/AgentDetailsAsleep.test.tsx': 8,
  'src/renderer/features/feedback/FeedbackReviewDialog.test.tsx': 8,
  'src/renderer/features/settings/DispatcherSettingsView.test.tsx': 8,
  'src/renderer/plugins/builtin/canvas/WireInstructionsDialog.test.tsx': 8,
  'scripts/ci/cli-denylist.test.ts': 7,
  'src/main/chat/copilot/driver.test.ts': 7,
  'src/main/services/connection-grants.test.ts': 7,
  'src/main/services/framebriar/feedback-service.test.ts': 7,
  'src/main/services/group-project-shoulder-tap.test.ts': 7,
  'src/main/services/managed-agents/agents.test.ts': 7,
  'src/renderer/chrome/pages/NewAgentPage.managed.test.tsx': 7,
  'src/renderer/features/managed/ManagedBuilder.test.tsx': 7,
  'src/renderer/features/settings/OrchestratorSettingsView.test.tsx': 7,
  'src/renderer/plugins/builtin/canvas/canvas-hydration.test.ts': 7,
  'src/main/services/annex-client.test.ts': 6,
  'src/main/services/goobers-daemon.test.ts': 6,
  'src/main/services/group-project-network.sim.test.ts': 6,
  'src/renderer/features/agents/chat/ChatStream.perf.test.tsx': 6,
  'src/renderer/features/group-projects/GroupProjectWorkspace.test.tsx': 6,
  'src/renderer/features/managed/SharedEdits.test.tsx': 6,
  'src/renderer/plugins/plugin-api-factory.test.ts': 6,
  'test/annex-v2/annex-forward.test.ts': 6,
  'src/main/services/dispatcher-federation-receiver.test.ts': 5,
  'src/main/services/managed-agents/project-templates.test.ts': 5,
  'src/main/services/managed-agents/restart.test.ts': 5,
  'src/renderer/features/agents/helpers/ConnectionsCard.test.tsx': 5,
  'src/renderer/features/group-projects/board/GroupProjectBoard.test.tsx': 5,
  'src/renderer/features/managed/ManagedSettings.test.tsx': 5,
};

/**
 * A file's weight: its measured seconds, or the default.
 * @param {string} file
 * @param {Record<string, number>} [seconds]
 */
export function fileSeconds(file, seconds = UNIT_FILE_SECONDS) {
  return seconds[file] ?? DEFAULT_FILE_SECONDS;
}

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
  const weight = (file) => fileSeconds(file, seconds);
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
