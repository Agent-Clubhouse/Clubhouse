import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { searchFiles } from './search-service';

describe('search-service', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-test-'));

    // Create test files
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), [
      'const greeting = "hello world";',
      'function sayHello() {',
      '  console.log(greeting);',
      '}',
      'sayHello();',
    ].join('\n'));

    await fs.writeFile(path.join(tmpDir, 'readme.md'), [
      '# Hello Project',
      '',
      'This is a hello world project.',
      'It says hello to the world.',
    ].join('\n'));

    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'utils.ts'), [
      'export function upperCase(s: string): string {',
      '  return s.toUpperCase();',
      '}',
      '',
      'export function lowerCase(s: string): string {',
      '  return s.toLowerCase();',
      '}',
    ].join('\n'));

    // Create a file in a subdir that should be ignored
    await fs.mkdir(path.join(tmpDir, 'node_modules'));
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.js'), 'hello');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds matches across multiple files', async () => {
    const result = await searchFiles(tmpDir, 'hello');
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.results.length).toBeGreaterThan(0);

    // Should find matches in hello.ts and readme.md
    const filePaths = result.results.map(r => r.filePath);
    expect(filePaths.some(f => f.includes('hello.ts'))).toBe(true);
    expect(filePaths.some(f => f.includes('readme.md'))).toBe(true);

    // Should NOT include node_modules
    expect(filePaths.some(f => f.includes('node_modules'))).toBe(false);
  });

  it('returns empty results for no matches', async () => {
    const result = await searchFiles(tmpDir, 'zyxwvutsrqp_no_match');
    expect(result.totalMatches).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('returns empty results for empty query', async () => {
    const result = await searchFiles(tmpDir, '');
    expect(result.totalMatches).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('supports case-sensitive search', async () => {
    const insensitive = await searchFiles(tmpDir, 'Hello');
    const sensitive = await searchFiles(tmpDir, 'Hello', { caseSensitive: true });

    // Case-insensitive should find more or equal matches than case-sensitive
    expect(insensitive.totalMatches).toBeGreaterThanOrEqual(sensitive.totalMatches);
  });

  it('supports whole word matching', async () => {
    const allMatches = await searchFiles(tmpDir, 'Case');
    const wholeWord = await searchFiles(tmpDir, 'Case', { wholeWord: true });

    // "upperCase" and "lowerCase" contain "Case" but not as a whole word
    // wholeWord should find fewer or equal matches
    expect(wholeWord.totalMatches).toBeLessThanOrEqual(allMatches.totalMatches);
  });

  it('supports regex search', async () => {
    const result = await searchFiles(tmpDir, 'function\\s+\\w+', { regex: true });
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('respects maxResults limit', async () => {
    const result = await searchFiles(tmpDir, 'e', { maxResults: 2 });
    expect(result.totalMatches).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it('matches contain line numbers and content', async () => {
    const result = await searchFiles(tmpDir, 'greeting');
    expect(result.results.length).toBeGreaterThan(0);

    const helloFile = result.results.find(r => r.filePath.includes('hello.ts'));
    expect(helloFile).toBeDefined();
    expect(helloFile!.matches.length).toBeGreaterThan(0);

    const firstMatch = helloFile!.matches[0];
    expect(firstMatch.line).toBeGreaterThan(0);
    expect(firstMatch.column).toBeGreaterThan(0);
    expect(firstMatch.length).toBeGreaterThan(0);
    expect(firstMatch.lineContent).toContain('greeting');
  });

  it('supports include globs', async () => {
    const result = await searchFiles(tmpDir, 'hello', {
      includeGlobs: ['*.md'],
    });

    const filePaths = result.results.map(r => r.filePath);
    // Should only find in .md files
    for (const fp of filePaths) {
      expect(fp.endsWith('.md')).toBe(true);
    }
  });

  it('supports exclude globs', async () => {
    const result = await searchFiles(tmpDir, 'hello', {
      excludeGlobs: ['*.md'],
    });

    const filePaths = result.results.map(r => r.filePath);
    // Should not find in .md files
    for (const fp of filePaths) {
      expect(fp.endsWith('.md')).toBe(false);
    }
  });
});
