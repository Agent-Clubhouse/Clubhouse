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
export const PREVIEW_ONLY_FLAGS = Object.keys(BETA_FLAGS);

export const AGENT_ID = 'durable_stable_mode';
export const AGENT_NAME = 'stable-mode-agent';
export const ORCHESTRATOR = 'claude-code';
export const LAST_SESSION = '11111111-2222-4333-8444-555555555555';
export const CHROME_STORAGE_KEY = 'clubhouse_chrome_v2';
export const SAVED_SIDEBAR_WIDTH = 300;
export const PREVIEW_PAGES = ['Experimental', 'Annex', 'Annex control', 'Goobers'];

/** Preview-gated files a stable launch must not change, byte for byte. */
export const UNTOUCHED_FILES = [
  'experimental-settings.json',
  'chat-runtime-settings.json',
  'dispatcher-settings.json',
  'telemetry-settings.json',
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

export const BETA_TRANSCRIPT = '{"seq":1,"type":"user_message","text":"from a beta"}\n';
