import { describe, expect, it } from 'vitest';
import {
  ATTR,
  countBucket,
  allAttributeKeys,
  EVENTS,
  getAttributeSpec,
  isKnownEvent,
  isKnownMetric,
  isKnownSpan,
  levelAllows,
  METRICS,
  OTHER,
  SPANS,
  type TelAttr,
} from './attributes';

// One sample per registry entry. Adding an ATTR key without a sample here
// fails the "every key has a test" check below (spec §5.1 (a)).
const SAMPLES: Record<keyof typeof ATTR, { good: TelAttr; key: string }> = {
  outcome: { good: ATTR.outcome('ok'), key: 'clubhouse.outcome' },
  errorType: { good: ATTR.errorType('timeout'), key: 'error.type' },
  process: { good: ATTR.process('main'), key: 'clubhouse.process' },
  startupKind: { good: ATTR.startupKind('after_update'), key: 'clubhouse.startup.kind' },
  telemetrySignal: { good: ATTR.telemetrySignal('logs'), key: 'clubhouse.telemetry.signal' },
  httpClass: { good: ATTR.httpClass('5xx'), key: 'clubhouse.http.class' },
  telemetryDestination: { good: ATTR.telemetryDestination('otlp'), key: 'clubhouse.telemetry.destination' },
  agentKind: { good: ATTR.agentKind('durable'), key: 'clubhouse.agent.kind' },
  orchestrator: { good: ATTR.orchestrator('codex-cli'), key: 'clubhouse.orchestrator' },
  agentRuntime: { good: ATTR.agentRuntime('headless'), key: 'clubhouse.agent.runtime' },
  exitCode: { good: ATTR.exitCode(137), key: 'process.exit.code' },
  agentIdHash: { good: ATTR.agentIdHash('agent_123'), key: 'clubhouse.agent.id_hash' },
  sizeBucket: { good: ATTR.sizeBucket('<1MB'), key: 'clubhouse.size_bucket' },
  exceptionHandled: { good: ATTR.exceptionHandled(true), key: 'clubhouse.exception.handled' },
  exceptionOrigin: { good: ATTR.exceptionOrigin('renderer'), key: 'clubhouse.exception.origin' },
  updateFromVersion: { good: ATTR.updateFromVersion('0.42.0'), key: 'clubhouse.update.from_version' },
  windowKind: { good: ATTR.windowKind('popout'), key: 'clubhouse.window.kind' },
  view: { good: ATTR.view('terminal'), key: 'clubhouse.view' },
  errorBoundary: { good: ATTR.errorBoundary('app'), key: 'clubhouse.error.boundary' },
  rendererGoneReason: { good: ATTR.rendererGoneReason('oom'), key: 'clubhouse.renderer.gone_reason' },
  childProcessType: { good: ATTR.childProcessType('GPU'), key: 'clubhouse.child_process.type' },
  childProcessGoneReason: { good: ATTR.childProcessGoneReason('crashed'), key: 'clubhouse.child_process.gone_reason' },
  uiSurface: { good: ATTR.uiSurface('sidebar_list'), key: 'clubhouse.ui.surface' },
  uiFeature: { good: ATTR.uiFeature('tab_select'), key: 'clubhouse.ui.feature' },
  uiAction: { good: ATTR.uiAction('add_project'), key: 'clubhouse.ui.action' },
  shutdownStep: { good: ATTR.shutdownStep('pty_kill_all'), key: 'clubhouse.shutdown.step' },
  previousExit: { good: ATTR.previousExit('crash_loop'), key: 'clubhouse.shutdown.previous' },
  safeModeTrigger: { good: ATTR.safeModeTrigger('cli_flag'), key: 'clubhouse.safe_mode.trigger' },
  installKind: { good: ATTR.installKind('rpm'), key: 'clubhouse.install.kind' },
  projectsCount: { good: ATTR.projectsCount(4), key: 'clubhouse.projects.count' },
  themeKind: { good: ATTR.themeKind('plugin'), key: 'clubhouse.theme.kind' },
  clubhouseMode: { good: ATTR.clubhouseMode(true), key: 'clubhouse.clubhouse_mode' },
  annexServer: { good: ATTR.annexServer(false), key: 'clubhouse.annex.server' },
  annexClient: { good: ATTR.annexClient(true), key: 'clubhouse.annex.client' },
  loggingEnabled: { good: ATTR.loggingEnabled(true), key: 'clubhouse.logging.enabled' },
  updateTrigger: { good: ATTR.updateTrigger('startup'), key: 'clubhouse.update.trigger' },
  updateChannel: { good: ATTR.updateChannel('preview'), key: 'clubhouse.update.channel' },
  updateResult: { good: ATTR.updateResult('up_to_date'), key: 'clubhouse.update.result' },
  updatePhase: { good: ATTR.updatePhase('download'), key: 'clubhouse.update.phase' },
  updateApplyMode: { good: ATTR.updateApplyMode('on_quit'), key: 'clubhouse.update.apply.mode' },
  applyVerified: { good: ATTR.applyVerified('not_taken'), key: 'clubhouse.update.apply.verified' },
  processType: { good: ATTR.processType('gpu'), key: 'clubhouse.process.type' },
  persistStore: { good: ATTR.persistStore('plugin_kv'), key: 'clubhouse.persist.store' },
  persistResult: { good: ATTR.persistResult('failed'), key: 'clubhouse.persist.result' },
  persistAction: { good: ATTR.persistAction('restored_from_backup'), key: 'clubhouse.persist.action' },
  persistGuardReason: { good: ATTR.persistGuardReason('verify_empty'), key: 'clubhouse.persist.guard_reason' },
  agentExitClass: { good: ATTR.agentExitClass('early_failure'), key: 'clubhouse.agent.exit.class' },
  killStage: { good: ATTR.killStage('sigterm'), key: 'clubhouse.kill.stage_reached' },
  hookKind: { good: ATTR.hookKind('post_tool'), key: 'clubhouse.hook.kind' },
  toolBucket: { good: ATTR.toolBucket('Bash'), key: 'clubhouse.tool.bucket' },
  toolResult: { good: ATTR.toolResult('error'), key: 'clubhouse.tool.result' },
  permissionDecision: { good: ATTR.permissionDecision('deny'), key: 'clubhouse.permission.decision' },
  permissionResult: { good: ATTR.permissionResult('timeout'), key: 'clubhouse.permission.result' },
  mcpToolKind: { good: ATTR.mcpToolKind('group'), key: 'clubhouse.mcp.tool_kind' },
  mcpTool: { good: ATTR.mcpTool('send_message'), key: 'clubhouse.mcp.tool' },
  mcpResult: { good: ATTR.mcpResult('threw'), key: 'clubhouse.mcp.result' },
  binaryLookupTier: { good: ATTR.binaryLookupTier('path_scan'), key: 'clubhouse.binary.lookup_tier' },
  // Workspace (Phase 5)
  gitOp: { good: ATTR.gitOp('push'), key: 'clubhouse.git.op' },
  gitTimedOut: { good: ATTR.gitTimedOut(true), key: 'clubhouse.git.timed_out' },
  gitStatusFileCount: { good: ATTR.gitStatusFileCount('10-99'), key: 'clubhouse.git.status.file_count_bucket' },
  fileOp: { good: ATTR.fileOp('read_tree'), key: 'clubhouse.file.op' },
  fileResult: { good: ATTR.fileResult('error'), key: 'clubhouse.file.result' },
  treeNodeCount: { good: ATTR.treeNodeCount('>=10000'), key: 'clubhouse.tree.node_count_bucket' },
  treeHitCap: { good: ATTR.treeHitCap(true), key: 'clubhouse.tree.hit_cap' },
  searchEngine: { good: ATTR.searchEngine('rg'), key: 'clubhouse.search.engine' },
  searchTruncated: { good: ATTR.searchTruncated(false), key: 'clubhouse.search.truncated' },
  searchMatchCount: { good: ATTR.searchMatchCount('0'), key: 'clubhouse.search.match_count_bucket' },
  searchRegex: { good: ATTR.searchRegex(true), key: 'clubhouse.search.regex' },
  searchCaseSensitive: { good: ATTR.searchCaseSensitive(false), key: 'clubhouse.search.case_sensitive' },
  searchWholeWord: { good: ATTR.searchWholeWord(false), key: 'clubhouse.search.whole_word' },
  editorBucket: { good: ATTR.editorBucket('cursor'), key: 'clubhouse.editor.bucket' },
  pluginRef: { good: ATTR.pluginRef('canvas'), key: 'clubhouse.plugin.ref' },
  pluginIdHash: { good: ATTR.pluginIdHash('my-community-plugin'), key: 'clubhouse.plugin.id_hash' },
  pluginOrigin: { good: ATTR.pluginOrigin('marketplace'), key: 'clubhouse.plugin.origin' },
  pluginScope: { good: ATTR.pluginScope('dual'), key: 'clubhouse.plugin.scope' },
  pluginApiVersion: { good: ATTR.pluginApiVersion('0.9'), key: 'clubhouse.plugin.api_version' },
  attempt: { good: ATTR.attempt(2), key: 'clubhouse.attempt' },
  pluginProtocolResult: { good: ATTR.pluginProtocolResult('denied'), key: 'clubhouse.plugin.protocol.result' },
  canvasLoadResult: { good: ATTR.canvasLoadResult('recovered_from_backup'), key: 'clubhouse.canvas.load.result' },
  canvasCount: { good: ATTR.canvasCount(3), key: 'clubhouse.canvas.count' },
  canvasViewCount: { good: ATTR.canvasViewCount('1-9'), key: 'clubhouse.canvas.view.count_bucket' },
  // Workspace 5b
  registryKind: { good: ATTR.registryKind('custom'), key: 'clubhouse.registry.kind' },
  cacheHit: { good: ATTR.cacheHit(true), key: 'clubhouse.cache.hit' },
  httpStatusCode: { good: ATTR.httpStatusCode(404), key: 'http.response.status_code' },
  installFailureStage: { good: ATTR.installFailureStage('integrity'), key: 'clubhouse.install.failure_stage' },
  updatesAvailable: { good: ATTR.updatesAvailable(2), key: 'clubhouse.updates.available.count' },
  updatesIncompatible: { good: ATTR.updatesIncompatible(1), key: 'clubhouse.updates.incompatible.count' },
  settingsKey: { good: ATTR.settingsKey('editor'), key: 'clubhouse.settings.key' },
  themeBuiltinId: { good: ATTR.themeBuiltinId('nord'), key: 'clubhouse.theme.builtin_id' },
  popoutType: { good: ATTR.popoutType('agent'), key: 'clubhouse.popout.type' },
  bulletinPostResult: { good: ATTR.bulletinPostResult('evicted_topic'), key: 'clubhouse.bulletin.post.result' },
  mcpToolsCount: { good: ATTR.mcpToolsCount('10-99'), key: 'clubhouse.mcp.tools.count_bucket' },
  mcpToolsEmpty: { good: ATTR.mcpToolsEmpty(true), key: 'clubhouse.mcp.tools.empty' },
  configFormat: { good: ATTR.configFormat('toml'), key: 'clubhouse.config.format' },
};

describe('telemetry attribute registry', () => {
  it('has a test sample for every registry key', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(ATTR).sort());
  });

  it.each(Object.entries(SAMPLES))('%s produces its declared key and a registered spec', (_name, sample) => {
    expect(sample.good.key).toBe(sample.key);
    const spec = getAttributeSpec(sample.key);
    expect(spec).toBeDefined();
    expect(spec?.kind).toBe(sample.good.kind);
  });

  it('normalizes enum values outside the set to "other"', () => {
    // Runtime values can escape the type system (e.g. from parsed data).
    const bogus = 'C:\\Users\\alice' as unknown as 'ok';
    expect(ATTR.outcome(bogus).value).toBe(OTHER);
    expect(ATTR.orchestrator('my-secret-cli' as 'other').value).toBe(OTHER);
  });

  it('truncates ints and coerces bools', () => {
    expect(ATTR.exitCode(1.9).value).toBe(1);
    expect(ATTR.exceptionHandled('yes' as unknown as boolean).value).toBe(false);
  });

  it('keeps hash attributes raw until the main-process facade hashes them', () => {
    expect(ATTR.agentIdHash('agent_1')).toEqual({ key: 'clubhouse.agent.id_hash', kind: 'hash', value: 'agent_1' });
  });

  it('snapshots the full key list so additions show up in review', () => {
    expect(allAttributeKeys()).toMatchInlineSnapshot(`
      [
        "clubhouse.agent.exit.class",
        "clubhouse.agent.id_hash",
        "clubhouse.agent.kind",
        "clubhouse.agent.runtime",
        "clubhouse.annex.client",
        "clubhouse.annex.server",
        "clubhouse.attempt",
        "clubhouse.binary.lookup_tier",
        "clubhouse.blocked.flow",
        "clubhouse.bulletin.post.result",
        "clubhouse.cache.hit",
        "clubhouse.canvas.count",
        "clubhouse.canvas.load.result",
        "clubhouse.canvas.view.count_bucket",
        "clubhouse.child_process.gone_reason",
        "clubhouse.child_process.type",
        "clubhouse.clubhouse_mode",
        "clubhouse.config.format",
        "clubhouse.editor.bucket",
        "clubhouse.error.boundary",
        "clubhouse.exception.handled",
        "clubhouse.exception.origin",
        "clubhouse.file.op",
        "clubhouse.file.result",
        "clubhouse.git.op",
        "clubhouse.git.status.file_count_bucket",
        "clubhouse.git.timed_out",
        "clubhouse.hook.kind",
        "clubhouse.http.class",
        "clubhouse.install.failure_stage",
        "clubhouse.install.kind",
        "clubhouse.kill.stage_reached",
        "clubhouse.logging.enabled",
        "clubhouse.mcp.result",
        "clubhouse.mcp.tool",
        "clubhouse.mcp.tool_kind",
        "clubhouse.mcp.tools.count_bucket",
        "clubhouse.mcp.tools.empty",
        "clubhouse.orchestrator",
        "clubhouse.outcome",
        "clubhouse.permission.decision",
        "clubhouse.permission.result",
        "clubhouse.persist.action",
        "clubhouse.persist.guard_reason",
        "clubhouse.persist.result",
        "clubhouse.persist.store",
        "clubhouse.plugin.api_version",
        "clubhouse.plugin.id_hash",
        "clubhouse.plugin.origin",
        "clubhouse.plugin.protocol.result",
        "clubhouse.plugin.ref",
        "clubhouse.plugin.scope",
        "clubhouse.popout.type",
        "clubhouse.process",
        "clubhouse.process.type",
        "clubhouse.projects.count",
        "clubhouse.registry.kind",
        "clubhouse.renderer.gone_reason",
        "clubhouse.safe_mode.trigger",
        "clubhouse.search.case_sensitive",
        "clubhouse.search.engine",
        "clubhouse.search.match_count_bucket",
        "clubhouse.search.regex",
        "clubhouse.search.truncated",
        "clubhouse.search.whole_word",
        "clubhouse.settings.key",
        "clubhouse.shutdown.previous",
        "clubhouse.shutdown.step",
        "clubhouse.size_bucket",
        "clubhouse.startup.kind",
        "clubhouse.telemetry.destination",
        "clubhouse.telemetry.signal",
        "clubhouse.theme.builtin_id",
        "clubhouse.theme.kind",
        "clubhouse.tool.bucket",
        "clubhouse.tool.result",
        "clubhouse.tree.hit_cap",
        "clubhouse.tree.node_count_bucket",
        "clubhouse.ui.action",
        "clubhouse.ui.feature",
        "clubhouse.ui.surface",
        "clubhouse.update.apply.mode",
        "clubhouse.update.apply.verified",
        "clubhouse.update.channel",
        "clubhouse.update.from_version",
        "clubhouse.update.phase",
        "clubhouse.update.result",
        "clubhouse.update.trigger",
        "clubhouse.updates.available.count",
        "clubhouse.updates.incompatible.count",
        "clubhouse.view",
        "clubhouse.window.kind",
        "error.type",
        "http.response.status_code",
        "process.exit.code",
      ]
    `);
  });

  it('declares only registry keys as metric dimensions, and never hashes', () => {
    for (const [name, def] of Object.entries(METRICS)) {
      expect(name.startsWith('clubhouse.')).toBe(true);
      for (const key of def.attributes) {
        const spec = getAttributeSpec(key);
        expect(spec, `${name} → ${key}`).toBeDefined();
        expect(spec?.kind).not.toBe('hash');
      }
    }
  });

  it('uses static clubhouse.* names for spans and events', () => {
    for (const name of [...Object.keys(SPANS), ...Object.keys(EVENTS)]) {
      expect(name).toMatch(/^clubhouse\.[a-z_]+(\.[a-z_]+)*$/);
    }
    expect(isKnownSpan('clubhouse.telemetry.test')).toBe(true);
    expect(isKnownMetric('clubhouse.app.sessions')).toBe(true);
    expect(isKnownEvent('clubhouse.telemetry.disabled')).toBe(true);
    expect(isKnownSpan('http.request')).toBe(false);
    expect(isKnownEvent('toString')).toBe(false);
  });

  it('orders levels errors < standard < detailed', () => {
    expect(levelAllows('errors', 'errors')).toBe(true);
    expect(levelAllows('errors', 'standard')).toBe(false);
    expect(levelAllows('standard', 'standard')).toBe(true);
    expect(levelAllows('standard', 'detailed')).toBe(false);
    expect(levelAllows('detailed', 'detailed')).toBe(true);
  });

  it('buckets counts coarsely', () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10_000, NaN].map(countBucket)).toEqual([
      '0', '1-9', '1-9', '10-99', '10-99', '100-999', '100-999', '1000-9999', '1000-9999', '>=10000', '0',
    ]);
  });

  it('declares a span for every user-initiated git operation', () => {
    for (const op of ['checkout', 'stage', 'unstage', 'stage_all', 'unstage_all', 'discard', 'commit', 'push', 'pull',
      'create_branch', 'stash', 'stash_pop', 'diff', 'show_commit', 'worktree_list']) {
      expect(isKnownSpan(`clubhouse.git.${op}`), op).toBe(true);
    }
  });

  it('sends plugin API versions as strings, never truncated', () => {
    expect(ATTR.pluginApiVersion('0.8').value).toBe('0.8');
    expect(ATTR.pluginApiVersion('0.9').value).toBe('0.9');
    expect(ATTR.pluginApiVersion('7.5').value).toBe('other');
  });
});
