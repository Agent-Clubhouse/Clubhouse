import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatDriver, ChatEvent } from '../../../shared/chat';

// The same flows e2e/chat-fake-cli.spec.ts drives through the UI, one layer
// down: ChatAgentRuntime (what the app runs a chat agent in) over each real
// ChatDriver, spawning the fake CLI through a PATH-style shim exactly as the
// app would find it. The fake CLI fails on any message the fixture doesn't
// expect, so these pass only if the driver's real traffic for "send, stream,
// approve, Stop" is what the E2E fixtures replay.

const transcript: ChatEvent[] = [];
vi.mock('./chat-transcript', () => ({
  appendChatEvent: vi.fn(async (e: ChatEvent) => { transcript.push(e); }),
  readChatTranscript: vi.fn(async () => [...transcript]),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { ChatAgentRuntime } from './chat-runtime';
import { removeAllChatEventListeners } from './chat-event-bus';
import * as permissionQueue from '../annex-permission-queue';
import { ClaudeChatDriver } from '../../chat/claude';
import { CodexChatDriver } from '../../orchestrators/adapters/codex-chat-driver';
import { createCopilotAcpChatDriver } from '../../orchestrators/adapters/acp-chat-driver';
import {
  chatFixturePath,
  writeFakeCliShims,
  type ChatFixtureCli,
  type FakeCliReport,
} from '../../orchestrators/adapters/testing/fake-cli';

interface Provider {
  cli: ChatFixtureCli;
  provider: string;
  driver: () => ChatDriver;
}

const PROVIDERS: Provider[] = [
  // The fixtures are stream-json; the E2E pins Claude to this transport too.
  { cli: 'claude', provider: 'claude-code', driver: () => new ClaudeChatDriver('claude_stream_json') },
  { cli: 'codex', provider: 'codex-cli', driver: () => new CodexChatDriver() },
  { cli: 'copilot', provider: 'copilot-cli', driver: () => createCopilotAcpChatDriver() },
];

let tmp: string;
let runtime: ChatAgentRuntime | undefined;

beforeEach(async () => {
  transcript.length = 0;
  removeAllChatEventListeners();
  permissionQueue.reset();
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-flows-'));
});

afterEach(async () => {
  await runtime?.stop().catch(() => undefined);
  runtime = undefined;
  // Windows: a fake that was just stopped can hold its files for a moment.
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function startRuntime(p: Provider, fixture: string) {
  const report = path.join(tmp, 'report.json');
  const shims = await writeFakeCliShims(path.join(tmp, 'bin'), {
    [p.cli]: { fixture: chatFixturePath(p.cli, fixture), report },
  });
  const cwd = path.join(tmp, 'project');
  await fs.promises.mkdir(cwd);
  const driver = p.driver();
  runtime = new ChatAgentRuntime({
    agentId: 'agent-1',
    provider: p.provider,
    driverId: driver.id,
    cwd,
    level: 'ask',
    idleTimeoutMs: 0,
    startSession: (resumeId) => driver.start({
      agentId: 'agent-1', provider: p.provider, cwd, binaryPath: shims[p.cli], level: 'ask', resumeNativeSessionId: resumeId,
    }),
  });
  await runtime.start();
  const readReport = async (): Promise<FakeCliReport> => JSON.parse(await fs.promises.readFile(report, 'utf8'));
  return { runtime, readReport };
}

/** Resolves once the transcript has `count` events of `type`. */
async function waitForEvent<T extends ChatEvent['type']>(type: T, count = 1): Promise<Extract<ChatEvent, { type: T }>> {
  let found: Extract<ChatEvent, { type: T }>[] = [];
  await vi.waitFor(() => {
    found = transcript.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type);
    expect(found.length).toBeGreaterThanOrEqual(count);
  }, { timeout: 10_000, interval: 10 });
  return found[count - 1];
}

async function expectFixtureComplete(readReport: () => Promise<FakeCliReport>): Promise<void> {
  await vi.waitFor(async () => {
    const r = await readReport();
    expect(r.mismatch).toBeNull();
    expect(r.complete).toBe(true);
  }, { timeout: 10_000, interval: 20 });
}

describe.each(PROVIDERS)('$cli chat over the fake CLI (the E2E flows)', (p) => {
  it('multi-turn: two sends stream replies and each turn ends', async () => {
    const { runtime, readReport } = await startRuntime(p, 'multi-turn');

    await runtime.sendMessage('First prompt', { source: 'user' });
    await waitForEvent('turn_ended', 1);
    expect(transcript.some((e) => e.type === 'agent_message_chunk' || e.type === 'agent_message')).toBe(true);

    await runtime.sendMessage('Second prompt', { source: 'user' });
    await waitForEvent('turn_ended', 2);

    await expectFixtureComplete(readReport);
    expect(transcript.filter((e) => e.type === 'turn_ended').map((e) => e.data.stopReason)).toEqual(['end_turn', 'end_turn']);
  });

  it('permission: the allow_once option approves the edit and the turn finishes', async () => {
    const { runtime, readReport } = await startRuntime(p, 'permission-approve-edit');

    await runtime.sendMessage('Make the edit', { source: 'user' });
    const request = await waitForEvent('permission_request');
    // The approval dock's primary button is the allow_once option.
    const allow = request.data.options.find((o) => o.kind === 'allow_once');
    expect(allow).toBeDefined();
    await runtime.respondPermission(request.data.requestId, allow!.optionId);

    await waitForEvent('turn_ended');
    await expectFixtureComplete(readReport);
    expect((await waitForEvent('permission_resolved')).data).toMatchObject({ decision: 'allow' });
  });

  it('interrupt: Stop cancels the running turn', async () => {
    const { runtime, readReport } = await startRuntime(p, 'interrupt');

    await runtime.sendMessage('Run the long command', { source: 'user' });
    await waitForEvent('tool_call');
    await runtime.interrupt();

    const ended = await waitForEvent('turn_ended');
    await expectFixtureComplete(readReport);
    expect(ended.data.stopReason).toBe('cancelled');
    expect(transcript.filter((e) => e.type === 'session_state').map((e) => e.data.state)).toEqual(['idle', 'running', 'idle']);
  });
});
