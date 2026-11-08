import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** check-linux-glibc.sh (#3080) with a stub objdump that reports each file's glibc versions. */
const SCRIPT = path.join(__dirname, 'check-linux-glibc.sh');

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glibc-check-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A file whose stub objdump output names these glibc versions (none: a non-ELF file). */
function binary(rel: string, versions: string[]): void {
  const file = path.join(dir, 'out', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, versions.join(' '));
}

function check(max: string) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // objdump -T FILE: print each version the file names as a dynamic symbol line.
  fs.writeFileSync(path.join(bin, 'objdump'), '#!/bin/sh\nfor v in $(cat "$2"); do echo "0000 DF *UND* 0000 GLIBC_$v strlen"; done\n', { mode: 0o755 });
  return spawnSync('bash', [SCRIPT, max, path.join(dir, 'out')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
}

describe.skipIf(process.platform === 'win32')('check-linux-glibc.sh (#3080)', () => {
  it('passes when every node-pty binary needs the limit or older, by version order', () => {
    binary(path.join('node-pty', 'build', 'Release', 'pty.node'), ['2.2.5', '2.34', '2.17']);
    binary(path.join('node-pty', 'build', 'Release', 'spawn-helper'), ['2.36']);
    const r = check('2.36');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('pty.node needs glibc 2.34');
    expect(r.stdout).toContain('spawn-helper needs glibc 2.36');
  });

  it('fails when one needs newer, comparing 2.42 above 2.36 and 2.4 below it', () => {
    binary(path.join('node-pty', 'build', 'Release', 'pty.node'), ['2.42']);
    const r = check('2.36');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('needs glibc 2.42, newer than 2.36');
    fs.rmSync(path.join(dir, 'out'), { recursive: true });
    binary(path.join('node-pty', 'build', 'Release', 'pty.node'), ['2.4']);
    expect(check('2.36').status).toBe(0);
  });

  it('skips files with no glibc versions, and fails when no Linux binary is left', () => {
    binary(path.join('node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), []);
    const r = check('2.36');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('No Linux node-pty binary found');
  });

  it('checks the Linux binary even when a Windows prebuild is found first', () => {
    binary(path.join('node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), []);
    binary(path.join('node-pty', 'build', 'Release', 'pty.node'), ['2.34']);
    const r = check('2.36');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('pty.node needs glibc 2.34');
  });
});
