import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => dir.path } }));

import { adoptIdentity, deleteLocalSalt, localSalt, peekLocalSalt } from './local-salt';

beforeEach(() => { dir.path = fs.mkdtempSync(path.join(os.tmpdir(), 'local-salt-')); });
afterEach(() => { fs.rmSync(dir.path, { recursive: true, force: true }); });

describe('local record salt (#2920)', () => {
  it('is made once, kept from run to run, holds no install id, and is private to the user', () => {
    expect(peekLocalSalt()).toBeUndefined();
    const first = localSalt();
    expect(first).toHaveLength(32);
    expect(localSalt().equals(first)).toBe(true);
    const file = path.join(dir.path, 'telemetry-local-salt.json');
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8'))).sort()).toEqual(['hashSalt', 'since']);
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

  it('is adopted by the first identity, and after a delete a later destination gets a fresh salt, never the old one', async () => {
    const saved: string[] = [];
    const save = async (id: { hashSalt: string }) => { saved.push(id.hashSalt); };
    const recorded = localSalt().toString('base64');
    const first = await adoptIdentity(save);
    expect(first.hashSalt).toBe(recorded);
    expect(saved).toEqual([recorded]);
    // The identity is now the only place it lives.
    expect(peekLocalSalt()).toBeUndefined();
    // "Delete local telemetry data": the identity and any local salt go, and recording restarts on a new one.
    deleteLocalSalt();
    const afterDelete = localSalt().toString('base64');
    expect(afterDelete).not.toBe(recorded);
    // A destination added later adopts the new salt, not the deleted one.
    const second = await adoptIdentity(save);
    expect(second.hashSalt).toBe(afterDelete);
    expect(second.hashSalt).not.toBe(first.hashSalt);
    expect(second.installId).not.toBe(first.installId);
  });

  it('keeps the salt file when saving the identity fails, so the next try adopts it again', async () => {
    const recorded = localSalt().toString('base64');
    await expect(adoptIdentity(async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(peekLocalSalt()).toBe(recorded);
    expect((await adoptIdentity(async () => {})).hashSalt).toBe(recorded);
  });

  it('gives the first identity a fresh salt when nothing was recorded', async () => {
    const identity = await adoptIdentity(async () => {});
    expect(Buffer.from(identity.hashSalt, 'base64')).toHaveLength(32);
    expect(peekLocalSalt()).toBeUndefined();
  });
});
