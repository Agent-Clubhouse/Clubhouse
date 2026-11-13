/**
 * Which E2E shard and which Annex E2E shard runs each spec (#2843).
 *
 * Playwright's --shard splits by test count, which put the slow app-launching
 * specs together. These lists are balanced by hand from measured times on
 * Linux, Windows and macOS: the JUnit times of the main runs after #3149, plus
 * a few seconds per spec for its app launch, which JUnit leaves out.
 * playwright.config.ts reads PLAYWRIGHT_E2E_SHARD and PLAYWRIGHT_ANNEX_SHARD.
 *
 * A new spec goes in the list with the most room.
 * test/e2e-shards.test.ts fails if a spec either job runs is in no list or in two.
 *
 * Plain .mjs with no Playwright imports, so the config and that test can both load it.
 */

export const E2E_SHARD_ENV = 'PLAYWRIGHT_E2E_SHARD';
export const ANNEX_SHARD_ENV = 'PLAYWRIGHT_ANNEX_SHARD';

/** The sharded E2E job: every spec its testIgnore leaves in. */
export const E2E_SHARDS = {
  1: [
    'agent-real-cli.spec.ts',
    'canvas-startup-bindings.spec.ts',
    'command-palette.spec.ts',
    'connection-view.spec.ts',
    'group-project-notices.spec.ts',
    'mcp-fresh-default.spec.ts',
    'plugin-system.spec.ts',
    'project-switching.spec.ts',
    'runtime-security.spec.ts',
    'smoke-blank-screen.spec.ts',
    'terminal.spec.ts',
  ],
  2: [
    'canvas-card-wheel.spec.ts',
    'group-project-membership.spec.ts',
    'mermaid-preview.spec.ts',
    'navigation.spec.ts',
    'open-project.spec.ts',
    'plugin-mcp-tools.spec.ts',
    'smoke-agent-lifecycle.spec.ts',
    'start-agent.spec.ts',
    'telemetry-export.spec.ts',
  ],
  3: [
    'app-launch.spec.ts',
    'canvas-create.spec.ts',
    'canvas-golden-path.spec.ts',
    'canvas-group-project-create.spec.ts',
    'chat-fake-cli.spec.ts',
    'find-replace.spec.ts',
    'plugin-multifile.spec.ts',
    'popout-window.spec.ts',
    'smoke-settings-persistence.spec.ts',
    'terminal-e2e.spec.ts',
  ],
};

/** The Annex E2E job: every spec in e2e/annex-v2. Each one launches two apps. */
export const ANNEX_SHARDS = {
  1: [
    'annex-v2/agents-across-machines.spec.ts',
    'annex-v2/device-list.spec.ts',
    'annex-v2/dispatcher-lead.spec.ts',
    'annex-v2/error-handling.spec.ts',
    'annex-v2/full-demo.spec.ts',
    'annex-v2/network-channel.spec.ts',
    'annex-v2/reachability.spec.ts',
    'annex-v2/settings-page.spec.ts',
  ],
  2: [
    'annex-v2/chat-across-desktops.spec.ts',
    'annex-v2/dispatcher-federation.spec.ts',
    'annex-v2/lifecycle.spec.ts',
    'annex-v2/minimal-test.spec.ts',
    'annex-v2/network-join.spec.ts',
    'annex-v2/remote-control.spec.ts',
    'annex-v2/remote-pty.spec.ts',
  ],
};

/**
 * The specs a shard runs, as `testMatch` globs. An unknown or empty shard
 * throws, rather than running everything or nothing.
 * @param {string} env the variable that chose the shard, for the error
 * @param {string} shard
 * @param {Record<string, string[]>} shards
 */
export function listShardTestMatch(env, shard, shards) {
  const specs = shards[shard];
  if (!specs) throw new Error(`${env} is ${shard}, and e2e/e2e-shards.mjs has shards ${Object.keys(shards).join(', ')}`);
  if (specs.length === 0) throw new Error(`${env} shard ${shard} in e2e/e2e-shards.mjs has no specs`);
  return specs.map((spec) => `**/${spec}`);
}
