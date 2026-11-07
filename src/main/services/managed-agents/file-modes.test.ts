import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executableBits } from './file-modes';

/** Skill import reads real executable bits (#2894, D96). */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-modes-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('executableBits', () => {
  it.skipIf(process.platform === 'win32')('reads the mode, not the name: a script without the bit is not executable, a binary with it is', async () => {
    const script = path.join(dir, 'run.sh');
    const tool = path.join(dir, 'tool');
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(script, '#!/bin/sh\necho hi\n');
    fs.chmodSync(script, 0o644);
    fs.writeFileSync(tool, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
    fs.chmodSync(tool, 0o755);
    fs.writeFileSync(notes, '# notes');
    fs.chmodSync(notes, 0o700);
    expect(await executableBits([script, tool, notes])).toEqual([false, true, true]);
  });

  it.skipIf(process.platform === 'win32')('answers null for a folder, a link, a missing file or no path', async () => {
    const target = path.join(dir, 'target.sh');
    fs.writeFileSync(target, 'x');
    fs.chmodSync(target, 0o755);
    const link = path.join(dir, 'link.sh');
    fs.symlinkSync(target, link);
    expect(await executableBits([dir, link, path.join(dir, 'gone'), ''])).toEqual([null, null, null, null]);
  });

  it('answers null for every file on Windows, which has no executable bit', async () => {
    expect(await executableBits([path.join(dir, 'a'), path.join(dir, 'b')], 'win32')).toEqual([null, null]);
  });
});
