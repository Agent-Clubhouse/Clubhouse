import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./agent-runtime/chat-media', () => ({ readMedia: vi.fn() }));
vi.mock('./agent-runtime/chat-files', () => ({ readChatFilePreview: vi.fn() }));
import { readMedia } from './agent-runtime/chat-media';
import { readChatFilePreview } from './agent-runtime/chat-files';
import { readMobileChatContent, MOBILE_CONTENT_MAX_BYTES } from './annex-chat-content';
const ref = 'ab'.repeat(32) + '.png';
const query = (s: string) => new URLSearchParams(s);
describe('mobile experimental content boundary', () => {
  beforeEach(() => vi.resetAllMocks());
  it('does not read files when the desktop feature is disabled', async () => {
    await expect(readMobileChatContent(query('path=src/a.ts'), 'agent', () => false)).rejects.toThrow();
    expect(readChatFilePreview).not.toHaveBeenCalled();
  });
  it.each(['mediaRef=../../secret', 'path=x&mediaRef=' + ref, 'path=x&path=y', 'url=https://example.test', 'path='])('rejects invalid request %s', async (input) => {
    await expect(readMobileChatContent(query(input), 'agent', () => true)).rejects.toThrow();
    expect(readMedia).not.toHaveBeenCalled(); expect(readChatFilePreview).not.toHaveBeenCalled();
  });
  it('delegates file containment to the existing desktop preview policy', async () => {
    vi.mocked(readChatFilePreview).mockRejectedValue(new Error('outside roots'));
    await expect(readMobileChatContent(query('path=/private/secret'), 'agent', () => true)).rejects.toThrow('outside roots');
    expect(readChatFilePreview).toHaveBeenCalledWith('agent', '/private/secret');
  });
  it('returns stored image bytes by validated reference only', async () => {
    vi.mocked(readMedia).mockResolvedValue({ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) });
    const result = await readMobileChatContent(query('mediaRef=' + ref), 'agent', () => true);
    expect(result).toMatchObject({ kind: 'image', mimeType: 'image/png', base64: 'AQID' });
  });
  it('caps binary response and never includes oversized bytes', async () => {
    vi.mocked(readMedia).mockResolvedValue({ mimeType: 'image/png', data: new Uint8Array(MOBILE_CONTENT_MAX_BYTES + 1) });
    expect(await readMobileChatContent(query('mediaRef=' + ref), 'agent', () => true)).toMatchObject({ tooLarge: true });
    expect(await readMobileChatContent(query('mediaRef=' + ref), 'agent', () => true)).not.toHaveProperty('base64');
  });
  it('rechecks opt-in after a pending read', async () => {
    let enabled = true;
    vi.mocked(readMedia).mockImplementation(async () => { enabled = false; return { mimeType: 'image/png', data: new Uint8Array([1]) }; });
    await expect(readMobileChatContent(query('mediaRef=' + ref), 'agent', () => enabled)).rejects.toThrow();
  });
});
