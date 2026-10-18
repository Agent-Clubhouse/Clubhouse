import { describe, expect, it } from 'vitest';
import { buildSha } from './build-info';

describe('buildSha', () => {
  it('accepts a full or short commit hash, normalised to lower case', () => {
    expect(buildSha('71b4bc9d')).toBe('71b4bc9d');
    expect(buildSha('9ED31211A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5\n')).toBe('9ed31211a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5');
  });

  it('is null for anything that is not a commit hash', () => {
    expect(buildSha(null)).toBeNull();
    expect(buildSha(undefined)).toBeNull();
    expect(buildSha('')).toBeNull();
    expect(buildSha('abc12')).toBeNull();
    expect(buildSha('71b4bc9d-dirty')).toBeNull();
    expect(buildSha('v0.42.0')).toBeNull();
  });

  it('is null unbundled, where the build constant is not defined', () => {
    expect(buildSha()).toBeNull();
  });
});
