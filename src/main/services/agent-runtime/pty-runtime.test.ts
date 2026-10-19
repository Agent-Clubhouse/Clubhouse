import { describe, it, expect, vi, beforeEach } from 'vitest';

const pty = vi.hoisted(() => ({
  write: vi.fn(), kill: vi.fn(), gracefulKill: vi.fn(), isRunning: vi.fn(() => true), isStopping: vi.fn(() => false), getBuffer: vi.fn(() => 'one\ntwo\nthree'),
}));
vi.mock('../pty-manager', () => pty);
const input = vi.hoisted(() => ({ writeChunkedBracketedPaste: vi.fn(async () => {}), submitAfterPaste: vi.fn(async () => {}), sleep: vi.fn(async () => {}) }));
vi.mock('./pty-input', () => input);
const timing = { initialDelayMs: 1200, retryDelayMs: 400, finalCheckDelayMs: 300, chunkSize: 256, chunkDelayMs: 40, postEndMarkerDelayMs: 200 };
vi.mock('../../orchestrators', () => ({ getProvider: () => ({ getPasteSubmitTiming: () => timing, getExitCommand: () => '/quit\r' }) }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: () => ({ orchestrator: 'copilot-cli', runtime: 'pty', projectPath: '/p' }) } }));
const queue = vi.hoisted(() => ({ resolvePermissionDetailed: vi.fn(() => ({ status: 'resolved' })) }));
vi.mock('../annex-permission-queue', () => queue);

import { PtyAgentRuntime, contentToText } from './pty-runtime';

beforeEach(() => vi.clearAllMocks());

describe('PtyAgentRuntime', () => {
  const rt = new PtyAgentRuntime('a1');

  it('types a single line and submits with provider timing', async () => {
    const result = await rt.sendMessage('hello', { source: 'mcp' });
    expect(pty.write).toHaveBeenCalledWith('a1', 'hello');
    expect(input.writeChunkedBracketedPaste).not.toHaveBeenCalled();
    expect(input.submitAfterPaste).toHaveBeenCalledWith('a1', timing);
    expect(result).toEqual({ delivery: 'prompt' });
  });

  it('pastes multi-line text with chunking and the post-paste delay', async () => {
    await rt.sendMessage('line 1\nline 2', { source: 'shoulder_tap' });
    expect(input.writeChunkedBracketedPaste).toHaveBeenCalledWith('a1', 'line 1\nline 2', 256, 40, 200);
  });

  it('refuses to write into a terminal that is shutting down', async () => {
    pty.isStopping.mockReturnValueOnce(true);
    await expect(rt.sendMessage('hello', { source: 'mcp' })).rejects.toMatchObject({ code: 'agent_stopping' });
    expect(pty.write).not.toHaveBeenCalled();
    expect(input.submitAfterPaste).not.toHaveBeenCalled();
  });

  it('leaves text unsubmitted when submit is false', async () => {
    await rt.sendMessage('draft', { source: 'mcp', submit: false });
    expect(input.submitAfterPaste).not.toHaveBeenCalled();
  });

  it('sends slash commands, interrupts and stops through the terminal', async () => {
    await rt.clearContext();
    await rt.compact();
    await rt.interrupt();
    await rt.stop();
    await rt.stop({ graceful: false });
    expect(pty.write.mock.calls.map((c) => c[1])).toEqual(['/clear', '\r', '/compact', '\r', '\x03']);
    expect(pty.gracefulKill).toHaveBeenCalledWith('a1', '/quit\r');
    expect(pty.kill).toHaveBeenCalledWith('a1');
  });

  it('resolves permissions through the hook queue', async () => {
    await rt.respondPermission('r1', 'allow');
    expect(queue.resolvePermissionDetailed).toHaveBeenCalledWith('r1', 'allow', { expectedAgentId: 'a1', source: 'desktop' });
    queue.resolvePermissionDetailed.mockReturnValueOnce({ status: 'rejected', reason: 'expired' } as never);
    await expect(rt.respondPermission('r2', 'deny')).rejects.toThrow(/expired/);
  });

  it('reads the terminal tail', async () => {
    expect(await rt.readTranscript({ tail: 2 })).toEqual({ kind: 'pty', text: 'two\nthree' });
  });

  it('flattens content blocks for the terminal', () => {
    expect(contentToText([{ type: 'text', text: 'see' }, { type: 'file', path: '/tmp/a.md' }])).toBe('see\n/tmp/a.md');
  });
});
