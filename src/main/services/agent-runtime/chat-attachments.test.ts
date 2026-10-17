import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatCapabilities } from '../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import { attachmentsDir, prepareAttachments, SAVED_ATTACHMENT_TTL_MS } from './chat-attachments';

const withImages: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, images: true };
const noImages: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, images: false };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attach-'));
  paths.userData = path.join(dir, 'userData');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('prepareAttachments', () => {
  it('saves a pasted image to a file so the transcript records a path', async () => {
    const [block] = await prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }], withImages);
    expect(block).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const saved = (block as { path: string }).path;
    expect(saved.startsWith(attachmentsDir('agent-1'))).toBe(true);
    expect(saved.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(saved).equals(PNG)).toBe(true);
    expect(block).not.toHaveProperty('data');
  });

  it('keeps an image on disk as its path', async () => {
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, PNG);
    expect(await prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/png', path: file }], withImages))
      .toEqual([{ type: 'image', mimeType: 'image/png', path: file }]);
  });

  it('passes files through as paths', async () => {
    const file = path.join(dir, 'notes.md');
    fs.writeFileSync(file, '# notes\n');
    expect(await prepareAttachments('agent-1', [{ type: 'file', path: file }], noImages)).toEqual([{ type: 'file', path: file }]);
  });

  it('refuses images when the driver cannot take them', async () => {
    await expect(prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }], noImages))
      .rejects.toThrow(/can't take images/);
  });

  it('refuses unsupported image types and oversized images', async () => {
    await expect(prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/tiff', data: 'AAAA' }], withImages))
      .rejects.toThrow(/PNG, JPEG, GIF or WebP/);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    await expect(prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/png', data: big }], withImages))
      .rejects.toThrow(/5 MB/);
  });

  it('refuses relative paths, missing files and directories posing as images', async () => {
    await expect(prepareAttachments('agent-1', [{ type: 'file', path: 'relative/notes.md' }], withImages)).rejects.toThrow(/absolute/);
    await expect(prepareAttachments('agent-1', [{ type: 'file', path: path.join(dir, 'gone.md') }], withImages)).rejects.toThrow(/no longer exists/);
    await expect(prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/png', path: dir }], withImages)).rejects.toThrow(/isn't a file/);
  });

  it('refuses other block types and too many attachments', async () => {
    await expect(prepareAttachments('agent-1', [{ type: 'resource', uri: 'https://example.com' }], withImages)).rejects.toThrow(/images or files/);
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'a');
    await expect(prepareAttachments('agent-1', Array.from({ length: 11 }, () => ({ type: 'file', path: file })), withImages))
      .rejects.toThrow(/at most 10/);
  });

  it('deletes saved images older than the retention window when saving a new one', async () => {
    const folder = attachmentsDir('agent-1');
    fs.mkdirSync(folder, { recursive: true });
    const old = path.join(folder, 'old.png');
    fs.writeFileSync(old, PNG);
    const past = (Date.now() - SAVED_ATTACHMENT_TTL_MS - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    await prepareAttachments('agent-1', [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }], withImages);
    expect(fs.existsSync(old)).toBe(false);
  });
});
