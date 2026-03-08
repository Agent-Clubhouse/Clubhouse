import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { extractBaseDir } from './file-watch-service';

describe('extractBaseDir', () => {
  it('extracts base directory from POSIX glob with **', () => {
    const result = extractBaseDir('/home/user/project/src/**/*.ts');
    expect(result).toBe(path.normalize('/home/user/project/src'));
  });

  it('extracts base directory from POSIX glob with single *', () => {
    const result = extractBaseDir('/home/user/project/*.ts');
    expect(result).toBe(path.normalize('/home/user/project'));
  });

  it('returns normalized path with no wildcard', () => {
    const result = extractBaseDir('/home/user/project/src');
    expect(result).toBe(path.normalize('/home/user/project/src'));
  });

  it('handles glob with ? wildcard', () => {
    const result = extractBaseDir('/home/user/project/src/file?.ts');
    expect(result).toBe(path.normalize('/home/user/project/src'));
  });

  it('handles glob with { brace pattern', () => {
    const result = extractBaseDir('/home/user/project/src/{a,b}');
    expect(result).toBe(path.normalize('/home/user/project/src'));
  });

  it('handles glob with [ bracket pattern', () => {
    const result = extractBaseDir('/home/user/project/src/[abc].ts');
    expect(result).toBe(path.normalize('/home/user/project/src'));
  });

  it('returns "." when glob starts with wildcard', () => {
    const result = extractBaseDir('**/*.ts');
    expect(result).toBe('.');
  });

  it('handles Windows-style backslash separators', () => {
    // On Windows path.sep is '\\' so backslash-separated paths split correctly.
    // On POSIX path.sep is '/' so backslashes are literal filename characters;
    // the entire string is a single segment containing wildcards → falls back to '.'.
    const result = extractBaseDir('C:\\Users\\me\\project\\src\\**\\*.ts');
    if (path.sep === '\\') {
      expect(result).toBe('C:\\Users\\me\\project\\src');
    } else {
      expect(result).toBe('.');
    }
  });

  it('handles mixed separators', () => {
    // path.normalize converts forward slashes to platform separators,
    // so mixed paths are correctly handled on every platform.
    const result = extractBaseDir('C:\\Users\\me/project/src/**/*.ts');
    if (path.sep === '\\') {
      expect(result).toBe('C:\\Users\\me\\project\\src');
    } else {
      // On POSIX, normalize keeps '/' and '\' as-is in the relevant segments
      expect(result).toBe(path.normalize('C:\\Users\\me/project/src'));
    }
  });
});
