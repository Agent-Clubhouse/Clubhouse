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
  answered: number;
}

const fake = vi.hoisted(() => ({ sdks: [] as FakeSdk[] }));

vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../chat/copilot/launch', () => ({
  CopilotLaunchError: class extends Error {},
  launchCopilotServer: vi.fn(() => {
    const sdk = { sends: [] as unknown[], exited: false, answered: 0 } as unknown as FakeSdk;
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
import type { ChatEvent } from '../../../../shared/chat';
import { ChatAgentRuntime } from '../chat-runtime';
import * as permissionQueue from '../../annex-permission-queue';
import { describeChatLifecycleConformance, settle } from './conformance-suite';
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
    answered: () => sdk.answered,
    requestPermission: async (requestId) => {
      void Promise.resolve(sdk.config.permissions.onRequest({ kind: 'shell', toolCallId: `call-${requestId}`, intention: 'Run tests', fullCommandText: 'npm test' }))
        .then(() => { sdk.answered++; });
    },
    // permission.completed is how SDK 2.0.0 reports a request settled elsewhere; the handler is given no request id.
    resolvePermissionNatively: async (requestId) => {
      sdk.config.events.onEvent({ type: 'permission.completed', data: { requestId: `sdk-${requestId}`, toolCallId: `call-${requestId}`, result: { kind: 'denied-interactively-by-user' } } });
    },
    ask: async () => {
      void Promise.resolve(sdk.config.interaction.onUserInputRequest({ question: 'Which?', allowFreeform: true })).then(() => { sdk.answered++; });
    },
    disconnect: async () => { sdk.exit(); },
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
    // SDK 2.0.0 reports requests settled elsewhere as permission.completed / user_input.completed
    // (dist/generated/session-events.d.ts:12805); the driver does not map them yet.
    nativeResolution: true,
    // On CLI exit the driver cancels its open requests and ends its turn ('error'); the SDK reported none of it.
    disconnectClosure: 'local_closure',
  },
  // session.send rejecting does not prove the CLI did not take the prompt.
  canRejectSend: false,
  blocked: {
    permission_closed_by_provider: 'the driver ignores SDK permission.completed (handler gets no request id; toolCallId only)',
    question_closed_by_provider: 'the driver ignores SDK user_input.completed',
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
  permission_closed_by_provider: 'blocked: the driver ignores SDK permission.completed (handler gets no request id; toolCallId only)',
  question_answered_once: 'run',
  question_closed_by_provider: 'blocked: the driver ignores SDK user_input.completed',
  disconnect_outcome_unknown: 'run',
  disconnect_held_input_stays_unsent: 'run',
  disconnect_with_open_requests: 'run',
  send_rejected_not_accepted: 'skipped: no controlled known non-acceptance',
  accepted_submission_fails_later: 'run',
  replaced_session_ignored: 'run',
});

/** Current behavior behind the blocked permission case. */
describe('gap: Copilot permission settled elsewhere (current behavior)', () => {
  it('leaves the request open in Clubhouse after SDK permission.completed for its tool call', async () => {
    const harness = await subject.create();
    const runtime = new ChatAgentRuntime({
      agentId: 'copilot-gap', provider: harness.driver.provider, driverId: harness.driver.id, cwd: 'workspace', level: 'ask', idleTimeoutMs: 0,
      startSession: (resumeNativeSessionId) => harness.driver.start({ agentId: 'copilot-gap', provider: harness.driver.provider, cwd: 'workspace', binaryPath: 'x', level: 'ask', resumeNativeSessionId }),
    });
    const events: ChatEvent[] = [];
    runtime.onEvent((e) => { events.push(e); });
    try {
      await runtime.start();
      await runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
      const native = harness.native();
      await native.requestPermission('p1');
      await vi.waitFor(() => expect(runtime.getState()).toBe('waiting_permission'));
      const request = events.find((e): e is Extract<ChatEvent, { type: 'permission_request' }> => e.type === 'permission_request')!;
      await native.resolvePermissionNatively!('p1');
      await settle();
      expect(events.filter((e) => e.type === 'permission_resolved')).toEqual([]);
      expect(runtime.getPendingPermissionOptions(request.data.requestId)).toBeDefined();
      expect(runtime.getState()).toBe('waiting_permission');
    } finally {
      await runtime.stop();
      permissionQueue.reset();
    }
  });
});

/** A driver's own cancellation on interrupt closes the requests in Clubhouse too. */
describe('Copilot interrupt with an open permission request', () => {
  it('withdraws the request and its options once the driver cancels it', async () => {
    const harness = await subject.create();
    const runtime = new ChatAgentRuntime({
      agentId: 'copilot-interrupt', provider: harness.driver.provider, driverId: harness.driver.id, cwd: 'workspace', level: 'ask', idleTimeoutMs: 0,
      startSession: (resumeNativeSessionId) => harness.driver.start({ agentId: 'copilot-interrupt', provider: harness.driver.provider, cwd: 'workspace', binaryPath: 'x', level: 'ask', resumeNativeSessionId }),
    });
    const events: ChatEvent[] = [];
    runtime.onEvent((e) => { events.push(e); });
    try {
      await runtime.start();
      await runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
      const native = harness.native();
      await native.requestPermission('p1');
      await vi.waitFor(() => expect(runtime.getState()).toBe('waiting_permission'));
      const request = events.find((e): e is Extract<ChatEvent, { type: 'permission_request' }> => e.type === 'permission_request')!;
      await runtime.interrupt();
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(1));
      await settle();
      expect(events.filter((e) => e.type === 'permission_resolved').map((e) => e.data)).toEqual([{ requestId: request.data.requestId, decision: 'cancelled', by: 'agent' }]);
      expect(runtime.getPendingPermissionOptions(request.data.requestId)).toBeUndefined();
      expect(permissionQueue.listPendingForAgent('copilot-interrupt')).toHaveLength(0);
      expect(runtime.getState()).toBe('idle');
    } finally {
      await runtime.stop();
      permissionQueue.reset();
    }
  });
});
