import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => dir.path } }));

import { deleteLocalSalt, localSalt, peekLocalSalt } from './local-salt';

beforeEach(() => { dir.path = fs.mkdtempSync(path.join(os.tmpdir(), 'local-salt-')); });
afterEach(() => { fs.rmSync(dir.path, { recursive: true, force: true }); });

describe('local record salt (#2920)', () => {
  it('is made once, kept from run to run, holds no install id, and is private to the user', () => {
    expect(peekLocalSalt()).toBeUndefined();
    const first = localSalt();
    expect(first).toHaveLength(32);
    expect(localSalt().equals(first)).toBe(true);
    const file = path.join(dir.path, 'telemetry-local-salt.json');
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')))).toEqual(['hashSalt']);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(peekLocalSalt()).toBe(first.toString('base64'));
  });

  it('is gone after a delete, and the next one is new', () => {
    const first = localSalt();
    deleteLocalSalt();
    expect(peekLocalSalt()).toBeUndefined();
    expect(localSalt().equals(first)).toBe(false);
    deleteLocalSalt();
    deleteLocalSalt();
  });

  it('ignores a saved salt of the wrong size', () => {
    fs.writeFileSync(path.join(dir.path, 'telemetry-local-salt.json'), JSON.stringify({ hashSalt: 'abc' }));
    expect(peekLocalSalt()).toBeUndefined();
    expect(localSalt()).toHaveLength(32);
  });
});
