import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatCapabilities } from '../../../shared/chat';
import { CHAT_FILE_MAX_BYTES, CHAT_IMAGE_MAX_BYTES, MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import {
  attachmentsDir,
  clearStagedAttachments,
  resolveAttachments,
  SAVED_ATTACHMENT_TTL_MS,
  sniffImage,
  stageAttachmentData,
  stageAttachmentPath,
} from './chat-attachments';

const withImages: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, images: true };
const noImages: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, images: false };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
function file(name: string, data: Buffer | string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return fs.realpathSync.native(p);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attach-'));
  paths.userData = path.join(dir, 'userData');
  clearStagedAttachments();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sniffImage', () => {
  it('recognises PNG, JPEG, GIF and WebP by their bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('not an image'))).toBeUndefined();
  });
});

describe('staging', () => {
  it('stages a dropped image by its bytes and never returns the path', async () => {
    const shot = file('shot.png', PNG);
    const staged = await stageAttachmentPath('agent-1', shot, 'shot.png');
    expect(staged).toEqual({ id: expect.any(String), name: 'shot.png', kind: 'image', mimeType: 'image/png', size: PNG.length, pasted: false });
    expect(JSON.stringify(staged)).not.toContain(dir);
    expect(await resolveAttachments('agent-1', [staged.id], withImages)).toEqual([{ type: 'image', mimeType: 'image/png', path: shot }]);
  });

  it('treats a mislabelled image as the file it really is', async () => {
    const fake = file('secret.png', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    const staged = await stageAttachmentPath('agent-1', fake);
    expect(staged.kind).toBe('file');
    expect(await resolveAttachments('agent-1', [staged.id], withImages)).toEqual([{ type: 'file', path: fake }]);
  });

  it('rejects directories, relative paths and missing files', async () => {
    await expect(stageAttachmentPath('agent-1', dir)).rejects.toThrow(/only files/);
    await expect(stageAttachmentPath('agent-1', 'notes.md')).rejects.toThrow(/absolute/);
    await expect(stageAttachmentPath('agent-1', path.join(dir, 'gone.md'))).rejects.toThrow(/no longer exists/);
  });

  posixOnly('resolves symlinks to the real file and rejects links to directories', async () => {
    const real = file('real.md', '# real\n');
    fs.symlinkSync(real, path.join(dir, 'link.md'));
    const staged = await stageAttachmentPath('agent-1', path.join(dir, 'link.md'));
    expect(await resolveAttachments('agent-1', [staged.id], withImages)).toEqual([{ type: 'file', path: real }]);
    fs.symlinkSync(os.homedir(), path.join(dir, 'home'));
    await expect(stageAttachmentPath('agent-1', path.join(dir, 'home'))).rejects.toThrow(/only files/);
  });

  posixOnly('refuses a staged file that was swapped for a link afterwards', async () => {
    const notes = file('notes.md', '# notes\n');
    const staged = await stageAttachmentPath('agent-1', notes);
    fs.rmSync(notes);
    fs.symlinkSync(file('other.md', 'other'), notes);
    await expect(resolveAttachments('agent-1', [staged.id], withImages)).rejects.toThrow(/moved or was deleted/);
  });

  it('caps sizes: big images go as files, files over 20 MB are refused', async () => {
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(CHAT_IMAGE_MAX_BYTES)]));
    expect((await stageAttachmentPath('agent-1', big)).kind).toBe('file');
    const huge = path.join(dir, 'huge.bin');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, CHAT_FILE_MAX_BYTES + 1);
    await expect(stageAttachmentPath('agent-1', huge)).rejects.toThrow(/20 MB/);
  });

  it('saves pasted image bytes so the transcript records a path', async () => {
    const staged = await stageAttachmentData('agent-1', PNG, 'image.png');
    expect(staged).toMatchObject({ kind: 'image', mimeType: 'image/png', pasted: true });
    const [block] = await resolveAttachments('agent-1', [staged.id], withImages);
    const saved = (block as { path: string }).path;
    expect(saved.startsWith(fs.realpathSync.native(attachmentsDir('agent-1')))).toBe(true);
    expect(fs.readFileSync(saved).equals(PNG)).toBe(true);
  });

  it('refuses pasted bytes that are not an image, and images over the base64-safe cap', async () => {
    await expect(stageAttachmentData('agent-1', Buffer.from('hello'))).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
    await expect(stageAttachmentData('agent-1', Buffer.concat([PNG, Buffer.alloc(CHAT_IMAGE_MAX_BYTES)]))).rejects.toThrow(/3.75 MB/);
    // 3.75 MB raw is 5 MB once base64-encoded, Claude's limit.
    expect(Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('deletes saved pasted images older than the retention window when saving a new one', async () => {
    const folder = attachmentsDir('agent-1');
    fs.mkdirSync(folder, { recursive: true });
    const old = path.join(folder, 'old.png');
    fs.writeFileSync(old, PNG);
    const past = (Date.now() - SAVED_ATTACHMENT_TTL_MS - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    await stageAttachmentData('agent-1', PNG);
    expect(fs.existsSync(old)).toBe(false);
  });
});

describe('resolveAttachments', () => {
  it('only takes images when the runtime reports images: true', async () => {
    const shot = await stageAttachmentPath('agent-1', file('shot.png', PNG));
    const pasted = await stageAttachmentData('agent-1', PNG);
    for (const caps of [noImages, undefined]) {
      expect(await resolveAttachments('agent-1', [shot.id], caps)).toEqual([{ type: 'file', path: expect.stringContaining('shot.png') }]);
      await expect(resolveAttachments('agent-1', [pasted.id], caps)).rejects.toThrow(/can't take images/);
    }
  });

  it('refuses unknown ids, another agent\'s ids and too many', async () => {
    const notes = await stageAttachmentPath('agent-1', file('notes.md', 'x'));
    await expect(resolveAttachments('agent-1', ['made-up'], withImages)).rejects.toThrow(/expired/);
    await expect(resolveAttachments('agent-2', [notes.id], withImages)).rejects.toThrow(/expired/);
    await expect(resolveAttachments('agent-1', Array.from({ length: 11 }, () => notes.id), withImages)).rejects.toThrow(/at most 10/);
  });
});
