/**
 * The real CopilotSdkChatDriver through the lifecycle conformance suite. The
 * SDK module and the CLI launch are mocked at the same seam
 * src/main/chat/copilot/driver-mocked.test.ts uses: no CLI, socket, model or
 * real SDK starts. The test plays the SDK side: session events through
 * `events.onEvent`, permission and question callbacks, `abort()` answering
 * with an aborted idle, and the CLI process exiting. The driver opens a turn
 * itself when it sends from idle; the SDK reports when the turn goes idle.
 */
import { describe, expect, it, vi } from 'vitest';

type SdkConfig = {
  events: { onEvent: (event: { type: string; data: Record<string, unknown> }) => void };
  permissions: { onRequest: (request: Record<string, unknown>) => unknown };
  interaction: { onUserInputRequest: (request: Record<string, unknown>) => unknown };
};

interface FakeSdk {
  config: SdkConfig;
  sends: unknown[];
  exit: () => void;
  exited: boolean;
  failNext: boolean;
}

const fake = vi.hoisted(() => ({ sdks: [] as FakeSdk[] }));

vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../chat/copilot/launch', () => ({
  CopilotLaunchError: class extends Error {},
  launchCopilotServer: vi.fn(() => {
    const sdk = { sends: [] as unknown[], exited: false, failNext: false } as unknown as FakeSdk;
    fake.sdks.push(sdk);
    const exited = new Promise<void>((resolve) => { sdk.exit = () => { sdk.exited = true; resolve(); }; });
    return { host: '127.0.0.1', port: 12345, connectionToken: 'fake', exited, kill: async () => sdk.exit(), stderrTail: () => '', exitCode: () => (sdk.exited ? 1 : null) };
  }),
}));
vi.mock('../../../chat/copilot/sdk-loader', () => ({
  loadCopilotSdk: async () => ({
    RuntimeConnection: { forTcp: (host: string, port: number) => ({ kind: 'tcp', host, port }) },
    CopilotClient: class {
      start = async () => {};
      getStatus = async () => ({ version: 'fixture' });
      getAuthStatus = async () => ({ isAuthenticated: true });
      listModels = async (): Promise<unknown[]> => [];
      stop = async () => {};
      forceStop = async () => {};
      createSession = async (config: SdkConfig) => sessionFor(config);
      resumeSession = async (_id: string, config: SdkConfig) => sessionFor(config);
    },
  }),
}));

function sessionFor(config: SdkConfig) {
  const sdk = fake.sdks[fake.sdks.length - 1];
  sdk.config = config;
  return {
    sessionId: `fake-session-${fake.sdks.length}`,
    send: async (message: unknown) => {
      if (sdk.exited) throw new Error('Connection closed');
      sdk.sends.push(message);
      if (sdk.failNext) {
        sdk.failNext = false;
        throw new Error('send failed after hand-off');
      }
      return `message-${sdk.sends.length}`;
    },
    abort: async () => {
      config.events.onEvent({ type: 'abort', data: {} });
      config.events.onEvent({ type: 'session.idle', data: { aborted: true } });
    },
    rpc: { mode: { set: async () => {} }, model: { getCurrent: async () => ({ modelId: 'fake' }) }, commands: { list: async () => ({ commands: [] as unknown[] }) } },
    disconnect: async () => {},
  };
}

import { CopilotSdkChatDriver } from '../../../chat/copilot/driver';
import { describeChatLifecycleConformance, observeHeldInputOnDisconnect } from './conformance-suite';
import type { ConformanceSubject, NativeControl } from './types';

function control(sdk: FakeSdk): NativeControl {
  return {
    received: () => sdk.sends.length,
    // The driver already opened the turn when it sent from idle.
    beginTurn: async () => undefined,
    endTurn: async (stopReason) => {
      if (stopReason === 'end_turn') sdk.config.events.onEvent({ type: 'session.idle', data: {} });
      else if (stopReason === 'cancelled') sdk.config.events.onEvent({ type: 'session.idle', data: { aborted: true } });
      else sdk.config.events.onEvent({ type: 'session.error', data: { errorType: 'query', message: 'turn failed' } });
    },
    requestPermission: async () => { void sdk.config.permissions.onRequest({ kind: 'shell', intention: 'Run tests', fullCommandText: 'npm test' }); },
    ask: async () => { void sdk.config.interaction.onUserInputRequest({ question: 'Which?', allowFreeform: true }); },
    disconnect: async () => { sdk.exit(); },
    failNextSend: () => { sdk.failNext = true; },
  };
}

const subject: ConformanceSubject = {
  name: 'Copilot SDK driver (mocked SDK and launch)',
  traits: {
    // A prompt while the driver's turn runs goes to the SDK as 'immediate' and is reported as a steer.
    mergesPrompts: true,
    steersRunningTurn: true,
    interruptReport: 'provider_reports',
    permissions: true,
    questions: true,
    // The SDK has no callback for the CLI withdrawing a request; the driver settles them itself.
    nativeResolution: false,
    // On CLI exit the driver cancels its open requests and ends its turn ('error'); the SDK reported none of it.
    disconnectClosure: 'local_closure',
  },
  canFailSend: true,
  blocked: {
    disconnect_held_input_stays_unsent: 'the driver\'s turn_ended on CLI exit drains held input into the exited session',
  },
  create: async () => ({
    driver: new CopilotSdkChatDriver(),
    native: () => {
      const sdk = fake.sdks[fake.sdks.length - 1];
      if (!sdk?.config) throw new Error('No Copilot session started');
      return control(sdk);
    },
  }),
};

describeChatLifecycleConformance(subject, {
  prompt_settles_once: 'run',
  between_turns_prompt: 'run',
  steer_joins_running_turn: 'run',
  merged_submissions_leave_no_debt: 'run',
  client_queue_drains_once: 'run',
  interrupt_settles_as_reported: 'run',
  interrupt_unreported_stays_open: 'skipped: provider reports interrupts',
  permission_answered_once: 'run',
  permission_closed_by_provider: 'skipped: provider cannot close requests',
  question_answered_once: 'run',
  question_closed_by_provider: 'skipped: provider cannot close questions',
  disconnect_outcome_unknown: 'run',
  disconnect_held_input_stays_unsent: 'blocked: the driver\'s turn_ended on CLI exit drains held input into the exited session',
  disconnect_with_open_requests: 'run',
  send_failure_not_retried: 'run',
  replaced_session_ignored: 'run',
});

/** Current behavior behind the blocked case: the driver ends its turn locally on CLI exit; the runtime drains the held item into the exited session, whose send fails. */
describe('gap: Copilot held input on disconnect (current behavior)', () => {
  it('dispatches the held item after the local turn end instead of dropping it unsent', async () => {
    // Dropped only after a failed send into the exited session, with a send-failure notice.
    expect(await observeHeldInputOnDisconnect(subject)).toEqual({
      received: 1, settled: ['dropped'], statuses: ['queued', 'dispatching', 'failed'],
      notices: ['copilot_sdk_active', 'queued_send_failed'], turnEnded: ['error'], running: false,
    });
  });
});
