/**
 * The saved state a beta leaves behind, for checking stable mode. Used by
 * e2e/stable-mode.spec.ts, which runs an unpackaged build with a test seam, and
 * scripts/ci/stable-candidate.mjs, which runs a packaged one.
 *
 * Plain .mjs with no Playwright imports, so both can load it.
 */
import * as path from 'path';

export const BETA_FLAGS = {
  newChrome: true,
  goobers: true,
  chat: true,
  richChatContent: true,
  copilotSdk: true,
  telemetry: true,
};
/** Left Experimental for v1.0.0, so a stable build reads them as saved. */
export const GRADUATED_FLAGS = ['newChrome', 'chat', 'richChatContent', 'telemetry'];
export const PREVIEW_ONLY_FLAGS = Object.keys(BETA_FLAGS).filter((flag) => !GRADUATED_FLAGS.includes(flag));

export const AGENT_ID = 'durable_stable_mode';
export const AGENT_NAME = 'stable-mode-agent';
export const ORCHESTRATOR = 'claude-code';
export const LAST_SESSION = '11111111-2222-4333-8444-555555555555';
export const CHROME_STORAGE_KEY = 'clubhouse_chrome_v2';
export const SAVED_SIDEBAR_WIDTH = 300;
/** Settings pages every build lists, Preview or not: Annex is stable (#2811). */
export const ANNEX_PAGES = ['Annex Network'];
/** Settings pages listed only with Preview on. Goobers also needs its saved flag. */
export const PREVIEW_PAGES = ['Experimental', 'Goobers'];

/** Preview-gated files a stable launch must not change, byte for byte. */
export const UNTOUCHED_FILES = [
  'experimental-settings.json',
  'chat-runtime-settings.json',
  'dispatcher-settings.json',
  path.join('agent-logs', 'chat', AGENT_ID, `${LAST_SESSION}.jsonl`),
];

export const updateSettings = (previewChannel) => ({
  'update-settings.json': { autoUpdate: false, previewChannel, lastCheck: null, dismissedVersion: null, lastSeenVersion: null },
});

/** What a beta user with everything on has saved, apart from the flags. */
export function betaFiles(previewChannel) {
  return {
    ...updateSettings(previewChannel),
    // The provider is installed (the stand-in), so no first-run CLI probe.
    'orchestrator-settings.json': { enabled: [ORCHESTRATOR], autoDetected: true },
    'chat-runtime-settings.json': { [ORCHESTRATOR]: { mode: 'chat', driver: 'claude_stream_json' } },
    'dispatcher-settings.json': { enabled: true },
    // Consent recorded and an address saved, with nothing switched on, so nothing exports with Preview on either.
    // A launch with Preview off migrates this file (spec §6.8), so it isn't in UNTOUCHED_FILES.
    'telemetry-settings.json': {
      consentVersion: 1,
      sampleRate: 1,
      destinations: [
        { id: 'azure', kind: 'azure', enabled: false, level: 'standard', preset: 'all' },
        { id: 'otlp', kind: 'otlp', enabled: false, level: 'standard', preset: 'all', otlp: { endpoint: 'http://127.0.0.1:9/', headerNames: [], temporality: 'cumulative' } },
      ],
    },
  };
}

/** One agent saved in Chat mode, with a session to resume. Goes in a repo's .clubhouse/agents.json. */
export function betaAgents() {
  return [{
    id: AGENT_ID,
    name: AGENT_NAME,
    color: 'emerald',
    createdAt: new Date().toISOString(),
    orchestrator: ORCHESTRATOR,
    runtimeMode: 'chat',
    lastSessionId: LAST_SESSION,
  }];
}

/** The agent a stable user has: nothing saved for its runtime. */
export function stableAgents(extra = {}) {
  const [{ runtimeMode: _saved, ...agent }] = betaAgents();
  return [{ ...agent, ...extra }];
}

/** What a stable 0.42 user has saved: a provider, and no Chat flag or choice. */
export function stableFiles() {
  return {
    ...updateSettings(false),
    'orchestrator-settings.json': { enabled: [ORCHESTRATOR], autoDetected: true },
  };
}

/** What 0.41 could leave behind: the Structured Mode flag and its per-agent field, which 0.42 has no equivalent for. */
export const V041_FLAGS = { structuredMode: true, themeGradients: true };
export const v041Agents = () => stableAgents({ structuredMode: true });

/** The one-time Chat tip's localStorage markers (chat-default-tip.ts). */
export const CHAT_MESSAGE_SHOWN_KEY = 'chatMessageShown';
export const CHAT_TIP_RULED_OUT_KEY = 'clubhouse_chat_default_tip';

export const BETA_TRANSCRIPT = '{"seq":1,"type":"user_message","text":"from a beta"}\n';
