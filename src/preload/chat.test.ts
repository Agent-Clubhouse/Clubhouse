import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), path: vi.fn(() => '/controller/private.png') }));
vi.mock('electron', () => ({ ipcRenderer: { invoke: mocks.invoke }, webUtils: { getPathForFile: mocks.path } }));
import { chat } from './chat';
import { IPC } from '../shared/ipc-channels';
import { CHAT_IMAGE_MAX_BYTES } from '../shared/chat';
const id = 'remote||host||agent';
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const file = (size = bytes.length) => ({ name: 'shot.png', size, arrayBuffer: vi.fn(async () => bytes.buffer) } as unknown as File);
beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockResolvedValue({ id: 'opaque' }); });
describe('remote image File staging', () => {
  it('uploads only bytes even for a disk File, without asking for its controller path', async () => {
    await chat.chat.stageAttachment(id, file(), { imagesAllowed: true });
    expect(mocks.path).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.CHAT.STAGE_ATTACHMENT, id, { data: bytes, name: 'shot.png', imagesAllowed: true });
  });
  it.each([0, CHAT_IMAGE_MAX_BYTES + 1])('refuses invalid size %s before reading bytes or invoking', async (size) => {
    const f = file(size);
    await expect(chat.chat.stageAttachment(id, f, { imagesAllowed: true })).rejects.toThrow();
    expect(f.arrayBuffer).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.path).not.toHaveBeenCalled();
  });
  it.each(['remote||broken', 'remote||||a', 'remote||host||'])('refuses malformed namespace without local fallback: %s', async (bad) => {
    await expect(chat.chat.stageAttachment(bad, file(), { imagesAllowed: true })).rejects.toThrow();
    expect(mocks.path).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('requires the runtime image capability before file access', async () => {
    const f = file();
    await expect(chat.chat.stageAttachment(id, f, { imagesAllowed: false })).rejects.toThrow("can't take images");
    expect(f.arrayBuffer).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('retains the genuine File path flow for a local agent', async () => {
    await chat.chat.stageAttachment('local', file());
    expect(mocks.path).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.CHAT.STAGE_ATTACHMENT, 'local', { path: '/controller/private.png', name: 'shot.png' });
  });
});
