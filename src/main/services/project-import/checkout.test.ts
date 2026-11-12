import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkoutFingerprint, CHECKOUT_MAX_BYTES, CHECKOUT_MAX_ENTRIES, CHECKOUT_MAX_DEPTH, CHECKOUT_INSPECTION_MS,
} from './checkout';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'import-checkout-proof-')));
let index = 0;
const folder = () => {
  const directory = path.join(root, `case-${++index}`);
  fs.mkdirSync(directory);
  return directory;
};
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('bounded whole-checkout proof across authority awaits', () => {
  it('accepts exactly 64 MiB and refuses one more byte without modifying the checkout', () => {
    const directory = folder();
    const file = path.join(directory, 'content');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, CHECKOUT_MAX_BYTES);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      expect(() => checkoutFingerprint(directory)).not.toThrow();
      fs.truncateSync(file, CHECKOUT_MAX_BYTES + 1);
      expect(() => checkoutFingerprint(directory)).toThrow(expect.objectContaining({ reason: 'checkout_inspection_limit' }));
      expect(fs.statSync(file).size).toBe(CHECKOUT_MAX_BYTES + 1);
    } finally { clock.mockRestore(); }
  });

  it('accepts exactly 20,000 entries and refuses another entry', () => {
    const directory = folder();
    for (let index = 0; index < CHECKOUT_MAX_ENTRIES; index++) fs.writeFileSync(path.join(directory, String(index)), '');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      expect(() => checkoutFingerprint(directory)).not.toThrow();
      fs.writeFileSync(path.join(directory, 'one-more'), '');
      expect(() => checkoutFingerprint(directory)).toThrow(expect.objectContaining({ reason: 'checkout_inspection_limit' }));
    } finally { clock.mockRestore(); }
  });

  it('accepts depth 128 and refuses another component', () => {
    const directory = folder();
    const deepest = path.join(directory, ...Array<string>(CHECKOUT_MAX_DEPTH).fill('d'));
    fs.mkdirSync(deepest, { recursive: true });
    expect(() => checkoutFingerprint(directory)).not.toThrow();
    fs.mkdirSync(path.join(deepest, 'one-more'));
    expect(() => checkoutFingerprint(directory)).toThrow(expect.objectContaining({ reason: 'checkout_inspection_limit' }));
  });

  it('refuses inspection past its elapsed-time budget between filesystem operations', () => {
    const directory = folder();
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(CHECKOUT_INSPECTION_MS + 1);
    try {
      expect(() => checkoutFingerprint(directory)).toThrow(expect.objectContaining({ reason: 'checkout_inspection_limit' }));
    } finally { clock.mockRestore(); }
  });

  it('detects changed bytes even when size and mtime are restored, and never follows links or app runtime aliases', () => {
    const directory = folder();
    const file = path.join(directory, 'file');
    fs.writeFileSync(file, 'original');
    const stat = fs.statSync(file);
    const before = checkoutFingerprint(directory);
    fs.writeFileSync(file, 'replaced');
    fs.utimesSync(file, stat.atime, stat.mtime);
    expect(checkoutFingerprint(directory)).not.toBe(before);
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(directory, 'link'));
    expect(() => checkoutFingerprint(directory)).toThrow(expect.objectContaining({ reason: 'checkout_changed' }));
    fs.unlinkSync(path.join(directory, 'link'));
    fs.mkdirSync(path.join(directory, '.Clubhouse-Dev.'));
    expect(() => checkoutFingerprint(directory)).toThrow(expect.objectContaining({ reason: 'repository_app_state' }));
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });
});
