import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatDriverId, ChatEvent } from '../../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const bridge = vi.hoisted(() => ({ runtime: undefined as ChatAgentRuntime | undefined, events: [] as ChatEvent[], handlers: new Map<string, Handler>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: Handler) => bridge.handlers.set(name, fn) }, app: { getPath: () => '/synthetic-no-read', isPackaged: false } }));
vi.mock('../../../../main/services/agent-runtime', () => ({ getAgentRuntime: () => bridge.runtime, onChatEvent: () => () => {}, readChatTranscript: vi.fn(), listChatSessions: vi.fn() }));
vi.mock('../../../../main/services/agent-runtime/chat-transcript', () => ({ appendChatEvent: async (e: ChatEvent) => { bridge.events.push(e); }, readChatTranscript: async () => [] }));
vi.mock('../../../../main/services/agent-runtime/checkpoint-tracker', () => ({ isRevertRunning: async () => false }));
vi.mock('../../../../main/services/agent-runtime/chat-status-bridge', () => ({ createStatusBridge: () => ({ handle: vi.fn() }) }));
vi.mock('../../../../main/services/agent-runtime/handshake-retry', () => ({ retryAgentHandshake: vi.fn() }));
vi.mock('../../../../main/services/agent-runtime/runtime-info', () => ({ getAgentRuntimeInfo: vi.fn() }));
const preferences = vi.hoisted(() => ({ flags: {} as Record<string, boolean>, saved: {} as Record<string, unknown> }));
vi.mock('../../../../main/services/settings-store', () => ({ createSettingsStore: () => ({ get: () => preferences.saved, save: vi.fn() }) }));
vi.mock('../../../../main/services/preview-eligible', () => ({ isPreviewEligible: () => true }));
vi.mock('../../../../main/services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../../main/util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../main/services/experimental-settings', () => ({ getSettings: () => preferences.flags, isGraduatedFeatureOn: (key: string) => key === 'chat' }));
import { resolveRuntimeMode } from '../../../../main/services/chat-runtime-settings';
import { ExperimentalSettingsView } from '../../../features/settings/ExperimentalSettingsView';
import { registerChatHandlers } from '../../../../main/ipc/chat-handlers';
import { ChatAgentRuntime } from '../../../../main/services/agent-runtime/chat-runtime';
import { FakeChatDriver } from '../../../../main/services/agent-runtime/fake-chat-driver';
import { CopilotSdkChatDriver } from '../../../../main/chat/copilot/driver';
import { fakeCopilotEnv } from '../../../../main/chat/copilot/test-env';
import { buildChatScript, writeChatScript } from '../../../../main/orchestrators/adapters/testing/chat-script';
import { createFakeCli, writeFakeCliShims } from '../../../../main/orchestrators/adapters/testing/fake-cli';
import { _resetHelperDeliveryForTesting, deliverHelperUpdate, flushHelperUpdates } from '../../../../main/services/clubhouse-mcp/tools/helper-delivery';
import { coalesceUpdateTexts } from '../../../../shared/chat';
import { IPC } from '../../../../shared/ipc-channels';
import { foldChatEvents, useChatStore } from '../../../stores/chatStore';
import { ChatViewBody } from './ChatView';
import { useChatDraftStore, type ChatActions } from './useChatSession';

const agent: Agent = { id: 'steering-fixture', projectId: 'p', name: 'fixture', kind: 'durable', status: 'running', color: 'blue' };
const runtimes: ChatAgentRuntime[] = [];
beforeEach(() => {
  bridge.events = [];
  preferences.flags = {}; preferences.saved = {};
  bridge.handlers.clear();
  useChatDraftStore.setState({ drafts: {}, attachments: {} });
  registerChatHandlers();
  window.clubhouse.chat.sendMessage = (id, text, delivery) => bridge.handlers.get(IPC.CHAT.SEND_MESSAGE)!({}, id, text, delivery) as ReturnType<typeof window.clubhouse.chat.sendMessage>;
  window.clubhouse.chat.interrupt = (id) => bridge.handlers.get(IPC.CHAT.INTERRUPT)!({}, id) as Promise<void>;
});
afterEach(async () => { cleanup(); for (const runtime of runtimes.splice(0)) await runtime.stop(); });

/** A session from a build that still had the legacy ACP driver (#2868): its transcript can still be on disk. */
const OLD_ACP_DRIVER = 'copilot_acp' as ChatDriverId;

async function running(steer: boolean, resumed = false) {
  const driver = new FakeChatDriver(steer ? 'copilot_sdk' : OLD_ACP_DRIVER, 'copilot-cli', { ...MINIMAL_CHAT_CAPABILITIES, steer, interrupt: true, queue: 'client' });
  const runtime = new ChatAgentRuntime({ agentId: agent.id, provider: 'copilot-cli', driverId: driver.id, cwd: '/synthetic', level: 'ask', idleTimeoutMs: 0, resumeNativeSessionId: resumed ? 'synthetic-resume' : undefined,
    startSession: (resumeNativeSessionId) => driver.start({ agentId: agent.id, provider: 'copilot-cli', cwd: '/synthetic', binaryPath: '/never-executed', level: 'ask', resumeNativeSessionId }),
  });
  runtimes.push(runtime);
  bridge.runtime = runtime;
  await runtime.start();
  driver.last.emit({ type: 'turn_started', turnId: 't1', data: { trigger: 'prompt' } });
  await waitFor(() => expect(bridge.events.some((e) => e.type === 'turn_started')).toBe(true));
  const operations: string[] = [];
  const send = driver.last.send.bind(driver.last);
  vi.spyOn(driver.last, 'send').mockImplementation(async (content, delivery) => { operations.push(`send:${delivery}`); return send(content, delivery); });
  vi.spyOn(driver.last, 'interrupt').mockImplementation(async () => {
    operations.push('interrupt');
    driver.last.emit({ type: 'turn_ended', turnId: 't1', data: { stopReason: 'cancelled' } });
  });
  const actions: ChatActions = {
    send: (text, delivery) => useChatStore.getState().send(agent.id, text, delivery),
    interrupt: async () => { await useChatStore.getState().interrupt(agent.id); return true; },
    respondPermission: vi.fn(), answerQuestion: vi.fn(), setLevel: vi.fn(),
  };
  const state = foldChatEvents(undefined, agent.id, bridge.events);
  const view = render(<ChatViewBody agent={agent} state={state} actions={actions} providerName="Copilot" />);
  return { runtime, driver, operations, view, actions, state };
}

describe('Copilot composer through renderer store, real IPC handlers and runtime (fake driver only)', () => {
  // The steerless sessions below stand for a transcript left by the removed ACP driver, or any driver without steer.
  it.each(['copilot_sdk', 'copilot_acp', undefined])('every session is SDK whatever an older build saved (%s), and Experimental has no ACP switch', async (legacy) => {
    preferences.saved = legacy ? { 'copilot-cli': { mode: 'chat', driver: legacy } } : {};
    preferences.flags = { copilotLegacyAcp: true, copilotSdk: false };
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => preferences.flags);
    expect(resolveRuntimeMode('copilot-cli').driver).toBe('copilot_sdk');
    const session = await running(resolveRuntimeMode('copilot-cli').driver === 'copilot_sdk');
    expect(session.state.driver).toBe('copilot_sdk');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    render(<ExperimentalSettingsView />);
    await screen.findByRole('switch', { name: 'Goobers' });
    expect(screen.queryByRole('switch', { name: /Copilot ACP/ })).not.toBeInTheDocument();
    expect(preferences.saved).toEqual(legacy ? { 'copilot-cli': { mode: 'chat', driver: legacy } } : {});
  });

  it.each(['click', 'Enter'] as const)('Stop & send on a driver that cannot steer interrupts before the next send via %s', async (input) => {
    const { operations } = await running(false);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'synthetic message' } });
    if (input === 'click') fireEvent.click(screen.getByTestId('chat-send-primary'));
    else fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(operations).toEqual(['interrupt', 'send:prompt']));
  });

  it.each([false, true])('SDK active capabilities select Steer and never interrupt (resume=%s)', async (resume) => {
    const { operations } = await running(true, resume);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'synthetic steer' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(operations).toEqual(['send:steer']));
  });

  it('new SDK session replaces old ACP capabilities, including transcript rehydration', async () => {
    const old = await running(false);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    // A preference/flag is not a session event. Re-rendering the existing
    // active state cannot convert its driver or promise a new capability.
    old.view.rerender(<ChatViewBody agent={agent} state={{ ...old.state }} actions={old.actions} providerName="Copilot SDK selected for next start" />);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    old.view.unmount();
    await old.runtime.stop();
    const current = await running(true, true);
    expect(current.state.driver).toBe('copilot_sdk');
    expect(current.state.capabilities?.steer).toBe(true);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    const replay = foldChatEvents(undefined, agent.id, bridge.events);
    current.view.rerender(<ChatViewBody agent={agent} state={replay} actions={current.actions} providerName="Copilot" />);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'after reconnect' } });
    fireEvent.click(screen.getByTestId('chat-send-primary'));
    await waitFor(() => expect(current.operations).toEqual(['send:steer']));
  });

  it('buffers SDK start during old ACP hydration and rejects late ACP capability metadata', async () => {
    const old = await running(false);
    const oldEvents = [...bridge.events];
    old.view.unmount();
    await old.runtime.stop();
    const current = await running(true);
    const currentEvents = bridge.events.filter((e) => e.sessionId === current.state.sessionId);
    useChatStore.getState().reset(agent.id);
    let resolveRead!: (events: ChatEvent[]) => void;
    window.clubhouse.chat.readTranscript = vi.fn(() => new Promise<ChatEvent[]>((resolve) => { resolveRead = resolve; }));
    const loading = useChatStore.getState().loadTranscript(agent.id);
    for (const event of currentEvents) useChatStore.getState().applyEvent(event);
    resolveRead(oldEvents);
    await loading;
    const restored = useChatStore.getState().agents[agent.id];
    expect(restored.driver).toBe('copilot_sdk');
    expect(restored.capabilities?.steer).toBe(true);
    const lastOld = oldEvents.at(-1)!;
    useChatStore.getState().applyEvent({ ...lastOld, seq: lastOld.seq + 100, ts: Date.now() + 100,
      type: 'session_info', data: { capabilities: { steer: false, interrupt: true } },
    });
    expect(useChatStore.getState().agents[agent.id].capabilities?.steer).toBe(true);
    act(() => current.view.rerender(<ChatViewBody agent={agent} state={restored} actions={current.actions} providerName="Copilot" />));
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
  });

  it('helper auto delivery steers on SDK without interrupting', async () => {
    const { runtime, operations } = await running(true);
    expect(await runtime.sendMessage('synthetic helper', { source: 'mcp' })).toMatchObject({ delivery: 'steer' });
    expect(operations).toEqual(['send:steer']);
  });

  it('helper auto delivery queues on a session that cannot steer without cancelling it', async () => {
    const { runtime, operations } = await running(false);
    expect(await runtime.sendMessage('synthetic helper', { source: 'mcp' })).toMatchObject({ delivery: 'queued' });
    expect(operations).toEqual([]);
  });
});

describe('Copilot helper steering through the SDK and fake CLI', () => {
  it.each([false, true])('a helper burst is one MCP steer; waiting for the held tool keeps its bubble separate (wait=%s)', async (waitForTool) => {
    const dir = await fs.promises.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), 'copilot-helper-steer-'));
    const originalEnv = process.env;
    const updates = Array.from({ length: 10 }, (_, i) => `[FROM HELPER:helper-${i + 1} (durable_${i + 1})] Step ${i + 1} done.`);
    const userSteer = 'Use tabs, not spaces.';
    const { fixture } = await writeChatScript(dir, 'helpers', buildChatScript('copilot', {
      description: 'a user steer and a merged helper burst during a held turn',
      turns: [{ prompt: 'Start.', steps: [{ type: 'text', text: 'Working.' }], end: 'held', steers: [{ text: userSteer }, { text: coalesceUpdateTexts(updates) }] }],
    }));
    const fake = await createFakeCli(fixture);
    let runtime: ChatAgentRuntime | undefined;
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    try {
      process.env = fakeCopilotEnv(originalEnv, dir);
      const shims = await writeFakeCliShims(path.join(dir, 'bin'), { copilot: { fixture, report: fake.reportPath } });
      const session = await new CopilotSdkChatDriver().start({
        agentId: agent.id, provider: 'copilot-cli', cwd: dir, binaryPath: shims.copilot, level: 'ask',
        env: { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:0/v1', COPILOT_MODEL: 'fake-model' },
      });
      const events = session.events;
      // Pin the schedule where running is visible but the held command has not arrived yet.
      vi.spyOn(session, 'events', 'get').mockReturnValue({
        async *[Symbol.asyncIterator]() {
          for await (const event of events) {
            if (event.type === 'tool_call') await toolGate;
            yield event;
          }
        },
      });
      runtime = new ChatAgentRuntime({
        agentId: agent.id, provider: 'copilot-cli', driverId: 'copilot_sdk', cwd: dir, level: 'ask', idleTimeoutMs: 0,
        startSession: async () => session,
      });
      bridge.runtime = runtime;
      await runtime.start();
      await runtime.sendMessage('Start.', { source: 'user' });
      await waitFor(() => expect(runtime!.getState()).toBe('running'));
      expect(bridge.events.some((event) => event.type === 'tool_call')).toBe(false);
      if (waitForTool) {
        releaseTool();
        await waitFor(() => expect(bridge.events.some((event) => event.type === 'tool_call')).toBe(true));
      }
      expect(await runtime.sendMessage(userSteer, { source: 'user' })).toMatchObject({ delivery: 'steer' });
      releaseTool();
      await waitFor(() => expect(bridge.events.some((event) => event.type === 'tool_call')).toBe(true));

      const deliveries = updates.map((text) => deliverHelperUpdate(agent.id, text));
      await flushHelperUpdates(agent.id);
      expect(await Promise.all(deliveries)).toEqual(Array(10).fill('delivered'));
      const steers = bridge.events.filter((event) => event.type === 'user_message' && event.data.delivery === 'steer');
      expect(steers.map((event) => event.type === 'user_message' && [event.data.source, event.data.content])).toEqual([
        ['user', [{ type: 'text', text: userSteer }]],
        ['mcp', [{ type: 'text', text: coalesceUpdateTexts(updates) }]],
      ]);
      const state = foldChatEvents(undefined, agent.id, bridge.events);
      const view = render(<ChatViewBody agent={agent} state={state} actions={{ send: vi.fn(), interrupt: vi.fn(), respondPermission: vi.fn(), answerQuestion: vi.fn(), setLevel: vi.fn() }} providerName="Copilot" />);
      expect(view.container.querySelectorAll('[data-testid="chat-user-message"][data-delivery="steer"][data-source="user"]')).toHaveLength(1);
      expect(view.container.querySelectorAll('[data-testid="chat-user-message"][data-delivery="steer"][data-source="mcp"]')).toHaveLength(waitForTool ? 1 : 0);
      if (!waitForTool) {
        expect(screen.getByTestId('chat-group-toggle')).toHaveTextContent('10 messages');
        fireEvent.click(screen.getByTestId('chat-group-toggle'));
      }
      const helperBubble = view.container.querySelector('[data-testid="chat-user-message"][data-delivery="steer"][data-source="mcp"]');
      expect(helperBubble).not.toBeNull();
      for (let i = 1; i <= 10; i++) expect(helperBubble).toHaveTextContent(`Step ${i} done.`);
      expect(helperBubble).not.toHaveTextContent('[FROM HELPER');
      expect(helperBubble).not.toHaveTextContent(userSteer);
      await runtime.interrupt();
      const report = await fake.waitForReport((r) => r.complete || r.mismatch !== null);
      expect(report).toMatchObject({ complete: true, mismatch: null, unexpected: [] });
    } finally {
      releaseTool();
      _resetHelperDeliveryForTesting();
      await runtime?.stop();
      await fake.dispose();
      process.env = originalEnv;
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
