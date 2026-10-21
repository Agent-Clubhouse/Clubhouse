import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHAT_IMAGE_MAX_BYTES, MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';

const paths = vi.hoisted(() => ({ userData: '' }));
const runtime = vi.hoisted(() => ({
  kind: 'chat' as const,
  caps: undefined as unknown,
  sendMessage: vi.fn(async () => ({ delivery: 'prompt', messageId: 'm1' })),
  setModel: vi.fn(async () => {}),
  clearContext: vi.fn(async () => {}),
  compact: vi.fn(async () => {}),
  removeQueued: vi.fn(async (ids?: readonly string[]) => [...(ids ?? ['all'])]),
  getCapabilities: () => runtime.caps,
}));

const windows = vi.hoisted(() => ({ known: new Set<unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => paths.userData },
  BrowserWindow: { fromWebContents: (wc: unknown) => (windows.known.has(wc) ? {} : null) },
}));
vi.mock('../services/agent-runtime', () => ({
  getAgentRuntime: () => runtime,
  isChatAgent: () => true,
  readChatTranscript: vi.fn(),
  listChatSessions: vi.fn(),
  onChatEvent: () => () => {},
  resolveChatDriver: vi.fn(),
}));
vi.mock('../services/agent-runtime/runtime-info', () => ({
  getAgentRuntimeInfo: vi.fn(async () => ({ chat: true, live: false, chatAvailable: true })),
}));
vi.mock('../services/agent-runtime/chat-status-bridge', () => ({ createStatusBridge: () => ({ handle: vi.fn() }) }));
vi.mock('../services/chat-runtime-settings', () => ({ loadSettings: vi.fn(), saveSettings: vi.fn(), resolveRuntimeMode: vi.fn() }));
vi.mock('../services/annex-event-bus', () => ({ emitHookEvent: vi.fn() }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerChatHandlers } from './chat-handlers';
import { listChatSessions, readChatTranscript } from '../services/agent-runtime';
import { clearStagedAttachments } from '../services/agent-runtime/chat-attachments';
import { getAgentRuntimeInfo } from '../services/agent-runtime/runtime-info';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
let handlers: Map<string, Handler>;
let dir: string;
const mainFrame = { name: 'top' };
const appWindow = { mainFrame };
/** An invoke from the top frame of a Clubhouse window, unless overridden. */
const fromWindow = { sender: appWindow, senderFrame: mainFrame };
// Argument validation throws synchronously; async turns that into a rejection.
const callFrom = async (event: unknown, channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
const call = (channel: string, ...args: unknown[]) => callFrom(fromWindow, channel, ...args);

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handlers-'));
  paths.userData = path.join(dir, 'userData');
  runtime.caps = { ...MINIMAL_CHAT_CAPABILITIES, images: true };
  clearStagedAttachments();
  windows.known = new Set([appWindow]);
  handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: Handler) => { handlers.set(channel, handler); }) as never);
  registerChatHandlers();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('chat handlers: attachments', () => {
  it('sends staged attachments as content blocks after the text', async () => {
    const shotPath = path.join(dir, 'shot.png');
    fs.writeFileSync(shotPath, PNG);
    const shot = await call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { path: shotPath, name: 'shot.png' }) as { id: string };
    const pasted = await call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(PNG), name: 'image.png' }) as { id: string };
    await call(IPC.CHAT.SEND_MESSAGE, 'agent-1', 'look', 'auto', [shot.id, pasted.id]);
    expect(runtime.sendMessage).toHaveBeenCalledWith([
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', path: fs.realpathSync.native(shotPath) },
      { type: 'image', mimeType: 'image/png', path: expect.stringContaining('chat-attachments') },
    ], { source: 'user', delivery: 'auto' });
  });

  it('sends attachments without text, but refuses an empty message', async () => {
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(notes, '# notes');
    const staged = await call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { path: notes }) as { id: string };
    await call(IPC.CHAT.SEND_MESSAGE, 'agent-1', '', 'auto', [staged.id]);
    expect(runtime.sendMessage).toHaveBeenCalledWith([{ type: 'file', path: fs.realpathSync.native(notes) }], expect.anything());
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', '  ', 'auto')).rejects.toThrow(/Nothing to send/);
  });

  it('takes only staged ids: no raw blocks, unknown ids or more than 10', async () => {
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', 'x', 'auto', [{ type: 'image', mimeType: 'image/png', path: '/etc/passwd' }])).rejects.toThrow();
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', 'x', 'auto', ['not-staged'])).rejects.toThrow(/expired/);
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', 'x', 'auto', Array.from({ length: 11 }, (_, i) => `id-${i}`))).rejects.toThrow(/at most 10/);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses images until the runtime reports images: true', async () => {
    runtime.caps = undefined;
    const pasted = await call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(PNG) }) as { id: string };
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', 'x', 'auto', [pasted.id])).rejects.toThrow(/can't take images/);
  });

  it('stages only from the top frame of a Clubhouse window', async () => {
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(notes, 'x');
    await expect(callFrom({ sender: appWindow, senderFrame: { name: 'iframe' } }, IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { path: notes }))
      .rejects.toThrow(/Clubhouse window/);
    const webview = { mainFrame: {} };
    await expect(callFrom({ sender: webview, senderFrame: webview.mainFrame }, IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { path: notes }))
      .rejects.toThrow(/Clubhouse window/);
  });

  it('caps pasted bytes before staging, and saves nothing for a paste the agent cannot take', async () => {
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1) })).rejects.toThrow(/3.75 MB/);
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(PNG), imagesAllowed: false })).rejects.toThrow(/can't take pasted images/);
    expect(fs.existsSync(path.join(paths.userData, 'chat-attachments'))).toBe(false);
  });

  it('rejects staging without a path or image bytes, and pasted bytes that are not an image', async () => {
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { name: 'x' })).rejects.toThrow(/file path or image data/);
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(Buffer.from('#!/bin/sh')) })).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { path: dir })).rejects.toThrow(/only files/);
  });
});

describe('chat handlers: set model (#2136)', () => {
  it('passes a level, an omitted effort (keep) and null (default) through as they are', async () => {
    await call(IPC.CHAT.SET_MODEL, 'agent-1', 'opus', 'high');
    await call(IPC.CHAT.SET_MODEL, 'agent-1', 'opus');
    await call(IPC.CHAT.SET_MODEL, 'agent-1', 'opus', null);
    expect(runtime.setModel.mock.calls).toEqual([['opus', 'high'], ['opus', undefined], ['opus', null]]);
  });

  it('rejects an effort that is not a string or null', async () => {
    await expect(call(IPC.CHAT.SET_MODEL, 'agent-1', 'opus', 3)).rejects.toThrow();
    await expect(call(IPC.CHAT.SET_MODEL, 'agent-1', 'opus', '')).rejects.toThrow();
    expect(runtime.setModel).not.toHaveBeenCalled();
  });
});


describe('chat handlers: queue editing (#2413)', () => {
  it('removes queued messages by id, or all of them with no ids', async () => {
    await expect(call(IPC.CHAT.REMOVE_QUEUED, 'agent-1', ['q1', 'q2'])).resolves.toEqual(['q1', 'q2']);
    await call(IPC.CHAT.REMOVE_QUEUED, 'agent-1');
    expect(runtime.removeQueued.mock.calls).toEqual([[['q1', 'q2']], [undefined]]);
  });

  it('rejects ids that are not non-empty strings', async () => {
    await expect(call(IPC.CHAT.REMOVE_QUEUED, 'agent-1', [''])).rejects.toThrow();
    await expect(call(IPC.CHAT.REMOVE_QUEUED, 'agent-1', 'q1')).rejects.toThrow();
    expect(runtime.removeQueued).not.toHaveBeenCalled();
  });
});

describe('chat session commands', () => {
  it('preserves the driver compact busy guard through sendMessage', async () => {
    runtime.sendMessage.mockRejectedValueOnce(new Error('Finish or stop the current turn before running /compact'));
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', '/compact', 'auto')).rejects.toThrow('before running /compact');
    expect(runtime.sendMessage).toHaveBeenCalledWith([{ type: 'text', text: '/compact' }], { source: 'user', delivery: 'auto' });
    expect(runtime.compact).not.toHaveBeenCalled();
  });
  it.each(['/clear', ' /clear \n'])('routes bare %s to the runtime', async (command) => {
    await expect(call(IPC.CHAT.SEND_MESSAGE, 'agent-1', command, 'auto')).resolves.toEqual({ delivery: 'prompt' });
    expect(runtime.clearContext).toHaveBeenCalledOnce();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['/compact', ' /compact \n', '/clear please', 'explain /clear', '/compact focus on tests'])('keeps %s as a message', async (text) => {
    await call(IPC.CHAT.SEND_MESSAGE, 'agent-1', text, 'auto');
    expect(runtime.sendMessage).toHaveBeenCalled();
    expect(runtime.clearContext).not.toHaveBeenCalled();
    expect(runtime.compact).not.toHaveBeenCalled();
  });
  it('does not drop attachments on a command-shaped message', async () => {
    const staged = await call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(PNG), name: 'image.png' }) as { id: string };
    await call(IPC.CHAT.SEND_MESSAGE, 'agent-1', '/clear', 'auto', [staged.id]);
    expect(runtime.sendMessage).toHaveBeenCalled();
    expect(runtime.clearContext).not.toHaveBeenCalled();
  });
});


describe('chat session history IPC', () => {
  it('passes an explicit session and tail through for saved history', async () => {
    await call(IPC.CHAT.READ_TRANSCRIPT, 'agent-1', 500, 'earlier-session');
    expect(readChatTranscript).toHaveBeenCalledWith('agent-1', { tail: 500, sessionId: 'earlier-session' });
  });
  it('leaves the session unspecified for the current conversation', async () => {
    await call(IPC.CHAT.READ_TRANSCRIPT, 'agent-1');
    expect(readChatTranscript).toHaveBeenCalledWith('agent-1', { tail: undefined, sessionId: undefined });
  });
  it('lists saved Clubhouse sessions', async () => {
    await call(IPC.CHAT.LIST_SESSIONS, 'agent-1');
    expect(listChatSessions).toHaveBeenCalledWith('agent-1');
  });
});

describe('chat handlers: agent runtime (#2206)', () => {
  it('passes the project path and starting flag through', async () => {
    const info = await call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1', 'github-copilot', { projectPath: '/work/proj', starting: true });
    expect(info).toEqual({ chat: true, live: false, chatAvailable: true });
    expect(getAgentRuntimeInfo).toHaveBeenCalledWith('agent-1', 'github-copilot', { projectPath: '/work/proj', starting: true });
  });

  it('still takes the older agent-id-only and agent-id-plus-provider calls', async () => {
    await call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1');
    await call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1', 'claude-code');
    expect(getAgentRuntimeInfo).toHaveBeenNthCalledWith(1, 'agent-1', undefined, undefined);
    expect(getAgentRuntimeInfo).toHaveBeenNthCalledWith(2, 'agent-1', 'claude-code', undefined);
  });

  it('refuses a malformed query', async () => {
    await expect(call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1', 'claude-code', 'nope')).rejects.toThrow();
    await expect(call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1', 'claude-code', { projectPath: 42 })).rejects.toThrow(/projectPath/);
    await expect(call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1', 'claude-code', { projectPath: 'x'.repeat(5000) })).rejects.toThrow(/projectPath/);
    await expect(call(IPC.CHAT.GET_AGENT_RUNTIME, 'agent-1', 'claude-code', { starting: 'yes' })).rejects.toThrow(/starting/);
    expect(getAgentRuntimeInfo).not.toHaveBeenCalled();
  });
});
