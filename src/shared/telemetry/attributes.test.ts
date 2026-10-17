import { describe, expect, it } from 'vitest';
import {
  ATTR,
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
  agentResume: { good: ATTR.agentResume(true), key: 'clubhouse.agent.resume' },
  usesWorktree: { good: ATTR.usesWorktree(false), key: 'clubhouse.agent.uses_worktree' },
  mcpEnabled: { good: ATTR.mcpEnabled(true), key: 'clubhouse.mcp.enabled' },
  hooksEnabled: { good: ATTR.hooksEnabled(true), key: 'clubhouse.hooks.enabled' },
  profileActive: { good: ATTR.profileActive(false), key: 'clubhouse.profile.active' },
  wrapperApplied: { good: ATTR.wrapperApplied(true), key: 'clubhouse.wrapper.applied' },
  modelFamily: { good: ATTR.modelFamily('sonnet'), key: 'clubhouse.model.family' },
  killTrigger: { good: ATTR.killTrigger('agent_tool'), key: 'clubhouse.kill.trigger' },
  deleteMode: { good: ATTR.deleteMode('save_patch'), key: 'clubhouse.agent.delete.mode' },
  tapBroadcast: { good: ATTR.tapBroadcast(true), key: 'clubhouse.tap.broadcast' },
  targetsCount: { good: ATTR.targetsCount(3), key: 'clubhouse.targets.count' },
  deliveryResult: { good: ATTR.deliveryResult('unsupported_runtime'), key: 'clubhouse.delivery.result' },
  annexRole: { good: ATTR.annexRole('satellite'), key: 'clubhouse.annex.role' },
  annexTls: { good: ATTR.annexTls(false), key: 'clubhouse.annex.tls' },
  annexAuthMode: { good: ATTR.annexAuthMode('bearer'), key: 'clubhouse.annex.auth_mode' },
  annexClientKind: { good: ATTR.annexClientKind('mobile'), key: 'clubhouse.annex.client.kind' },
  addrFamily: { good: ATTR.addrFamily('ipv6'), key: 'clubhouse.net.addr_family' },
  annexPairResult: { good: ATTR.annexPairResult('invalid_pin'), key: 'clubhouse.annex.pair.result' },
  annexDisconnectReason: { good: ATTR.annexDisconnectReason('heartbeat_timeout'), key: 'clubhouse.annex.disconnect.reason' },
  attemptBucket: { good: ATTR.attemptBucket('3-5'), key: 'clubhouse.attempt_bucket' },
  annexEventType: { good: ATTR.annexEventType('pty:data'), key: 'clubhouse.annex.event.type' },
  annexRemoteAction: { good: ATTR.annexRemoteAction('wake'), key: 'clubhouse.annex.remote.action' },
  annexControlChannel: { good: ATTR.annexControlChannel('rest'), key: 'clubhouse.annex.control.channel' },
  annexReplayResult: { good: ATTR.annexReplayResult('gap'), key: 'clubhouse.annex.replay.result' },
  identityRegenReason: { good: ATTR.identityRegenReason('corrupt'), key: 'clubhouse.annex.identity.reason' },
  annexRoute: { good: ATTR.annexRoute('GET /api/v1/agents/:id/buffer'), key: 'clubhouse.annex.route' },
  ipcChannel: { good: ATTR.ipcChannel('project:list'), key: 'clubhouse.ipc.channel' },
  goobersDaemonState: { good: ATTR.goobersDaemonState('not-running'), key: 'clubhouse.goobers.state' },
  goobersConnection: { good: ATTR.goobersConnection('degraded'), key: 'clubhouse.goobers.connection' },
  goobersError: { good: ATTR.goobersError('auth-required'), key: 'clubhouse.goobers.error' },
  goobersStreamMode: { good: ATTR.goobersStreamMode('polling'), key: 'clubhouse.goobers.stream.mode' },
  goobersModel: { good: ATTR.goobersModel('run'), key: 'clubhouse.goobers.model' },
  sseTerminalReason: { good: ATTR.sseTerminalReason('schema-changed'), key: 'clubhouse.sse.terminal_reason' },
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
        "clubhouse.agent.delete.mode",
        "clubhouse.agent.exit.class",
        "clubhouse.agent.id_hash",
        "clubhouse.agent.kind",
        "clubhouse.agent.resume",
        "clubhouse.agent.runtime",
        "clubhouse.agent.uses_worktree",
        "clubhouse.annex.auth_mode",
        "clubhouse.annex.client",
        "clubhouse.annex.client.kind",
        "clubhouse.annex.control.channel",
        "clubhouse.annex.disconnect.reason",
        "clubhouse.annex.event.type",
        "clubhouse.annex.identity.reason",
        "clubhouse.annex.pair.result",
        "clubhouse.annex.remote.action",
        "clubhouse.annex.replay.result",
        "clubhouse.annex.role",
        "clubhouse.annex.route",
        "clubhouse.annex.server",
        "clubhouse.annex.tls",
        "clubhouse.attempt_bucket",
        "clubhouse.binary.lookup_tier",
        "clubhouse.blocked.flow",
        "clubhouse.child_process.gone_reason",
        "clubhouse.child_process.type",
        "clubhouse.clubhouse_mode",
        "clubhouse.delivery.result",
        "clubhouse.error.boundary",
        "clubhouse.exception.handled",
        "clubhouse.exception.origin",
        "clubhouse.goobers.connection",
        "clubhouse.goobers.error",
        "clubhouse.goobers.model",
        "clubhouse.goobers.state",
        "clubhouse.goobers.stream.mode",
        "clubhouse.hook.kind",
        "clubhouse.hooks.enabled",
        "clubhouse.http.class",
        "clubhouse.install.kind",
        "clubhouse.ipc.channel",
        "clubhouse.kill.stage_reached",
        "clubhouse.kill.trigger",
        "clubhouse.logging.enabled",
        "clubhouse.mcp.enabled",
        "clubhouse.mcp.result",
        "clubhouse.mcp.tool",
        "clubhouse.mcp.tool_kind",
        "clubhouse.model.family",
        "clubhouse.net.addr_family",
        "clubhouse.orchestrator",
        "clubhouse.outcome",
        "clubhouse.permission.decision",
        "clubhouse.permission.result",
        "clubhouse.persist.action",
        "clubhouse.persist.guard_reason",
        "clubhouse.persist.result",
        "clubhouse.persist.store",
        "clubhouse.process",
        "clubhouse.process.type",
        "clubhouse.profile.active",
        "clubhouse.projects.count",
        "clubhouse.renderer.gone_reason",
        "clubhouse.safe_mode.trigger",
        "clubhouse.shutdown.previous",
        "clubhouse.shutdown.step",
        "clubhouse.size_bucket",
        "clubhouse.sse.terminal_reason",
        "clubhouse.startup.kind",
        "clubhouse.tap.broadcast",
        "clubhouse.targets.count",
        "clubhouse.telemetry.destination",
        "clubhouse.telemetry.signal",
        "clubhouse.theme.kind",
        "clubhouse.tool.bucket",
        "clubhouse.tool.result",
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
        "clubhouse.view",
        "clubhouse.window.kind",
        "clubhouse.wrapper.applied",
        "error.type",
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
});
