import * as path from 'path';
import { expect, it } from 'vitest';
import { handoffGitFile, handoffGitLocation } from './handoff-git-paths';

const paths = path.win32;
const windows = { paths, windows: true };
const quarantine = 'quarantine-00000000-0000-4000-8000-000000000000';

it.each([150, 170, 220, 300])('selects a bounded ancestor for a Windows snapshot root of %i characters', (length) => {
  let root = 'C:\\handoffs';
  while (root.length + 41 < length) root = paths.join(root, 'x'.repeat(40));
  root = paths.join(root, 'y'.repeat(length - root.length - 1));
  expect(root.length).toBe(length);
  const bare = paths.join(root, quarantine, 'repo');
  const location = handoffGitLocation(bare, windows)!;
  expect(location).not.toBeNull();
  expect(location.cwd.length).toBeLessThan(260);
  expect(Buffer.byteLength(location.gitDir, 'utf8')).toBeLessThan(220);
  expect(paths.isAbsolute(location.gitDir)).toBe(false);
  expect(paths.resolve(location.cwd, location.gitDir)).toBe(bare);
  if (length >= 220) expect(bare.length).toBeGreaterThan(260);
});

it('keeps the launch cwd on the staging volume and imports a bundle across receiver drives', () => {
  const bare = paths.join('C:\\handoffs', 'x'.repeat(200), quarantine, 'repo');
  const location = handoffGitLocation(bare, windows)!;
  const bundle = paths.join(paths.dirname(bare), 'verified.bundle');
  const receiver = 'D:\\projects\\receiver';
  expect(paths.parse(location.cwd).root).toBe('C:\\');
  expect(location.cwd.length).toBeLessThan(260);
  expect(Buffer.byteLength(location.gitDir)).toBeLessThan(220);
  const localBundle = handoffGitFile(location.cwd, bundle, paths);
  expect(paths.isAbsolute(localBundle)).toBe(false);
  expect(paths.resolve(location.cwd, localBundle)).toBe(bundle);
  expect(handoffGitFile(receiver, bundle, paths)).toBe(bundle);
});

it('rejects layouts with no ancestor satisfying both limits, counting Git directory bytes', () => {
  const prefix = paths.join('C:\\', 'x'.repeat(200));
  const ascii = paths.join(prefix, 'e'.repeat(100), quarantine, 'repo');
  expect(handoffGitLocation(ascii, windows)).not.toBeNull();
  const unicode = paths.join(prefix, 'é'.repeat(100), quarantine, 'repo');
  expect(paths.relative(prefix, unicode).length).toBeLessThan(220);
  expect(Buffer.byteLength(paths.relative(prefix, unicode))).toBeGreaterThanOrEqual(220);
  expect(handoffGitLocation(unicode, windows)).toBeNull();
});
