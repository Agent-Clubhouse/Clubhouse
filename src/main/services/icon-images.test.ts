import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { CHAT_MEDIA_MAX_PIXELS } from '../../shared/chat';
import { ICON_SERVED_MAX_BYTES } from '../../shared/icon-limits';
import { jpegOrientation, readIconImage, resizeIcon } from './icon-images';

const native = vi.hoisted(() => ({ createFromBuffer: vi.fn(), createFromBitmap: vi.fn(), createThumbnailFromPath: undefined as unknown }));
vi.mock('electron', () => ({ nativeImage: native }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

/** A PNG header giving the size, then padding. */
function png(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([header, size, Buffer.alloc(padding)]);
}

function image(width: number, height: number, output = 'png-output') {
  const resized = { toPNG: () => Buffer.from(output) };
  const resize = vi.fn(() => resized);
  return { isEmpty: () => false, getSize: () => ({ width, height }), resize, toPNG: () => Buffer.from(`unscaled-${output}`) };
}

const THUMBNAIL = png(128, 128);

function thumbnailOf(width: number, height: number) {
  return { isEmpty: () => false, getSize: () => ({ width, height }), resize: () => ({ toPNG: () => THUMBNAIL }), toPNG: () => THUMBNAIL };
}

describe('resizeIcon', () => {
  beforeEach(() => {
    native.createFromBuffer.mockReset();
    native.createThumbnailFromPath = undefined;
  });

  it('fits the longer side to the box and keeps the shape', async () => {
    const decoded = image(4000, 1000);
    native.createFromBuffer.mockReturnValue(decoded);
    expect((await resizeIcon(png(4000, 1000), '/x.png', 128))?.toString()).toBe('png-output');
    expect(decoded.resize).toHaveBeenCalledWith({ width: 128, height: 32, quality: 'good' });
  });

  it('never scales up, and keeps a side at least one pixel', async () => {
    const small = image(16, 16);
    native.createFromBuffer.mockReturnValue(small);
    expect((await resizeIcon(png(16, 16), '/x.png', 128))?.toString()).toBe('unscaled-png-output');
    expect(small.resize).not.toHaveBeenCalled();

    const thin = image(5000, 2);
    native.createFromBuffer.mockReturnValue(thin);
    await resizeIcon(png(5000, 2), '/x.png', 128);
    expect(thin.resize).toHaveBeenCalledWith({ width: 128, height: 1, quality: 'good' });
  });

  it('does not decode an image claiming too many pixels', async () => {
    const side = Math.ceil(Math.sqrt(CHAT_MEDIA_MAX_PIXELS)) + 1;
    expect(await resizeIcon(png(side, side), '/x.png', 128)).toBeNull();
    expect(native.createFromBuffer).not.toHaveBeenCalled();
  });

  it('returns null for what nativeImage can\'t decode', async () => {
    native.createFromBuffer.mockReturnValue({ isEmpty: () => true });
    expect(await resizeIcon(png(10, 10), '/x.png', 128)).toBeNull();
    native.createFromBuffer.mockImplementation(() => { throw new Error('decode failed'); });
    expect(await resizeIcon(png(10, 10), '/x.png', 128)).toBeNull();
  });

  it('uses the system thumbnailer for GIF, WebP and SVG, and has no answer without one', async () => {
    const gif = Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1');
    expect(await resizeIcon(gif, '/x.gif', 128)).toBeNull();

    native.createThumbnailFromPath = vi.fn(async () => image(128, 128));
    expect((await resizeIcon(gif, '/x.gif', 128))?.toString()).toBe('unscaled-png-output');
    expect(native.createThumbnailFromPath).toHaveBeenCalledWith('/x.gif', { width: 128, height: 128 });
    expect(native.createFromBuffer).not.toHaveBeenCalled();

    native.createThumbnailFromPath = vi.fn(async () => { throw new Error('unsupported'); });
    expect(await resizeIcon(gif, '/x.gif', 128)).toBeNull();
  });

  it('gives up on a thumbnailer that never answers', async () => {
    vi.useFakeTimers();
    try {
      native.createThumbnailFromPath = vi.fn(() => new Promise(() => {}));
      const pending = resizeIcon(Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1'), '/x.gif', 128);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A JPEG start, then an EXIF block giving the orientation. */
function exifJpeg(orientation: number, littleEndian = false): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
  const u16 = (at: number, v: number) => (littleEndian ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const u32 = (at: number, v: number) => (littleEndian ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  u16(2, 42);
  u32(4, 8);
  u16(8, 1);
  u16(10, 0x0112);
  u16(12, 3);
  u32(14, 1);
  u16(18, orientation);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, payload, Buffer.from([0xff, 0xda, 0, 2])]);
}

describe('jpegOrientation', () => {
  it('reads it in either byte order, and is 1 without one', () => {
    expect(jpegOrientation(exifJpeg(6, true))).toBe(6);
    expect(jpegOrientation(exifJpeg(8, false))).toBe(8);
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(jpegOrientation(Buffer.from([0xff, 0xd8]))).toBe(1);
  });

  it('survives a truncated EXIF block', () => {
    expect(jpegOrientation(exifJpeg(6, true).subarray(0, 20))).toBe(1);
  });
});

describe('orientation when resizing', () => {
  beforeEach(() => {
    native.createFromBuffer.mockReset();
    native.createFromBitmap.mockReset();
  });

  /** A 2 by 1 image, pixels A then B, one byte standing for each. */
  function twoPixels() {
    const bitmap = Buffer.from([65, 0, 0, 0, 66, 0, 0, 0]);
    return { isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toBitmap: () => bitmap, toPNG: () => Buffer.from('sideways') };
  }

  it.each([
    [6, { width: 1, height: 2 }, [65, 66]],
    [8, { width: 1, height: 2 }, [66, 65]],
    [3, { width: 2, height: 1 }, [66, 65]],
    [2, { width: 2, height: 1 }, [66, 65]],
  ])('turns an orientation %i JPEG upright', async (orientation, size, firsts) => {
    native.createFromBuffer.mockReturnValue(twoPixels());
    native.createFromBitmap.mockImplementation((bitmap: Buffer, options: unknown) => {
      expect(options).toEqual(size);
      expect([bitmap[0], bitmap[4]]).toEqual(firsts);
      return { toPNG: () => Buffer.from('upright') };
    });
    expect((await resizeIcon(exifJpeg(orientation, true), '/x.jpg', 128))?.toString()).toBe('upright');
  });

  it('leaves an image with no orientation alone', async () => {
    native.createFromBuffer.mockReturnValue(twoPixels());
    expect((await resizeIcon(exifJpeg(1, true), '/x.jpg', 128))?.toString()).toBe('sideways');
    expect(native.createFromBitmap).not.toHaveBeenCalled();
  });
});

describe('readIconImage', () => {
  let dir: string;

  beforeEach(() => {
    native.createFromBuffer.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-images-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is null, not an error, for a missing file', async () => {
    expect(await readIconImage(path.join(dir, 'gone.png'))).toBeNull();
  });

  it('makes concurrent requests share one decode', async () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, png(2000, 2000, 100 * 1024));
    native.createFromBuffer.mockReturnValue(thumbnailOf(2000, 2000));
    const results = await Promise.all([readIconImage(file), readIconImage(file), readIconImage(file)]);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toEqual({
      dataUrl: `data:image/png;base64,${THUMBNAIL.toString('base64')}`,
      version: createHash('sha256').update(THUMBNAIL).digest('hex'),
      type: 'image/png', bytes: THUMBNAIL.length, width: 128, height: 128,
    });
    expect(native.createFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('sends a small file as it is only within the pixel cap', async () => {
    native.createFromBuffer.mockReturnValue(thumbnailOf(4000, 4000));
    const within = path.join(dir, 'within.png');
    fs.writeFileSync(within, png(256, 256));
    expect((await readIconImage(within))?.dataUrl).toBe(`data:image/png;base64,${png(256, 256).toString('base64')}`);
    expect(native.createFromBuffer).not.toHaveBeenCalled();

    // A few bytes can be a huge image, and a phone decodes all of it.
    const beyond = path.join(dir, 'beyond.png');
    fs.writeFileSync(beyond, png(4000, 4000));
    expect((await readIconImage(beyond))?.dataUrl).toBe(`data:image/png;base64,${THUMBNAIL.toString('base64')}`);
  });

  it('leaves out a small GIF over the pixel cap that can\'t be resized', async () => {
    native.createThumbnailFromPath = undefined;
    const file = path.join(dir, 'wide.gif');
    fs.writeFileSync(file, Buffer.from('GIF89a\xe8\x03\xe8\x03', 'latin1'));
    expect(await readIconImage(file)).toBeNull();
  });

  it('takes the type and size from the bytes, whatever the file is called', async () => {
    const file = path.join(dir, 'really-a-png.jpg');
    fs.writeFileSync(file, png(64, 32));
    expect(await readIconImage(file)).toMatchObject({ type: 'image/png', width: 64, height: 32 });
  });

  it('leaves out a result that breaks a guarantee, rather than sending it', async () => {
    const tooManyBytes = path.join(dir, 'noise.png');
    fs.writeFileSync(tooManyBytes, png(2000, 2000, 100 * 1024));
    const huge = png(128, 128, ICON_SERVED_MAX_BYTES);
    native.createFromBuffer.mockReturnValue({ ...thumbnailOf(2000, 2000), resize: () => ({ toPNG: () => huge }) });
    expect(await readIconImage(tooManyBytes)).toBeNull();

    const tooManyPixels = path.join(dir, 'big-thumbnailer.png');
    fs.writeFileSync(tooManyPixels, png(2000, 2000, 100 * 1024));
    native.createFromBuffer.mockReturnValue({ ...thumbnailOf(2000, 2000), resize: () => ({ toPNG: () => png(512, 512) }) });
    expect(await readIconImage(tooManyPixels)).toBeNull();
  });

  it('remembers an icon that can\'t be resized rather than trying on every snapshot', async () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, png(2000, 2000, 100 * 1024));
    native.createFromBuffer.mockReturnValue({ isEmpty: () => true });
    expect(await readIconImage(file)).toBeNull();
    expect(await readIconImage(file)).toBeNull();
    expect(native.createFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('leaves the user\'s file as it is', async () => {
    const file = path.join(dir, 'a.png');
    const bytes = png(2000, 2000, 100 * 1024);
    fs.writeFileSync(file, bytes);
    native.createFromBuffer.mockReturnValue(thumbnailOf(2000, 2000));
    await readIconImage(file);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });
});
