import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalHandoffManifest, HANDOFF_MANIFEST_MAX_BYTES, HANDOFF_TRANSFER_DEFAULTS, HANDOFF_TRANSFER_MAX_BYTES,
  isSafeHandoffBranch, isSafeHandoffPath, parseHandoffManifest, validateHandoffBounds,
  type HandoffWorktreeManifest,
} from './handoff-manifest';

function fixture(): HandoffWorktreeManifest {
  return {
    v: 1, repo: { remote: 'https://example.com/example/project.git', base: 'a'.repeat(40), branch: 'main' },
    include: { tracked_changes: true, untracked: true, ignored: ['fixtures/**', 'models/*.bin'] },
    exclude: ['**/node_modules/**'],
    files: [{ path: 'src/example.ts', size: 10, sha256: 'b'.repeat(64), mode: '100644' }],
    deletions: ['src/deleted.ts'], total_bytes: 10, manifest_sha256: 'c'.repeat(64),
  };
}

describe('portable bounded handoff manifest', () => {
  it('canonicalizes property and collection ordering to one UTF-8 digest input', () => {
    const manifest = fixture();
    manifest.files.push({ path: 'a.txt', size: 0, sha256: 'd'.repeat(64), mode: '100755' });
    const reordered = {
      ...manifest, files: [...manifest.files].reverse(), include: { ...manifest.include, ignored: [...manifest.include.ignored].reverse() },
      repo: { branch: manifest.repo.branch, base: manifest.repo.base, remote: manifest.repo.remote }, manifest_sha256: 'e'.repeat(64),
    };
    const canonical = canonicalHandoffManifest(manifest);
    expect(canonical).toBe(canonicalHandoffManifest(reordered));
    expect(canonical).not.toContain('manifest_sha256');
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(createHash('sha256').update(canonicalHandoffManifest(reordered)).digest('hex'));
  });

  it.each([
    '../outside', '/absolute', 'C:/absolute', 'C:relative', '\\\\server\\share', 'a\\..\\outside', 'a//b', './a', 'a/../b',
    '.git/config', 'nested/.GiT/config', 'file:stream', 'trailing.', 'trailing ', 'a/\0b', 'a/\nb',
    'CON', 'con.txt', 'a/LPT1.log', 'a/COM9', 'a/../.env', 'git~1/config', '.git~2/config',
    'a/question?.txt', 'a/star*.txt', 'a/COM\u00b9.txt', 'a/quote".txt',
  ])('refuses traversal, internals and platform aliases: %s', (path) => {
    expect(isSafeHandoffPath(path)).toBe(false);
    expect(() => parseHandoffManifest({ ...fixture(), files: [{ ...fixture().files[0], path }] })).toThrow('Invalid handoff manifest.');
  });

  it.each(['--help', 'HEAD', '@', '../main', 'a..b', 'main.lock', '.hidden', 'a//b', 'a@{b', 'a[b', 'a?b', 'a:b'])('refuses unsafe branch metadata: %s', (branch) => {
    expect(isSafeHandoffBranch(branch)).toBe(false);
  });

  it('enforces exact total/per-file/file-count bounds, safe arithmetic and configuration limits', () => {
    const manifest = fixture();
    const bounds = { totalBytes: 10, perFileBytes: 10, maxFiles: 2 };
    expect(parseHandoffManifest(manifest, bounds).total_bytes).toBe(10);
    for (const invalid of [{ ...bounds, totalBytes: 9, perFileBytes: 9 }, { ...bounds, perFileBytes: 9 }, { ...bounds, maxFiles: 1 }]) {
      expect(() => parseHandoffManifest(manifest, invalid)).toThrow();
    }
    for (const invalid of [
      { ...bounds, totalBytes: Infinity }, { ...bounds, totalBytes: -1 }, { ...bounds, perFileBytes: 0 },
      { ...bounds, perFileBytes: 11 }, { ...bounds, maxFiles: 0 }, { ...bounds, maxFiles: 10_001 },
      { ...bounds, totalBytes: HANDOFF_TRANSFER_MAX_BYTES + 1 }, { ...bounds, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => validateHandoffBounds(invalid)).toThrow();
    expect(validateHandoffBounds(HANDOFF_TRANSFER_DEFAULTS)).toEqual(HANDOFF_TRANSFER_DEFAULTS);
  });

  it.each([
    { path: 'SRC/EXAMPLE.ts', size: 0, sha256: 'b'.repeat(64), mode: '100644' },
    { path: 'src/example.ts/nested', size: 0, sha256: 'b'.repeat(64), mode: '100644' },
  ])('rejects duplicate or file-directory-colliding portable paths', (extra) => {
    expect(() => parseHandoffManifest({ ...fixture(), files: [...fixture().files, extra] })).toThrow();
  });

  it('rejects Unicode normalization collisions and duplicate deletions', () => {
    const first = { path: 'caf\u00e9.txt', size: 0, sha256: 'b'.repeat(64), mode: '100644' };
    expect(() => parseHandoffManifest({ ...fixture(), files: [first, { ...first, path: 'cafe\u0301.txt' }], total_bytes: 0 })).toThrow();
    expect(() => parseHandoffManifest({ ...fixture(), deletions: ['src/deleted.ts', 'SRC/DELETED.ts'] })).toThrow();
    expect(() => parseHandoffManifest({ ...fixture(), deletions: ['src/example.ts'] })).toThrow();
  });

  it.each([
    (value: HandoffWorktreeManifest) => ({ ...value, total_bytes: 11 }),
    (value: HandoffWorktreeManifest) => ({ ...value, manifest_sha256: 'no' }),
    (value: HandoffWorktreeManifest) => ({ ...value, files: [{ ...value.files[0], mode: '120000' }] }),
    (value: HandoffWorktreeManifest) => ({ ...value, files: [{ ...value.files[0], sha256: 'f'.repeat(63) }] }),
    (value: HandoffWorktreeManifest) => ({ ...value, files: [{ ...value.files[0], size: 1.5 }] }),
    (value: HandoffWorktreeManifest) => ({ ...value, repo: { ...value.repo, remote: 'https://example:password@example.com/repo.git' } }),
    (value: HandoffWorktreeManifest) => ({ ...value, repo: { ...value.repo, remote: 'https://example.com/repo.git?token=example' } }),
    (value: HandoffWorktreeManifest) => ({ ...value, repo: { ...value.repo, remote: '/outside/local/repo' } }),
    (value: HandoffWorktreeManifest) => ({ ...value, include: { ...value.include, ignored: ['../outside/**'] } }),
    (value: HandoffWorktreeManifest) => ({ ...value, exclude: ['!allow-everything'] }),
    (value: HandoffWorktreeManifest) => ({ ...value, secret: 'must not persist' }),
  ])('fails closed on malformed or credential-bearing metadata', (corrupt) => {
    expect(() => parseHandoffManifest(corrupt(fixture()))).toThrow('Invalid handoff manifest.');
  });

  it('caps the complete serialized manifest independently of transfer byte counts', () => {
    const manifest = fixture();
    manifest.files = Array.from({ length: 3000 }, (_, index) => ({
      path: `${index}/${'a'.repeat(900)}`, size: 0, sha256: 'a'.repeat(64), mode: '100644',
    }));
    manifest.total_bytes = 0;
    expect(new TextEncoder().encode(JSON.stringify(manifest)).byteLength).toBeGreaterThan(HANDOFF_MANIFEST_MAX_BYTES);
    expect(() => parseHandoffManifest(manifest)).toThrow('too large');
  });

  it('rejects ill-formed UTF-16 paths before hashing or filesystem encoding, for files and deletions', () => {
    const manifest = fixture();
    expect(() => parseHandoffManifest({
      ...manifest, files: [
        { ...manifest.files[0], path: '\ud800.txt' }, { ...manifest.files[0], path: '\ud801.txt' },
      ], total_bytes: 20,
    })).toThrow('Invalid handoff manifest.');
    expect(() => parseHandoffManifest({ ...manifest, deletions: ['\udc00.txt'] })).toThrow('Invalid handoff manifest.');
    expect(isSafeHandoffPath('valid-\ud83d\ude00.txt')).toBe(true);
  });

  it.each(['.g\u200cit/config', '.git\ufeff/config', '\u200b.git/config', '.\u200c./outside'])('refuses HFS-ignorable internals/traversal aliases without rewriting %s', (path) => {
    expect(isSafeHandoffPath(path)).toBe(false);
    expect(() => parseHandoffManifest({ ...fixture(), files: [{ ...fixture().files[0], path }] })).toThrow('Invalid handoff manifest.');
  });
});
