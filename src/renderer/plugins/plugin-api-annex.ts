import type { PluginContext, AnnexAPI, Disposable } from '../../shared/plugin-types';

export function createAnnexAPI(ctx: PluginContext): AnnexAPI {
  return {
    // ── Discovery & connection ─────────────────────────────────────────
    getSatellites() {
      return window.clubhouse.annexClient.getSatellites() as ReturnType<AnnexAPI['getSatellites']>;
    },
    scan() {
      return window.clubhouse.annexClient.scan();
    },
    connect(fingerprint, bearerToken) {
      return window.clubhouse.annexClient.connect(fingerprint, bearerToken);
    },
    disconnect(fingerprint) {
      return window.clubhouse.annexClient.disconnect(fingerprint);
    },
    retry(fingerprint) {
      return window.clubhouse.annexClient.retry(fingerprint);
    },
    getDiscovered() {
      return window.clubhouse.annexClient.getDiscovered() as ReturnType<AnnexAPI['getDiscovered']>;
    },
    pairWith(fingerprint, pin) {
      return window.clubhouse.annexClient.pairWith(fingerprint, pin);
    },
    forgetSatellite(fingerprint) {
      return window.clubhouse.annexClient.forgetSatellite(fingerprint);
    },
    forgetAllSatellites() {
      return window.clubhouse.annexClient.forgetAllSatellites();
    },

    // ── Remote agents ──────────────────────────────────────────────────
    agentSpawn(satelliteId, params) {
      return window.clubhouse.annexClient.agentSpawn(satelliteId, params);
    },
    agentKill(satelliteId, agentId) {
      return window.clubhouse.annexClient.agentKill(satelliteId, agentId);
    },
    agentWake(satelliteId, agentId, opts) {
      return window.clubhouse.annexClient.agentWake(satelliteId, agentId, opts);
    },
    agentCreateDurable(satelliteId, projectId, params) {
      return window.clubhouse.annexClient.agentCreateDurable(satelliteId, projectId, params);
    },
    agentDeleteDurable(satelliteId, projectId, agentId, mode) {
      return window.clubhouse.annexClient.agentDeleteDurable(satelliteId, projectId, agentId, mode);
    },
    agentWorktreeStatus(satelliteId, projectId, agentId) {
      return window.clubhouse.annexClient.agentWorktreeStatus(satelliteId, projectId, agentId);
    },
    agentReorder(satelliteId, projectId, orderedIds) {
      return window.clubhouse.annexClient.agentReorder(satelliteId, projectId, orderedIds);
    },

    // ── Remote PTY ────────────────────────────────────────────────────
    ptyInput(satelliteId, sessionId, data) {
      return window.clubhouse.annexClient.ptyInput(satelliteId, sessionId, data);
    },
    ptyResize(satelliteId, sessionId, cols, rows) {
      return window.clubhouse.annexClient.ptyResize(satelliteId, sessionId, cols, rows);
    },
    ptySpawnShell(satelliteId, sessionId, projectId) {
      return window.clubhouse.annexClient.ptySpawnShell(satelliteId, sessionId, projectId);
    },
    ptyGetBuffer(satelliteId, sessionId) {
      return window.clubhouse.annexClient.ptyGetBuffer(satelliteId, sessionId);
    },
    clipboardImage(satelliteId, agentId, base64, mimeType) {
      return window.clubhouse.annexClient.clipboardImage(satelliteId, agentId, base64, mimeType);
    },

    // ── Remote files & git ────────────────────────────────────────────
    fileTree(satelliteId, projectId, opts) {
      return window.clubhouse.annexClient.fileTree(satelliteId, projectId, opts);
    },
    fileRead(satelliteId, projectId, path) {
      return window.clubhouse.annexClient.fileRead(satelliteId, projectId, path);
    },
    gitOperation(satelliteId, projectId, params) {
      return window.clubhouse.annexClient.gitOperation(satelliteId, projectId, params);
    },

    // ── Remote canvas ─────────────────────────────────────────────────
    canvasMutation(satelliteId, projectId, canvasId, scope, mutation) {
      return window.clubhouse.annexClient.canvasMutation(satelliteId, projectId, canvasId, scope, mutation);
    },

    // ── Remote sessions ───────────────────────────────────────────────
    sessionList(satelliteId, agentId, projectId, orchestrator) {
      return window.clubhouse.annexClient.sessionList(satelliteId, agentId, projectId, orchestrator);
    },
    sessionTranscript(satelliteId, agentId, sessionId, projectId, offset, limit, orchestrator) {
      return window.clubhouse.annexClient.sessionTranscript(satelliteId, agentId, sessionId, projectId, offset, limit, orchestrator);
    },
    sessionSummary(satelliteId, agentId, sessionId, projectId, orchestrator) {
      return window.clubhouse.annexClient.sessionSummary(satelliteId, agentId, sessionId, projectId, orchestrator);
    },

    // ── Remote group projects ─────────────────────────────────────────
    gpGet(satelliteId, groupProjectId) {
      return window.clubhouse.annexClient.gpGet(satelliteId, groupProjectId);
    },
    gpUpdate(satelliteId, groupProjectId, fields) {
      return window.clubhouse.annexClient.gpUpdate(satelliteId, groupProjectId, fields);
    },
    gpBulletinDigest(satelliteId, groupProjectId, since) {
      return window.clubhouse.annexClient.gpBulletinDigest(satelliteId, groupProjectId, since);
    },
    gpBulletinTopic(satelliteId, groupProjectId, topic, since, limit) {
      return window.clubhouse.annexClient.gpBulletinTopic(satelliteId, groupProjectId, topic, since, limit);
    },
    gpBulletinAll(satelliteId, groupProjectId, since, limit) {
      return window.clubhouse.annexClient.gpBulletinAll(satelliteId, groupProjectId, since, limit);
    },
    gpBulletinPost(satelliteId, groupProjectId, sender, topic, body) {
      return window.clubhouse.annexClient.gpBulletinPost(satelliteId, groupProjectId, sender, topic, body);
    },
    gpShoulderTap(satelliteId, groupProjectId, targetAgentId, message, sender) {
      return window.clubhouse.annexClient.gpShoulderTap(satelliteId, groupProjectId, targetAgentId, message, sender);
    },
    gpDeleteMessage(satelliteId, groupProjectId, topic, messageId) {
      return window.clubhouse.annexClient.gpDeleteMessage(satelliteId, groupProjectId, topic, messageId);
    },
    gpDeleteTopic(satelliteId, groupProjectId, topic) {
      return window.clubhouse.annexClient.gpDeleteTopic(satelliteId, groupProjectId, topic);
    },
    gpSetTopicProtection(satelliteId, groupProjectId, topic, isProtected) {
      return window.clubhouse.annexClient.gpSetTopicProtection(satelliteId, groupProjectId, topic, isProtected);
    },
    gpInjectMessage(satelliteId, agentId, message) {
      return window.clubhouse.annexClient.gpInjectMessage(satelliteId, agentId, message);
    },
    gpSetPolling(satelliteId, groupProjectId, enabled) {
      return window.clubhouse.annexClient.gpSetPolling(satelliteId, groupProjectId, enabled);
    },

    // ── Events ────────────────────────────────────────────────────────
    onSatellitesChanged(callback) {
      const cleanup = window.clubhouse.annexClient.onSatellitesChanged(callback as (sats: unknown[]) => void);
      const disposable: Disposable = { dispose: cleanup };
      ctx.subscriptions.push(disposable);
      return disposable;
    },
    onDiscoveredChanged(callback) {
      const cleanup = window.clubhouse.annexClient.onDiscoveredChanged(callback as (services: unknown[]) => void);
      const disposable: Disposable = { dispose: cleanup };
      ctx.subscriptions.push(disposable);
      return disposable;
    },
    onSatelliteEvent(callback) {
      const cleanup = window.clubhouse.annexClient.onSatelliteEvent(callback);
      const disposable: Disposable = { dispose: cleanup };
      ctx.subscriptions.push(disposable);
      return disposable;
    },
  };
}
