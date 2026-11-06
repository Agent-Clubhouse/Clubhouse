import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatEvent } from '../../../../shared/chat';
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

async function running(steer: boolean, resumed = false) {
  const driver = new FakeChatDriver(steer ? 'copilot_sdk' : 'copilot_acp', 'copilot-cli', { ...MINIMAL_CHAT_CAPABILITIES, steer, interrupt: true, queue: 'client' });
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
  it.each(['copilot_sdk', 'copilot_acp'])('the single toggle selects successive sessions despite legacy %s, leaving an existing session unchanged', async (legacy) => {
    preferences.saved = { 'copilot-cli': { mode: 'chat', driver: legacy } };
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => preferences.flags);
    window.clubhouse.app.saveExperimentalSettings = vi.fn(async (next) => { preferences.flags = next; });
    const old = await running(resolveRuntimeMode('copilot-cli').driver === 'copilot_sdk');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    const settings = render(<ExperimentalSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Use legacy Copilot ACP' });
    fireEvent.click(toggle);
    await waitFor(() => expect(resolveRuntimeMode('copilot-cli').driver).toBe('copilot_acp'));
    expect(old.driver.id).toBe('copilot_sdk');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    old.view.unmount();
    const first = await running(resolveRuntimeMode('copilot-cli').driver === 'copilot_sdk');
    expect(first.state.driver).toBe('copilot_acp');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    first.view.unmount();
    const second = await running(resolveRuntimeMode('copilot-cli').driver === 'copilot_sdk');
    expect(second.state.capabilities?.steer).toBe(false);
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    fireEvent.click(toggle);
    await waitFor(() => expect(resolveRuntimeMode('copilot-cli').driver).toBe('copilot_sdk'));
    expect(second.driver.id).toBe('copilot_acp');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    second.view.unmount(); settings.unmount();
    const last = await running(resolveRuntimeMode('copilot-cli').driver === 'copilot_sdk');
    expect(last.state.driver).toBe('copilot_sdk');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    expect(preferences.saved).toEqual({ 'copilot-cli': { mode: 'chat', driver: legacy } });
  });

  it.each(['click', 'Enter'] as const)('Stop & send actually interrupts before the next send via %s', async (input) => {
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

  it('helper auto delivery queues on a steerless active session without cancelling it', async () => {
    const { runtime, operations } = await running(false);
    expect(await runtime.sendMessage('synthetic helper', { source: 'mcp' })).toMatchObject({ delivery: 'queued' });
    expect(operations).toEqual([]);
  });
});
