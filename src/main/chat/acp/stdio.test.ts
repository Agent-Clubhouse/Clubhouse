import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import { createAcpChatDriver } from './driver';

const AGENT = path.join(__dirname, 'testing', 'stdio-agent.mjs');

// A real child process over stdio; the agent script is the only fake part.
const driver = createAcpChatDriver({
  id: 'acp_neutral_test' as ChatDriverId,
  provider: 'acp-test',
  args: () => [AGENT],
});

async function collect(events: AsyncIterable<ChatEventDraft>, until: (d: ChatEventDraft) => boolean): Promise<ChatEventDraft[]> {
  const out: ChatEventDraft[] = [];
  for await (const draft of events) {
    out.push(draft);
    if (until(draft)) break;
  }
  return out;
}

describe('ACP over stdio', () => {
  it('probes, runs a turn with lines split across writes, and closes the process', async () => {
    expect(await driver.probe(process.execPath)).toMatchObject({ handshakeOk: true, cliVersion: '0.0.0-test' });
    const session = await driver.start({ agentId: 'a', provider: 'acp-test', cwd: __dirname, binaryPath: process.execPath, level: 'ask' });
    expect(session.nativeSessionId).toBe('stdio-1');
    await session.send([{ type: 'text', text: 'hello' }], 'prompt');
    const drafts = await collect(session.events, (d) => d.type === 'turn_ended');
    expect(drafts.filter((d) => d.type === 'agent_message_chunk').map((d) => (d.data as { text: string }).text)).toEqual(['he', 'llo']);
    await session.close();
  }, 20_000);

  it('reports an exit mid-turn without inventing the turn outcome', async () => {
    const session = await driver.start({ agentId: 'a', provider: 'acp-test', cwd: __dirname, binaryPath: process.execPath, level: 'ask' });
    await session.send([{ type: 'text', text: 'exit:3' }], 'prompt');
    const drafts = await collect(session.events, () => false);
    expect(drafts.map((d) => d.type)).toEqual(['session_info', 'turn_started', 'error']);
    expect(drafts[2].data).toMatchObject({ code: 'process_exited', fatal: true, message: expect.stringContaining('code 3') });
  }, 20_000);

  it('ends the session when the agent stops reading stdin: no false acceptance, nothing left pending, no resend', async () => {
    const session = await driver.start({ agentId: 'a', provider: 'acp-test', cwd: __dirname, binaryPath: process.execPath, level: 'ask' });
    await session.send([{ type: 'text', text: 'stop-reading' }], 'prompt');
    const drafts: ChatEventDraft[] = [];
    const ended = (async () => { for await (const d of session.events) drafts.push(d); })();
    await vi.waitFor(() => expect(drafts.some((d) => d.type === 'agent_message_chunk')).toBe(true), { timeout: 5_000 });
    // The agent's stdin is closed while it still runs. session/cancel hits the closed pipe.
    await session.interrupt();
    await ended;
    expect(drafts.map((d) => d.type)).toEqual(['session_info', 'turn_started', 'agent_message_chunk', 'error']);
    expect(drafts[3].data).toMatchObject({ code: 'process_exited', fatal: true, message: expect.stringContaining('unknown') });
    // Not accepted and not resent: a later send is refused locally.
    await expect(session.send([{ type: 'text', text: 'again' }], 'prompt')).rejects.toThrow(/not open/);
    await session.close();
  }, 20_000);

  it('reports a binary that cannot start', async () => {
    const probe = await driver.probe(path.join(__dirname, 'no-such-agent-binary'));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'spawn_failed' });
  }, 20_000);
});
