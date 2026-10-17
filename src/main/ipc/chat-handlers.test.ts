import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';

const paths = vi.hoisted(() => ({ userData: '' }));
const runtime = vi.hoisted(() => ({
  kind: 'chat' as const,
  caps: undefined as unknown,
  sendMessage: vi.fn(async () => ({ delivery: 'prompt', messageId: 'm1' })),
  getCapabilities: () => runtime.caps,
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => paths.userData } }));
vi.mock('../services/agent-runtime', () => ({
  getAgentRuntime: () => runtime,
  isChatAgent: () => true,
  readChatTranscript: vi.fn(),
  onChatEvent: () => () => {},
  resolveChatDriver: vi.fn(),
}));
vi.mock('../services/agent-runtime/chat-status-bridge', () => ({ createStatusBridge: () => ({ handle: vi.fn() }) }));
vi.mock('../services/chat-runtime-settings', () => ({ loadSettings: vi.fn(), saveSettings: vi.fn(), resolveRuntimeMode: vi.fn() }));
vi.mock('../services/annex-event-bus', () => ({ emitHookEvent: vi.fn() }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerChatHandlers } from './chat-handlers';
import { clearStagedAttachments } from '../services/agent-runtime/chat-attachments';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
let handlers: Map<string, Handler>;
let dir: string;
// Argument validation throws synchronously; async turns that into a rejection.
const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handlers-'));
  paths.userData = path.join(dir, 'userData');
  runtime.caps = { ...MINIMAL_CHAT_CAPABILITIES, images: true };
  clearStagedAttachments();
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

  it('rejects staging without a path or image bytes, and pasted bytes that are not an image', async () => {
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { name: 'x' })).rejects.toThrow(/file path or image data/);
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { data: new Uint8Array(Buffer.from('#!/bin/sh')) })).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
    await expect(call(IPC.CHAT.STAGE_ATTACHMENT, 'agent-1', { path: dir })).rejects.toThrow(/only files/);
  });
});
