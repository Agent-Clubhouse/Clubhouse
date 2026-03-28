/**
 * SDK Hash Integrity Tests
 *
 * Verifies that:
 * 1. The compute-sdk-hash.mjs script works in verify/update/status modes
 * 2. Hash mismatches are detected when source files are modified
 * 3. All expected hash targets exist
 * 4. The v0.9 surface file compiles (type-checked by tsc, not this test)
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/compute-sdk-hash.mjs');
const HASHES_DIR = resolve(ROOT, 'src/shared/sdk-hashes');
const SURFACES_DIR = resolve(ROOT, 'src/shared/sdk-surfaces');
const LEGACY_SOURCE = resolve(ROOT, 'src/shared/plugin-types.ts');

function run(args: string): { output: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${SCRIPT} ${args}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    // Combine stdout + stderr since error messages go to stderr
    return { output: (e.stdout ?? '') + (e.stderr ?? ''), exitCode: e.status ?? 1 };
  }
}

describe('compute-sdk-hash.mjs', () => {
  describe('verify', () => {
    it('passes when all hashes are current', () => {
      const { exitCode, output } = run('verify');
      expect(exitCode).toBe(0);
      expect(output).toContain('All SDK surface hashes verified');
    });

    it('detects legacy hash mismatch when plugin-types.ts is modified', () => {
      const original = readFileSync(LEGACY_SOURCE, 'utf-8');
      try {
        writeFileSync(LEGACY_SOURCE, original + '\n// test modification\n');
        const { exitCode, output } = run('verify');
        expect(exitCode).toBe(1);
        expect(output).toContain('legacy');
        expect(output).toContain('hash mismatch');
      } finally {
        writeFileSync(LEGACY_SOURCE, original);
      }
    });

    it('detects v0.9 surface hash mismatch when surface file is modified', () => {
      const surfaceFile = resolve(SURFACES_DIR, 'v0.9.surface.ts');
      const original = readFileSync(surfaceFile, 'utf-8');
      try {
        writeFileSync(surfaceFile, original + '\n// test modification\n');
        const { exitCode, output } = run('verify');
        expect(exitCode).toBe(1);
        expect(output).toContain('v0.9');
        expect(output).toContain('hash mismatch');
      } finally {
        writeFileSync(surfaceFile, original);
      }
    });
  });

  describe('update', () => {
    it('updates a specific target hash', () => {
      const hashFile = resolve(HASHES_DIR, 'legacy.sha256');
      const originalHash = readFileSync(hashFile, 'utf-8');
      try {
        // Corrupt the hash
        writeFileSync(hashFile, 'bad_hash  src/shared/plugin-types.ts\n');
        // Verify should fail now
        expect(run('verify').exitCode).toBe(1);
        // Update should fix it
        const { exitCode } = run('update legacy');
        expect(exitCode).toBe(0);
        // Verify should pass again
        expect(run('verify').exitCode).toBe(0);
      } finally {
        writeFileSync(hashFile, originalHash);
      }
    });

    it('updates all targets with "all"', () => {
      const { exitCode, output } = run('update all');
      expect(exitCode).toBe(0);
      expect(output).toContain('legacy');
      expect(output).toContain('v0.9');
    });

    it('fails for unknown target', () => {
      const { exitCode } = run('update v99.99');
      expect(exitCode).toBe(1);
    });
  });

  describe('status', () => {
    it('shows status for all targets', () => {
      const { exitCode, output } = run('status');
      expect(exitCode).toBe(0);
      expect(output).toContain('legacy');
      expect(output).toContain('v0.9');
    });
  });

  describe('hash targets', () => {
    it('has a legacy hash file', () => {
      expect(existsSync(resolve(HASHES_DIR, 'legacy.sha256'))).toBe(true);
    });

    it('has a v0.9 hash file', () => {
      expect(existsSync(resolve(HASHES_DIR, 'v0.9.sha256'))).toBe(true);
    });

    it('has a v0.9 surface file', () => {
      expect(existsSync(resolve(SURFACES_DIR, 'v0.9.surface.ts'))).toBe(true);
    });
  });
});
